import { GeminiProvider } from '../../src/modules/ai/providers/gemini-provider.service';
import { testAiConfig } from '../../src/modules/ai/testing/ai-test.fixture';
import { evaluationCases, evaluationHarness } from './harness';

describe('Gemini SDK + existing five features (synthetic HTTP/repositories)', () => {
  const config = testAiConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'gemini-test-only',
    GEMINI_MODEL: 'gemini-3.7-flash',
    AI_TIMEOUT_MS: '1000',
    AI_MAX_RETRIES: '0',
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  it.each(evaluationCases)(
    '$id preserves feature validation and grounding',
    async (entry) => {
      const fetchMock = jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation((_url, init) => {
          if (typeof init?.body !== 'string')
            throw new Error('Expected JSON request');
          const body = JSON.parse(init.body) as {
            generationConfig: {
              responseJsonSchema: { properties: Record<string, unknown> };
            };
          };
          const schema = body.generationConfig.responseJsonSchema;
          const output = schema.properties.answer
            ? {
                answer: (schema.properties.answer as { enum: string[] })
                  .enum[0],
              }
            : entry.output;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                candidates: [
                  {
                    finishReason: 'STOP',
                    content: {
                      role: 'model',
                      parts: [{ text: JSON.stringify(output) }],
                    },
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 10,
                  candidatesTokenCount: 3,
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        });
      const h = evaluationHarness(new GeminiProvider(config), config);
      await entry.run(h);
      expect(fetchMock).toHaveBeenCalled();
      expect(h.audits.length).toBeGreaterThan(0);
      for (const audit of h.audits) {
        expect(audit).toMatchObject({
          provider: 'gemini',
          model: 'gemini-3.7-flash',
          success: true,
          attempts: 1,
          inputTokens: 10,
          outputTokens: 3,
        });
      }
      expect(JSON.stringify(h.audits)).not.toContain('gemini-test-only');
    },
  );

  const representatives = evaluationCases.filter(
    (entry, index, entries) =>
      entry.id === 'review-summary-grounding' ||
      entries.findIndex((other) => other.feature === entry.feature) === index,
  );
  describe.each([
    { mode: 'disabled', code: 'AI_DISABLED', attempts: 0 },
    { mode: 'missing-key', code: 'AI_NOT_CONFIGURED', attempts: 0 },
    { mode: 'auth', code: 'AI_PROVIDER_AUTH_ERROR', attempts: 1 },
    { mode: 'quota', code: 'AI_PROVIDER_RATE_LIMIT', attempts: 2 },
    { mode: 'unavailable', code: 'AI_PROVIDER_UNAVAILABLE', attempts: 2 },
    { mode: 'invalid-output', code: 'AI_INVALID_OUTPUT', attempts: 2 },
    { mode: 'timeout', code: 'AI_TIMEOUT', attempts: 2 },
  ])('$mode across existing features', ({ mode, code, attempts }) => {
    it.each(representatives)(
      '$id records a controlled failure without changing catalog/review',
      async (entry) => {
        jest.useFakeTimers();
        const failureConfig = testAiConfig({
          AI_PROVIDER: 'gemini',
          AI_ENABLED: mode === 'disabled' ? 'false' : 'true',
          GEMINI_API_KEY: mode === 'missing-key' ? '' : 'gemini-test-only',
          GEMINI_MODEL: 'gemini-3.7-flash',
        });
        const fetchMock = jest
          .spyOn(globalThis, 'fetch')
          .mockImplementation(() => {
            if (mode === 'timeout')
              return new Promise<Response>(() => undefined);
            if (mode === 'invalid-output')
              return Promise.resolve(
                Response.json({
                  candidates: [
                    {
                      finishReason: 'STOP',
                      content: {
                        role: 'model',
                        parts: [{ text: '{"unsafe":"private-canary"}' }],
                      },
                    },
                  ],
                }),
              );
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
          new GeminiProvider(failureConfig),
          failureConfig,
        );
        const catalog = JSON.stringify(h.catalog);
        // Existing evaluator rejects unavailable results; fallback-aware services may resolve.
        const run = entry.run(h).catch(() => undefined);
        await jest.runAllTimersAsync();
        await run;
        expect(h.audits).toHaveLength(1);
        expect(h.audits[0]).toMatchObject({
          provider: 'gemini',
          success: false,
          errorCode: code,
          attempts,
        });
        expect(fetchMock).toHaveBeenCalledTimes(attempts);
        expect(JSON.stringify(h.catalog)).toBe(catalog);
        expect(h.insight()).toBeUndefined();
        expect(JSON.stringify(h.audits)).not.toContain('private-canary');
      },
    );
  });
});
