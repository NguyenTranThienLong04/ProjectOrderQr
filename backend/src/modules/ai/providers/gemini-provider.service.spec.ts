import { GeminiProvider } from './gemini-provider.service';
import { AiOrchestratorService } from '../ai-orchestrator.service';
import { AiAuditService } from '../ai-audit.service';
import { AiPromptRegistry } from '../prompts/ai-prompt-registry.service';
import {
  foundationPrompt,
  foundationRequest,
  testAiConfig,
} from '../testing/ai-test.fixture';

// Real SDK with mocked HTTP transport: these tests never call Google.
describe('GeminiProvider SDK contract (no network)', () => {
  const config = testAiConfig({
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'gemini-test-only',
    GEMINI_MODEL: 'gemini-3.7-flash',
  });
  const provider = new GeminiProvider(config);
  const request = {
    model: 'gemini-3.7-flash',
    systemPrompt: foundationPrompt.systemPrompt,
    input: foundationRequest.input,
    schemaName: foundationRequest.output.name,
    jsonSchema: foundationRequest.output.jsonSchema,
    signal: new AbortController().signal,
  };
  const envelope = (text = '{"value":3}') => ({
    candidates: [
      { content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' },
    ],
  });
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected HTTP request'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  function respond(body: unknown, status = 200) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  function orchestrator() {
    const record = jest.fn().mockResolvedValue(true);
    const prompts = new AiPromptRegistry();
    prompts.register(foundationPrompt);
    return {
      record,
      service: new AiOrchestratorService(config, provider, prompts, {
        record,
      } as unknown as AiAuditService),
    };
  }
  it('sends native JSON schema, separate system/user data and the selected backend key', async () => {
    respond(envelope());
    expect(await provider.generateStructured(request)).toEqual({
      output: { value: 3 },
      usage: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent',
    );
    if (typeof init?.body !== 'string')
      throw new Error('Expected JSON request');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: request.input }] }],
      systemInstruction: { parts: [{ text: request.systemPrompt }] },
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: request.jsonSchema,
        candidateCount: 1,
        maxOutputTokens: 2048,
      },
    });
    expect(body).not.toHaveProperty('tools');
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(
      'gemini-test-only',
    );
    expect(init?.signal).toBeDefined();
  });
  it.each(['', ' ', 'not JSON', '```json\n{"value":3}\n```', '{'])(
    'rejects malformed/empty structured text %j',
    async (text) => {
      respond(envelope(text));
      await expect(provider.generateStructured(request)).rejects.toMatchObject({
        code: 'AI_INVALID_OUTPUT',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    {},
    { candidates: [] },
    { candidates: [envelope().candidates[0], envelope().candidates[0]] },
    {
      candidates: [
        { content: { role: 'model', parts: [] }, finishReason: 'STOP' },
      ],
    },
    {
      candidates: [{ ...envelope().candidates[0], finishReason: 'MAX_TOKENS' }],
    },
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'unsafe' } }],
          },
          finishReason: 'STOP',
        },
      ],
    },
  ])('rejects empty/incomplete/non-text envelope %#', async (body) => {
    respond(body);
    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      code: 'AI_INVALID_OUTPUT',
    });
  });
  it('discards reasoning and accepts split JSON text without exposing SDK warnings', async () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    respond({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [
              { thought: true, text: 'private reasoning' },
              { text: '{"value":' },
              { text: '3}', thoughtSignature: 'private-signature' },
            ],
          },
        },
      ],
    });
    expect(await provider.generateStructured(request)).toEqual({
      output: { value: 3 },
      usage: undefined,
    });
    expect(warn).not.toHaveBeenCalled();
  });
  it.each([
    { promptFeedback: { blockReason: 'SAFETY' } },
    { candidates: [{ finishReason: 'SAFETY' }] },
  ])('maps blocked output to nonretryable refusal %#', async (body) => {
    respond(body);
    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      code: 'AI_REFUSED',
      retryable: false,
    });
  });
  it.each([
    [401, 'AI_PROVIDER_AUTH_ERROR', false],
    [403, 'AI_PROVIDER_AUTH_ERROR', false],
    [429, 'AI_PROVIDER_RATE_LIMIT', true],
    [500, 'AI_PROVIDER_UNAVAILABLE', true],
    [503, 'AI_PROVIDER_UNAVAILABLE', true],
    [504, 'AI_PROVIDER_UNAVAILABLE', true],
    [408, 'AI_TIMEOUT', true],
    [404, 'AI_NOT_CONFIGURED', false],
    [400, 'AI_INVALID_REQUEST', false],
  ])(
    'maps HTTP %s and makes only one SDK attempt',
    async (status, code, retryable) => {
      respond(
        { error: { message: 'private key / prompt / reasoning' } },
        status,
      );
      const error: unknown = await provider
        .generateStructured(request)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code, retryable });
      expect(JSON.stringify(error)).not.toContain('private key');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it('maps Google HTTP 400 API_KEY_INVALID via structured ErrorInfo', async () => {
    respond(
      {
        error: {
          message: 'private key',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              domain: 'googleapis.com',
              reason: 'API_KEY_INVALID',
            },
          ],
        },
      },
      400,
    );
    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      code: 'AI_PROVIDER_AUTH_ERROR',
      retryable: false,
    });
  });
  it('maps network failure without retrying inside SDK', async () => {
    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      code: 'AI_PROVIDER_UNAVAILABLE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not call SDK for an already aborted signal', async () => {
    await expect(
      provider.generateStructured({ ...request, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('maps transport AbortError to timeout', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('private'), { name: 'AbortError' }),
    );
    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      code: 'AI_TIMEOUT',
    });
  });
  it.each([
    [
      {
        promptTokenCount: 12,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 9,
        totalTokenCount: 25,
      },
      { inputTokens: 12, outputTokens: 4 },
    ],
    [{ promptTokenCount: 0 }, { inputTokens: 0, outputTokens: undefined }],
    [{ candidatesTokenCount: 4 }, { inputTokens: undefined, outputTokens: 4 }],
    [
      { promptTokenCount: -1, candidatesTokenCount: 1.2 },
      { inputTokens: undefined, outputTokens: undefined },
    ],
  ])('maps only reported valid usage %#', async (usageMetadata, usage) => {
    respond({ ...envelope(), usageMetadata });
    expect(await provider.generateStructured(request)).toEqual({
      output: { value: 3 },
      usage,
    });
  });
  it.each([
    'null',
    '[]',
    '3',
    '{}',
    '{"value":"3"}',
    '{"value":20}',
    '{"value":3,"extra":true}',
  ])(
    'keeps Phase 17 schema validation and retries invalid result %s',
    async (text) => {
      jest.useFakeTimers();
      respond({ ...envelope(text), usageMetadata: { promptTokenCount: 7 } });
      respond({
        ...envelope(text),
        usageMetadata: { candidatesTokenCount: 4 },
      });
      const { service, record } = orchestrator();
      const result = service
        .generateStructured(foundationRequest)
        .catch((e: unknown) => e);
      await jest.runAllTimersAsync();
      expect(await result).toMatchObject({ code: 'AI_INVALID_OUTPUT' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'gemini',
          attempts: 2,
          inputTokens: 7,
          outputTokens: 4,
          success: false,
        }),
      );
    },
  );
  it('lets Orchestrator back off/recover and retain modelVersion/audit', async () => {
    jest.useFakeTimers();
    respond({}, 429);
    respond(envelope());
    const { service, record } = orchestrator();
    const result = service.generateStructured(foundationRequest);
    await jest.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({
      result: { value: 3 },
      modelVersion: 'gemini:gemini-3.7-flash:v1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.7-flash',
        success: true,
        attempts: 2,
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(request.input);
    expect(JSON.stringify(record.mock.calls)).not.toContain('gemini-test-only');
  });
  it('aborts actual SDK transport on every Orchestrator timeout and exhausts its budget', async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signals.push(signal);
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const { service, record } = orchestrator();
    const result = service
      .generateStructured(foundationRequest)
      .catch((e: unknown) => e);
    await jest.runAllTimersAsync();
    expect(await result).toMatchObject({ code: 'AI_TIMEOUT' });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 2, errorCode: 'AI_TIMEOUT' }),
    );
  });
});
