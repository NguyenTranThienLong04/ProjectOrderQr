import { AiProviderResolver } from '../../src/modules/ai/providers/ai-provider-resolver.service';
import { GroqProvider } from '../../src/modules/ai/providers/groq-provider.service';
import { OpenAiProvider } from '../../src/modules/ai/providers/openai-provider.service';
import { GeminiProvider } from '../../src/modules/ai/providers/gemini-provider.service';
import { testAiConfig } from '../../src/modules/ai/testing/ai-test.fixture';
import { evaluationCases, evaluationHarness } from './harness';
import {
  evaluationFailure,
  evaluationFailureCategory,
} from './live-diagnostics';

function completion(output: unknown) {
  return {
    choices: [
      {
        finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(output) },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
  };
}
const representatives = evaluationCases.filter(
  (entry, index, entries) =>
    entry.id === 'review-summary-grounding' ||
    entries.findIndex((other) => other.feature === entry.feature) === index,
);

describe('Groq and OpenAI through resolver + existing five features (no network)', () => {
  it.each([
    { id: 'note-1', field: 'modifierTags', duplicate: 'NO_ONION' },
    { id: 'search-budget', field: 'keywords', duplicate: 'beef' },
  ])(
    'server still rejects duplicate $field after provider schema normalization',
    async ({ id, field, duplicate }) => {
      const entry = evaluationCases.find((candidate) => candidate.id === id)!;
      const config = testAiConfig({
        AI_PROVIDER: 'groq',
        GROQ_API_KEY: 'groq-test-only',
        AI_MAX_RETRIES: '0',
      });
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json(
          completion({
            ...(entry.output as Record<string, unknown>),
            [field]: [duplicate, duplicate],
          }),
        ),
      );
      const h = evaluationHarness(new GroqProvider(config), config);
      await entry.run(h).catch(() => undefined);
      expect(h.audits).toHaveLength(1);
      expect(h.audits[0]).toMatchObject({
        success: false,
        errorCode: 'AI_INVALID_OUTPUT',
        attempts: 1,
      });
    },
  );
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  describe.each(['groq', 'openai'])('%s golden regression', (selected) => {
    it.each(evaluationCases)(
      '$id preserves validation and grounding',
      async (entry) => {
        const config = testAiConfig({
          AI_PROVIDER: selected,
          GROQ_API_KEY: 'groq-test-only',
          AI_TIMEOUT_MS: '1000',
          AI_MAX_RETRIES: '0',
        });
        const fetchMock = jest
          .spyOn(globalThis, 'fetch')
          .mockImplementation((url, init) => {
            expect(url).toBe(
              selected === 'groq'
                ? 'https://api.groq.com/openai/v1/chat/completions'
                : 'https://api.openai.com/v1/responses',
            );
            const body = JSON.parse(init!.body as string) as {
              response_format?: {
                json_schema: {
                  strict: boolean;
                  schema: { properties: { answer?: { enum: string[] } } };
                };
              };
              text?: {
                format: {
                  schema: { properties: { answer?: { enum: string[] } } };
                };
              };
            };
            const schema =
              selected === 'groq'
                ? body.response_format!.json_schema.schema
                : body.text!.format.schema;
            if (selected === 'groq')
              expect(body.response_format!.json_schema.strict).toBe(true);
            const output = schema.properties.answer
              ? { answer: schema.properties.answer.enum[0] }
              : entry.output;
            return Promise.resolve(
              Response.json(
                selected === 'groq'
                  ? completion(output)
                  : {
                      status: 'completed',
                      output: [
                        {
                          type: 'message',
                          role: 'assistant',
                          content: [
                            {
                              type: 'output_text',
                              text: JSON.stringify(output),
                            },
                          ],
                        },
                      ],
                      usage: { input_tokens: 10, output_tokens: 3 },
                    },
              ),
            );
          });
        const resolver = new AiProviderResolver(
          config,
          new OpenAiProvider(config),
          new GeminiProvider(config),
          new GroqProvider(config),
        );
        const h = evaluationHarness(resolver, config);
        await entry.run(h);
        expect(fetchMock).toHaveBeenCalled();
        expect(h.audits.length).toBeGreaterThan(0);
        for (const audit of h.audits)
          expect(audit).toMatchObject({
            provider: selected,
            model:
              selected === 'groq'
                ? 'openai/gpt-oss-20b'
                : 'test-model-snapshot',
            success: true,
            attempts: 1,
            inputTokens: 10,
            outputTokens: 3,
          });
      },
    );
  });
  describe.each([
    { mode: 'disabled', code: 'AI_DISABLED', attempts: 0 },
    { mode: 'missing-key', code: 'AI_NOT_CONFIGURED', attempts: 0 },
    { mode: 'auth', code: 'AI_PROVIDER_AUTH_ERROR', attempts: 1 },
    { mode: 'quota', code: 'AI_PROVIDER_RATE_LIMIT', attempts: 2 },
    { mode: 'unavailable', code: 'AI_PROVIDER_UNAVAILABLE', attempts: 2 },
    { mode: 'invalid-output', code: 'AI_INVALID_OUTPUT', attempts: 2 },
    { mode: 'empty-response', code: 'AI_INVALID_OUTPUT', attempts: 2 },
    { mode: 'timeout', code: 'AI_TIMEOUT', attempts: 2 },
  ])('Groq $mode across five features', ({ mode, code, attempts }) => {
    it.each(representatives)(
      '$id preserves server validation, fallback, retry and failure attribution',
      async (entry) => {
        jest.useFakeTimers();
        const config = testAiConfig({
          AI_PROVIDER: 'groq',
          AI_ENABLED: mode === 'disabled' ? 'false' : 'true',
          GROQ_API_KEY: mode === 'missing-key' ? '' : 'groq-test-only',
        });
        const fetchMock = jest
          .spyOn(globalThis, 'fetch')
          .mockImplementation(() => {
            if (mode === 'timeout')
              return new Promise<Response>(() => undefined);
            if (mode === 'invalid-output')
              return Promise.resolve(
                Response.json(completion({ unsafe: 'private-canary' })),
              );
            if (mode === 'empty-response')
              return Promise.resolve(Response.json({ choices: [] }));
            return Promise.resolve(
              Response.json(
                { error: { message: 'private-canary' } },
                {
                  status: mode === 'auth' ? 401 : mode === 'quota' ? 429 : 503,
                },
              ),
            );
          });
        const h = evaluationHarness(
          new AiProviderResolver(
            config,
            new OpenAiProvider(config),
            new GeminiProvider(config),
            new GroqProvider(config),
          ),
          config,
        );
        const catalog = JSON.stringify(h.catalog);
        const run = entry.run(h).catch((error: unknown) => error);
        await jest.runAllTimersAsync();
        const error: unknown = await run;
        expect(h.audits).toHaveLength(1);
        expect(h.audits[0]).toMatchObject({
          provider: 'groq',
          success: false,
          errorCode: code,
          attempts,
        });
        expect(fetchMock).toHaveBeenCalledTimes(attempts);
        expect(evaluationFailure(error, h.audits)).toBe(code);
        expect(evaluationFailureCategory(code)).not.toBe('golden_semantic');
        expect(JSON.stringify(h.catalog)).toBe(catalog);
        expect(h.insight()).toBeUndefined();
        expect(JSON.stringify(h.audits)).not.toContain('private-canary');
      },
    );
  });
});
