import 'reflect-metadata';
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { AiConfig, AI_PROVIDER_SETTINGS } from '../../src/modules/ai/ai.config';
import { normalizeAiError } from '../../src/modules/ai/ai.errors';
import { OpenAiProvider } from '../../src/modules/ai/providers/openai-provider.service';
import { GeminiProvider } from '../../src/modules/ai/providers/gemini-provider.service';
import { GroqProvider } from '../../src/modules/ai/providers/groq-provider.service';
import { AiProviderResolver } from '../../src/modules/ai/providers/ai-provider-resolver.service';
import { AiProvider } from '../../src/modules/ai/providers/ai-provider.interface';
import { DATASET_VERSION, DISH_REVIEW_RUBRIC } from './dataset.v1';
import {
  diagnosticSanitizer,
  caseDiagnostic,
  evaluationFailure,
  evaluationFailureCategory,
  installHttpDiagnostics,
} from './live-diagnostics';
import {
  candidate,
  evaluationCases,
  evaluationHarness,
  offlineConfig,
} from './harness';

async function main() {
  const live = process.argv.includes('--live');
  const smoke = process.argv.includes('--smoke');
  const diagnostics = process.argv.includes('--diagnostics');
  if (
    diagnostics &&
    (!live || !['development', 'test'].includes(process.env.NODE_ENV ?? ''))
  )
    throw new Error('Development live diagnostics only');
  const selectedIds = process.argv
    .find((arg) => arg.startsWith('--cases='))
    ?.slice(8)
    .split(',');
  const config = live ? new AiConfig(new ConfigService()) : offlineConfig();
  const metadata = config.metadata();
  const intervalMs = Number(
    process.argv.find((arg) => arg.startsWith('--interval-ms='))?.slice(14) ??
      (live && smoke && metadata.provider === 'gemini' ? '30000' : '0'),
  );
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60000)
    throw new Error('Invalid interval');
  const seen = new Set<string>();
  const smokeCases = smoke
    ? evaluationCases.filter((entry) => {
        if (entry.id === 'review-summary-grounding') return true;
        if (seen.has(entry.feature)) return false;
        seen.add(entry.feature);
        return true;
      })
    : evaluationCases;
  const cases = selectedIds
    ? smokeCases.filter((entry) => selectedIds.includes(entry.id))
    : smokeCases;
  if (
    !cases.length ||
    selectedIds?.some((id) => !cases.some((entry) => entry.id === id))
  )
    throw new Error('Unknown evaluation case');
  const report: Record<string, unknown> = {
    datasetVersion: DATASET_VERSION,
    evaluatorVersion: 'ai-release-evaluator-v4',
    generatedAt: new Date().toISOString(),
    mode: live ? 'live-provider-synthetic-repositories' : 'fixture-replay',
    scope: selectedIds
      ? 'selected cases only'
      : smoke
        ? 'six representative cases / five features'
        : 'full golden corpus',
    ...metadata,
    selectedCaseIds: cases.map((entry) => entry.id),
    intervalMs,
    liveProvider: 'NOT VERIFIED',
    repository: 'synthetic doubles; no Mongo writes',
    dishHumanReview: 'NOT VERIFIED',
    dishRubric: DISH_REVIEW_RUBRIC,
  };
  const save = () => {
    const folder = join(__dirname, '../../../docs/evaluation');
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(
        folder,
        live
          ? metadata.provider === 'gemini' || metadata.provider === 'groq'
            ? `${metadata.provider}-${smoke ? 'smoke' : 'live'}${selectedIds ? '-selected' : ''}.json`
            : 'phase24-live.json'
          : smoke
            ? 'ai-smoke-replay.json'
            : 'phase24-golden.json',
      ),
      JSON.stringify(report, null, 2) + '\n',
    );
  };
  const credential =
    metadata.provider === 'unknown'
      ? undefined
      : process.env[AI_PROVIDER_SETTINGS[metadata.provider].apiKey];
  if (live && (!credential?.trim() || credential.trim().startsWith('<'))) {
    report.reason = 'credential unavailable';
    report.features = [...new Set(evaluationCases.map((c) => c.feature))].map(
      (feature) => ({ feature, status: 'NOT VERIFIED' }),
    );
    save();
    console.log(
      'Live provider: NOT VERIFIED — credential unavailable (all five features; no network/DB access)',
    );
    process.exitCode = 1;
    return;
  }
  try {
    const operationalConfig = config.requireEnabled();
    report.timeoutMs = operationalConfig.timeoutMs;
    report.maxRetries = operationalConfig.maxRetries;
  } catch (e) {
    report.reason = normalizeAiError(e).code;
    save();
    console.log('Live provider: NOT VERIFIED — configuration unavailable');
    process.exitCode = 1;
    return;
  }
  const rows: Record<string, unknown>[] = [];
  const sanitize = diagnosticSanitizer();
  for (const entry of cases) {
    if (live && rows.length && intervalMs) {
      console.log(
        `Waiting ${intervalMs} ms before ${entry.id} (live evaluation pacing)`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
    const events: unknown[] = [];
    const restore = diagnostics
      ? installHttpDiagnostics(events, sanitize)
      : () => undefined;
    const selectedProvider: AiProvider = live
      ? new AiProviderResolver(
          config,
          new OpenAiProvider(config),
          new GeminiProvider(config),
          new GroqProvider(config),
        )
      : {
          generateStructured: (req) =>
            Promise.resolve(
              req.schemaName.includes('answer') ||
                req.schemaName === 'review_summary_v1'
                ? candidate(req)
                : { output: entry.output },
            ),
        };
    const provider: AiProvider = diagnostics
      ? {
          generateStructured: async (req) => {
            // Harness-generated JSON only; never persist system prompts or headers.
            const input: unknown = JSON.parse(req.input);
            events.push(sanitize({ schemaName: req.schemaName, input }));
            const response = await selectedProvider.generateStructured(req);
            events.push(
              sanitize({ schemaName: req.schemaName, output: response.output }),
            );
            return response;
          },
        }
      : selectedProvider;
    const h = evaluationHarness(provider, config);
    const started = performance.now();
    let status = 'PASS',
      errorCode: string | undefined,
      assertionMessage: string | undefined;
    try {
      await entry.run(h);
      // A live smoke cannot pass solely because the feature supplied a fallback.
      if (
        live &&
        (!h.audits.length || h.audits.some((audit) => !audit.success))
      ) {
        status = 'FAIL';
        errorCode =
          h.audits.find((audit) => !audit.success)?.errorCode ??
          'NO_PROVIDER_EVIDENCE';
      }
    } catch (e) {
      status = 'FAIL';
      errorCode = evaluationFailure(e, h.audits);
      if (
        errorCode === 'GOLDEN_MISMATCH' &&
        e instanceof Error &&
        e.name === 'AssertionError'
      )
        assertionMessage = e.message;
    } finally {
      restore();
    }
    const comparison = diagnostics
      ? caseDiagnostic(
          entry.id,
          metadata.provider,
          entry.expected,
          events,
          h.audits,
          errorCode,
          assertionMessage,
          sanitize,
        )
      : undefined;
    rows.push({
      id: entry.id,
      feature: entry.feature,
      status,
      errorCode,
      failureCategory: evaluationFailureCategory(errorCode),
      latencyMs: Math.round(performance.now() - started),
      stages: h.audits,
      ...(diagnostics ? { diagnostics: events, comparison } : {}),
    });
    console.log(`${status} ${entry.id}`);
    if (comparison) console.log(comparison.formatted);
  }
  report.cases = rows;
  report.passed = rows.filter((r) => r.status === 'PASS').length;
  report.failed = rows.filter((r) => r.status === 'FAIL').length;
  report.liveProvider =
    live && !report.failed
      ? 'VERIFIED (automated checks only; Dish prose needs human review)'
      : 'NOT VERIFIED';
  save();
  console.log(
    JSON.stringify({
      mode: report.mode,
      passed: report.passed,
      failed: report.failed,
      liveProvider: report.liveProvider,
    }),
  );
  if (report.failed) process.exitCode = 1;
}
void main().catch(() => {
  console.error('EVALUATION_FAILED (details suppressed)');
  process.exitCode = 1;
});
