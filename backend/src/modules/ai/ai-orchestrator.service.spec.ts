import { AiOrchestratorService } from './ai-orchestrator.service';
import { AiAuditService } from './ai-audit.service';
import { AiError } from './ai.errors';
import { AiPromptRegistry } from './prompts/ai-prompt-registry.service';
import { MockAiProvider } from './testing/mock-ai-provider';
import type { MockAiStep } from './testing/mock-ai-provider';
import {
  foundationPrompt,
  foundationRequest,
  testAiConfig,
} from './testing/ai-test.fixture';

describe('AiOrchestratorService', () => {
  const record = jest.fn<
    ReturnType<AiAuditService['record']>,
    Parameters<AiAuditService['record']>
  >();
  const prompts = new AiPromptRegistry();
  prompts.register(foundationPrompt);
  function setup(
    steps: MockAiStep[],
    env: Record<string, string | undefined> = {},
  ) {
    const provider = new MockAiProvider(steps);
    const audit = { record } as unknown as AiAuditService;
    return {
      provider,
      service: new AiOrchestratorService(
        testAiConfig(env),
        provider,
        prompts,
        audit,
      ),
    };
  }
  beforeEach(() => {
    jest.useFakeTimers();
    record.mockReset().mockResolvedValue(true);
  });
  afterEach(() => jest.useRealTimers());
  async function errorOf(promise: Promise<unknown>) {
    // Attach rejection handler before advancing timers (no unhandled rejection).
    const observed = promise.catch((error: unknown) => error);
    await jest.runAllTimersAsync();
    return observed;
  }
  it('validates typed success, metadata and private audit allowlist', async () => {
    const { service, provider } = setup([
      { output: { value: 3 }, usage: { inputTokens: 12, outputTokens: 4 } },
    ]);
    const response = await service.generateStructured(foundationRequest);
    expect(response).toEqual({
      result: { value: 3 },
      modelVersion: 'openai:test-model-snapshot:v1',
      fallbackUsed: false,
    });
    expect(provider.calls).toHaveLength(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'foundation-test',
        provider: 'openai',
        model: 'test-model-snapshot',
        promptVersion: 'v1',
        inputTokens: 12,
        outputTokens: 4,
        success: true,
        attempts: 1,
        latencyMs: expect.any(Number) as unknown,
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(
      foundationRequest.input,
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(
      foundationPrompt.systemPrompt,
    );
  });
  it.each([
    'AI_RATE_LIMIT',
    'AI_PROVIDER_UNAVAILABLE',
    'AI_INVALID_OUTPUT',
  ] as const)('backs off then recovers from %s', async (code) => {
    const { service, provider } = setup([
      new AiError(code),
      { output: { value: 2 } },
    ]);
    const promise = service.generateStructured(foundationRequest);
    await jest.advanceTimersByTimeAsync(249);
    expect(provider.calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect((await promise).result.value).toBe(2);
    expect(provider.calls).toHaveLength(2);
    expect(record).toHaveBeenCalledTimes(1);
  });
  it.each([
    'AI_PROVIDER_AUTH_ERROR',
    'AI_INVALID_REQUEST',
    'AI_UNSUPPORTED_FEATURE',
    'AI_REFUSED',
  ] as const)('never retries %s', async (code) => {
    const { service, provider } = setup([new AiError(code)]);
    expect(
      await errorOf(service.generateStructured(foundationRequest)),
    ).toMatchObject({ code });
    expect(provider.calls).toHaveLength(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorCode: code, attempts: 1 }),
    );
  });
  it('stops at maximum two retries', async () => {
    const { service, provider } = setup(
      Array.from({ length: 3 }, () => new AiError('AI_RATE_LIMIT')),
      { AI_MAX_RETRIES: '2' },
    );
    expect(
      await errorOf(service.generateStructured(foundationRequest)),
    ).toMatchObject({ code: 'AI_RATE_LIMIT' });
    expect(provider.calls).toHaveLength(3);
    expect(record).toHaveBeenCalledTimes(1);
  });
  it('aborts each timed out attempt and bounds even an adapter ignoring abort', async () => {
    const never = () => new Promise<never>(() => undefined);
    const { service, provider } = setup([never, never]);
    expect(
      await errorOf(service.generateStructured(foundationRequest)),
    ).toMatchObject({ code: 'AI_TIMEOUT' });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.every((call) => call.signal.aborted)).toBe(true);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'AI_TIMEOUT',
        latencyMs: 450,
      }),
    );
  });
  it.each([
    null,
    [],
    'free text',
    { value: '3' },
    {},
    { value: 11 },
    { value: 3, internalPrompt: 'secret' },
  ])('rejects invalid output %j', async (output) => {
    const { service, provider } = setup([{ output }], { AI_MAX_RETRIES: '0' });
    expect(
      await errorOf(service.generateStructured(foundationRequest)),
    ).toMatchObject({ code: 'AI_INVALID_OUTPUT' });
    expect(provider.calls).toHaveLength(1);
  });
  it('retries schema failure and sums only reported token usage', async () => {
    const { service } = setup([
      { output: { value: 'bad' }, usage: { inputTokens: 7, outputTokens: 1 } },
      { output: { value: 1 }, usage: { inputTokens: 8, outputTokens: 2 } },
    ]);
    const promise = service.generateStructured(foundationRequest);
    await jest.runAllTimersAsync();
    await promise;
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 15,
        outputTokens: 3,
        success: true,
      }),
    );
  });
  it.each([{ AI_ENABLED: 'false' }, { AI_API_KEY: undefined }])(
    'audits unavailable configuration without calling provider',
    async (env) => {
      const { service, provider } = setup([], env);
      await errorOf(service.generateStructured(foundationRequest));
      expect(provider.calls).toHaveLength(0);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, attempts: 0 }),
      );
    },
  );
  it('rejects unknown prompt and oversized/empty input before provider call', async () => {
    const { service, provider } = setup([]);
    for (const request of [
      { ...foundationRequest, promptVersion: 'v2' },
      { ...foundationRequest, input: '' },
      { ...foundationRequest, input: 'x'.repeat(16001) },
    ]) {
      expect(await errorOf(service.generateStructured(request))).toBeInstanceOf(
        AiError,
      );
    }
    expect(provider.calls).toHaveLength(0);
  });
  it('maps unknown errors without leaking sensitive details or retrying', async () => {
    const { service, provider } = setup([
      new Error('API key and raw customer allergy note'),
    ]);
    const error = await errorOf(service.generateStructured(foundationRequest));
    expect(error).toMatchObject({ code: 'AI_INTERNAL_ERROR' });
    expect(JSON.stringify(error)).not.toContain('allergy');
    expect(provider.calls).toHaveLength(1);
  });
  it('audit outage preserves successful result with explicit warning', async () => {
    record.mockResolvedValue(false);
    const { service } = setup([{ output: { value: 1 } }]);
    expect(await service.generateStructured(foundationRequest)).toMatchObject({
      warnings: ['AI_AUDIT_UNAVAILABLE'],
      result: { value: 1 },
    });
  });
  it('does not fabricate tokens or confidence', async () => {
    const { service } = setup([{ output: { value: 1 } }]);
    const response = await service.generateStructured(foundationRequest);
    expect(response.confidence).toBeUndefined();
    expect(record.mock.calls[0][0].inputTokens).toBeUndefined();
  });
  it('registry keeps versions immutable and refuses duplicate definitions', () => {
    expect(() => prompts.register(foundationPrompt)).toThrow(AiError);
    expect(Object.isFrozen(prompts.get('foundation-test', 'v1'))).toBe(true);
    prompts.register({ ...foundationPrompt, promptVersion: 'v2' });
    expect(prompts.get('foundation-test', 'v1').promptVersion).toBe('v1');
  });
});
