import 'reflect-metadata';
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { AiConfig } from '../../src/modules/ai/ai.config';
import { normalizeAiError } from '../../src/modules/ai/ai.errors';
import { DISH_MODIFIERS } from '../../src/modules/dish/dish-metadata';
import { ORDER_NOTE_PROMPT } from '../../src/modules/ai/prompts/order-note.prompt';
import { GroqProvider } from '../../src/modules/ai/providers/groq-provider.service';
import { evaluationHarness } from './harness';
import { diagnosticSanitizer } from './live-diagnostics';

// Synthetic notes only; real Groq + orchestrator + service, no database writes.
const cases = [
  ['không cay cho trẻ em ăn', 'NO_SPICE', 'Không cay; dành cho trẻ em'],
  ['bé ăn không cay', 'NO_SPICE', 'Không cay; dành cho trẻ em'],
  ['cho trẻ em, đừng cay', 'NO_SPICE', 'Không cay; dành cho trẻ em'],
  ['không cay', 'NO_SPICE', 'Không cay'],
  ['ít cay cho bé', 'LESS_SPICY', 'Ít cay; dành cho trẻ em'],
] as const;

async function main() {
  const baseline = process.argv.includes('--baseline');
  const config = new AiConfig(
    new ConfigService({ ...process.env, AI_PROVIDER: 'groq' }),
  );
  config.requireEnabled();
  const provider = new GroqProvider(config);
  const sanitize = diagnosticSanitizer();
  const rows: unknown[] = [];
  let failures = 0;
  for (const [note, tag, summary] of cases) {
    for (const supported of [false, true]) {
      // Stay below shared free-tier request/token limits during live diagnostics.
      if (rows.length)
        await new Promise((resolve) => setTimeout(resolve, 12000));
      const outputs: unknown[] = [];
      const h = evaluationHarness(
        {
          generateStructured: async (request) => {
            const result = await provider.generateStructured(request);
            outputs.push(result.output);
            return result;
          },
        },
        config,
      );
      const available = supported ? [...DISH_MODIFIERS] : [];
      h.catalog[0].availableModifiers = available;
      let actual: unknown;
      let errorCode: string | undefined;
      try {
        const response = await h.note.analyze({
          note,
          sessionId: h.sessionId,
          tableId: h.tableId,
          dishId: h.catalog[0]._id.toString(),
        });
        actual = {
          result: response.result,
          warnings: response.warnings,
          fallbackUsed: response.fallbackUsed,
        };
        if (!baseline) {
          assert.deepEqual(outputs.at(-1), {
            modifierTags: [tag],
            forChildren: note !== 'không cay',
            allergyMentioned: false,
            needsStaffReview: false,
          });
          assert.deepEqual(response.result, {
            summary,
            modifierTags: supported ? [tag] : [],
            allergyMentioned: false,
          });
          assert.equal(response.fallbackUsed, false);
          assert.equal(response.warnings.length, supported ? 0 : 1);
          if (!supported) {
            assert.ok(response.warnings[0].includes(tag));
            assert.ok(
              response.warnings[0].includes('xác minh khả năng đáp ứng'),
            );
          }
          assert.ok(
            h.audits.length && h.audits.every((audit) => audit.success),
          );
        }
      } catch (error) {
        errorCode =
          error instanceof Error && error.name === 'AssertionError'
            ? 'GOLDEN_MISMATCH'
            : normalizeAiError(error).code;
        failures++;
      }
      const row = sanitize({
        note,
        availableModifiers: available,
        actualProviderOutput: outputs,
        actual,
        errorCode,
        audits: h.audits,
      });
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  const folder = join(__dirname, '../../../docs/evaluation');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, `order-note-groq-${baseline ? 'before' : 'after'}.json`),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ...config.metadata(),
        promptVersion: ORDER_NOTE_PROMPT.promptVersion,
        mode: 'live-groq-synthetic-repositories',
        baseline,
        failures,
        rows,
      },
      null,
      2,
    ) + '\n',
  );
  if (failures) process.exitCode = 1;
}
void main().catch((error: unknown) => {
  console.error(normalizeAiError(error).code);
  process.exitCode = 1;
});
