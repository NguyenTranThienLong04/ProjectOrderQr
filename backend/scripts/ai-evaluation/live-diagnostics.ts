import type { AiAuditEntry } from '../../src/modules/ai/ai-audit.service';
import { normalizeAiError } from '../../src/modules/ai/ai.errors';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Development evaluator only. Never imported by production services/audit. */
export function diagnosticSanitizer(env: NodeJS.ProcessEnv = process.env) {
  const secrets = Object.entries(env)
    .filter(
      ([key, value]) =>
        /KEY|SECRET|TOKEN|PASSWORD|URI|URL/i.test(key) &&
        value &&
        value.length >= 4,
    )
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length);
  const scrub = (text: string) => {
    let clean = text;
    for (const secret of secrets)
      clean = clean.split(secret).join('[REDACTED]');
    return clean
      .replace(
        /AIza[\w-]{20,}|sk-[\w-]{12,}|gsk_[\w-]{12,}|eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
        '[REDACTED]',
      )
      .replace(/(?:https?|mongodb(?:\+srv)?):\/\/\S+/gi, '[URL_REDACTED]')
      .slice(0, 4000);
  };
  const sanitize = (value: unknown, depth = 0): unknown => {
    if (depth > 8) return '[DEPTH_LIMIT]';
    if (typeof value === 'string') return scrub(value);
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    )
      return value;
    if (Array.isArray(value))
      return value.slice(0, 40).map((v) => sanitize(v, depth + 1));
    if (!record(value)) return undefined;
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, v]) => [
          scrub(key),
          key !== 'keywords' &&
          /key|secret|token|authorization|password|prompt|reasoning|thought|consumer|project|headers/i.test(
            key,
          )
            ? '[REDACTED]'
            : sanitize(v, depth + 1),
        ]),
    );
  };
  return sanitize;
}

/** Only synthetic evaluator inputs/outputs may be supplied here. No provider exceptions. */
export function caseDiagnostic(
  id: string,
  provider: string,
  expected: unknown,
  events: unknown[],
  audits: AiAuditEntry[],
  errorCode: string | undefined,
  assertionMessage: string | undefined,
  sanitize: (value: unknown) => unknown,
) {
  const calls = events.filter(record);
  const failed = audits.find((audit) => !audit.success);
  const validated = audits.length > 0 && !failed;
  const result = {
    case: id,
    provider,
    input: calls
      .filter((event) => 'input' in event)
      .map(({ schemaName, input }) => ({ schemaName, input })),
    expected,
    actualStructuredOutput: calls
      .filter((event) => 'output' in event)
      .map(({ schemaName, output }) => ({ schemaName, output })),
    serverValidation: validated
      ? 'PASS'
      : failed?.errorCode === 'AI_INVALID_OUTPUT'
        ? 'FAIL'
        : 'NOT VERIFIED',
    goldenCheck: !validated ? 'NOT VERIFIED' : errorCode ? 'FAIL' : 'PASS',
    failReason:
      errorCode === 'GOLDEN_MISMATCH'
        ? (assertionMessage ?? errorCode)
        : (errorCode ?? 'none'),
  };
  const safe = sanitize(result) as typeof result;
  const formatted = [
    `CASE: ${safe.case}`,
    'INPUT:',
    JSON.stringify(safe.input, null, 2),
    'EXPECTED:',
    JSON.stringify(safe.expected, null, 2),
    `ACTUAL ${safe.provider.toUpperCase()} STRUCTURED OUTPUT:`,
    JSON.stringify(safe.actualStructuredOutput, null, 2),
    `SERVER VALIDATION: ${safe.serverValidation}`,
    `GOLDEN CHECK: ${safe.goldenCheck}`,
    'FAIL REASON:',
    safe.failReason,
  ].join('\n');
  return { ...safe, formatted };
}

/** Failed audit takes precedence over an assertion about a feature fallback. */
export function evaluationFailure(error: unknown, audits: AiAuditEntry[]) {
  const failed = audits.find((audit) => !audit.success);
  return (
    failed?.errorCode ??
    (error instanceof Error && error.name === 'AssertionError'
      ? 'GOLDEN_MISMATCH'
      : normalizeAiError(error).code)
  );
}

export function evaluationFailureCategory(code: string | undefined) {
  if (!code) return undefined;
  if (code === 'GOLDEN_MISMATCH') return 'golden_semantic';
  // Phase 17 uses this code for JSON, DTO and server semantic rejection.
  if (code === 'AI_INVALID_OUTPUT') return 'schema_or_server_validation';
  if (
    code.startsWith('AI_PROVIDER_') ||
    ['AI_TIMEOUT', 'AI_RATE_LIMIT'].includes(code)
  )
    return 'provider_quota_or_network';
  if (['AI_DISABLED', 'AI_NOT_CONFIGURED', 'AI_INVALID_REQUEST'].includes(code))
    return 'configuration_or_request';
  return 'other';
}

export function installHttpDiagnostics(
  events: unknown[],
  sanitize: (value: unknown) => unknown,
) {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    try {
      const response = await original(...args);
      const event: Record<string, unknown> = { httpStatus: response.status };
      if (!response.ok) {
        try {
          const body: unknown = await response.clone().json();
          if (record(body) && record(body.error)) {
            const error = body.error;
            event.error = {
              code: error.code,
              status: error.status,
              message: error.message,
              details: error.details,
            };
          }
        } catch {
          event.error = 'NON_JSON_ERROR_BODY';
        }
      }
      events.push(sanitize(event));
      return response;
    } catch (error) {
      events.push(
        sanitize({
          transportError: record(error) ? error.name : 'UnknownError',
          code: record(error) ? error.code : undefined,
          causeCode:
            record(error) && record(error.cause) ? error.cause.code : undefined,
        }),
      );
      throw error;
    }
  };
  return () => {
    globalThis.fetch = original;
  };
}
