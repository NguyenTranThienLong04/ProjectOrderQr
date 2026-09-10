import { testAiConfig } from './testing/ai-test.fixture';
import { AiError } from './ai.errors';
import { safeAiLabel, safeAiModelLabel } from './ai.config';

describe('AI optional configuration', () => {
  it('selects Groq credentials and default namespaced model independently', () => {
    expect(
      testAiConfig({
        AI_PROVIDER: 'groq',
        GROQ_API_KEY: ' groq-test-only ',
        AI_API_KEY: undefined,
        AI_MODEL: undefined,
      }).requireEnabled(),
    ).toEqual({
      provider: 'groq',
      model: 'openai/gpt-oss-20b',
      apiKey: 'groq-test-only',
      timeoutMs: 100,
      maxRetries: 1,
    });
  });
  it('accepts explicit Groq model override', () => {
    expect(
      testAiConfig({
        AI_PROVIDER: 'groq',
        GROQ_API_KEY: 'groq-test-only',
        GROQ_MODEL: 'openai/gpt-oss-120b',
      }).requireEnabled().model,
    ).toBe('openai/gpt-oss-120b');
  });
  it.each([
    { GROQ_API_KEY: undefined },
    { GROQ_API_KEY: '' },
    { GROQ_API_KEY: '<placeholder>' },
    { GROQ_MODEL: '' },
    { GROQ_MODEL: 'unsafe/model?key=secret' },
    { GROQ_MODEL: 'https://host/model' },
  ])('rejects invalid Groq config without falling back: %j', (overrides) => {
    expect(() =>
      testAiConfig({
        AI_PROVIDER: 'groq',
        GROQ_API_KEY: 'groq-test-only',
        ...overrides,
      }).requireEnabled(),
    ).toThrow(new AiError('AI_NOT_CONFIGURED'));
  });
  it('allows a namespaced audit model without expanding other audit labels', () => {
    expect(safeAiModelLabel('openai/gpt-oss-20b')).toBe('openai/gpt-oss-20b');
    expect(safeAiLabel('openai/gpt-oss-20b')).toBe('unknown');
    for (const value of [
      'https://host/model',
      'model?key=secret',
      'a/b/c',
      '/model',
      'a/'.repeat(100),
    ])
      expect(safeAiModelLabel(value)).toBe('unknown');
  });
  it('defaults to disabled without a key and does not throw on construction', () => {
    const config = testAiConfig({
      AI_ENABLED: undefined,
      AI_API_KEY: undefined,
    });
    expect(() => config.requireEnabled()).toThrow(new AiError('AI_DISABLED'));
  });
  it('accepts valid config', () => {
    expect(testAiConfig().requireEnabled()).toMatchObject({
      provider: 'openai',
      timeoutMs: 100,
      maxRetries: 1,
    });
  });
  it('selects Gemini credentials/model independently of legacy OpenAI env', () => {
    expect(
      testAiConfig({
        AI_PROVIDER: 'gemini',
        AI_API_KEY: undefined,
        AI_MODEL: undefined,
        GEMINI_API_KEY: ' gemini-test-only ',
        GEMINI_MODEL: 'gemini-3.7-flash',
      }).requireEnabled(),
    ).toEqual({
      provider: 'gemini',
      model: 'gemini-3.7-flash',
      apiKey: 'gemini-test-only',
      timeoutMs: 100,
      maxRetries: 1,
    });
  });
  it.each([
    { GEMINI_API_KEY: undefined },
    { GEMINI_API_KEY: '' },
    { GEMINI_API_KEY: '<placeholder>' },
    { GEMINI_MODEL: undefined },
    { GEMINI_MODEL: '' },
    { GEMINI_MODEL: 'unsafe/model?key=secret' },
  ])(
    'rejects missing/invalid Gemini settings without OpenAI fallback: %j',
    (env) => {
      expect(() =>
        testAiConfig({
          AI_PROVIDER: 'gemini',
          GEMINI_API_KEY: 'gemini-test-only',
          GEMINI_MODEL: 'gemini-3.7-flash',
          ...env,
        }).requireEnabled(),
      ).toThrow(new AiError('AI_NOT_CONFIGURED'));
    },
  );
  it('keeps legacy OpenAI config when Gemini settings are invalid', () => {
    expect(
      testAiConfig({ GEMINI_API_KEY: '', GEMINI_MODEL: '' }).requireEnabled(),
    ).toMatchObject({
      provider: 'openai',
      apiKey: 'test-only-not-a-real-key',
      model: 'test-model-snapshot',
    });
  });
  it.each([
    { AI_PROVIDER: undefined },
    { AI_PROVIDER: 'unsupported' },
    { AI_API_KEY: '' },
    { AI_API_KEY: '<placeholder>' },
    { AI_MODEL: '' },
    { AI_ENABLED: 'yes' },
    { AI_TIMEOUT_MS: '0' },
    { AI_TIMEOUT_MS: 'NaN' },
    { AI_TIMEOUT_MS: '60001' },
    { AI_TIMEOUT_MS: '100.5' },
    { AI_TIMEOUT_MS: '' },
    { AI_MAX_RETRIES: '-1' },
    { AI_MAX_RETRIES: '3' },
    { AI_MAX_RETRIES: '1.5' },
    { AI_MAX_RETRIES: 'NaN' },
  ])('rejects invalid config lazily: %j', (overrides) => {
    const config = testAiConfig(overrides);
    expect(() => config.requireEnabled()).toThrow(
      new AiError('AI_NOT_CONFIGURED'),
    );
  });
  it('accepts retry zero and two and default time/retry', () => {
    for (const value of ['0', '2'])
      expect(
        testAiConfig({ AI_MAX_RETRIES: value }).requireEnabled().maxRetries,
      ).toBe(Number(value));
    expect(
      testAiConfig({
        AI_TIMEOUT_MS: undefined,
        AI_MAX_RETRIES: undefined,
      }).requireEnabled(),
    ).toMatchObject({ timeoutMs: 10000, maxRetries: 1 });
  });
});
