import { GroqProvider } from './groq-provider.service';
import type { AiProviderRequest } from './ai-provider.interface';
import { foundationRequest, testAiConfig } from '../testing/ai-test.fixture';

describe('Groq OpenAI-compatible adapter (no network)', () => {
  const config = testAiConfig({
    AI_PROVIDER: 'groq',
    GROQ_API_KEY: 'groq-test-only',
  });
  const provider = new GroqProvider(config);
  const request = (): AiProviderRequest => ({
    model: config.requireEnabled().model,
    systemPrompt: 'Internal instruction',
    input: 'Synthetic input',
    schemaName: 'foundation_output',
    jsonSchema: foundationRequest.output.jsonSchema,
    signal: new AbortController().signal,
  });
  const completion = (content: unknown = '{"value":2}') => ({
    choices: [
      { finish_reason: 'stop', message: { role: 'assistant', content } },
    ],
  });
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network forbidden'));
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends strict JSON schema, caller signal and configured model with one request', async () => {
    fetchMock.mockResolvedValue(Response.json(completion()));
    const req = request();
    await expect(provider.generateStructured(req)).resolves.toEqual({
      output: { value: 2 },
      usage: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      signal: req.signal,
      headers: { Authorization: 'Bearer groq-test-only' },
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      model: 'openai/gpt-oss-20b',
      max_completion_tokens: 2048,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.input },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: req.schemaName,
          strict: true,
          schema: req.jsonSchema,
        },
      },
    });
  });
  it.each([
    '',
    '   ',
    '{',
    '```json\n{"value":2}\n```',
    'prefix {"value":2}',
    '{"value":2} trailing',
  ])('rejects invalid/empty JSON: %j', async (content) => {
    fetchMock.mockResolvedValue(Response.json(completion(content)));
    await expect(provider.generateStructured(request())).rejects.toMatchObject({
      code: 'AI_INVALID_OUTPUT',
    });
  });
  it.each([
    {},
    { choices: [] },
    { choices: [null] },
    { choices: [completion().choices[0], completion().choices[0]] },
    completion(null),
    completion({ value: 2 }),
    {
      choices: [
        {
          finish_reason: 'length',
          message: { role: 'assistant', content: '{"value":2}' },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'user', content: '{"value":2}' },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '{"value":2}',
            tool_calls: [{}],
          },
        },
      ],
    },
  ])('rejects malformed/truncated completion %j', async (body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(provider.generateStructured(request())).rejects.toMatchObject({
      code: 'AI_INVALID_OUTPUT',
    });
  });
  it('ignores reasoning metadata and exposes only the structured content', async () => {
    const body = completion();
    Object.assign(body.choices[0].message, { reasoning: 'private-canary' });
    fetchMock.mockResolvedValue(Response.json(body));
    expect(await provider.generateStructured(request())).toEqual({
      output: { value: 2 },
      usage: undefined,
    });
  });
  it('maps refusal', async () => {
    const body = completion(null);
    Object.assign(body.choices[0].message, { refusal: 'private-canary' });
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(provider.generateStructured(request())).rejects.toMatchObject({
      code: 'AI_REFUSED',
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
    'maps HTTP %s without retaining error text or retrying',
    async (status, code, retryable) => {
      const response = Response.json(
        { error: { message: 'private-canary' } },
        { status: Number(status) },
      );
      const read = jest.spyOn(response, 'json');
      fetchMock.mockResolvedValue(response);
      const error: unknown = await provider
        .generateStructured(request())
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code, retryable });
      expect(JSON.stringify(error)).not.toContain('private-canary');
      expect(read).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['AbortError', 'TimeoutError', 'TypeError'])(
    'maps transport %s',
    async (name) => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error('private-canary'), { name }),
      );
      await expect(
        provider.generateStructured(request()),
      ).rejects.toMatchObject({
        code: name === 'TypeError' ? 'AI_PROVIDER_UNAVAILABLE' : 'AI_TIMEOUT',
      });
    },
  );
  it('rejects an already aborted signal without network', async () => {
    await expect(
      provider.generateStructured({
        ...request(),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('maps abort while reading the response body', async () => {
    const controller = new AbortController();
    const response = Response.json(completion());
    jest.spyOn(response, 'json').mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error('private-canary'));
    });
    fetchMock.mockResolvedValue(response);
    await expect(
      provider.generateStructured({ ...request(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  });
  it('maps a disconnected response body to unavailable', async () => {
    const response = Response.json(completion());
    jest.spyOn(response, 'json').mockRejectedValue(new TypeError('terminated'));
    fetchMock.mockResolvedValue(response);
    await expect(provider.generateStructured(request())).rejects.toMatchObject({
      code: 'AI_PROVIDER_UNAVAILABLE',
    });
  });
  it('rejects non-JSON HTTP success', async () => {
    fetchMock.mockResolvedValue(new Response('not JSON'));
    await expect(provider.generateStructured(request())).rejects.toMatchObject({
      code: 'AI_INVALID_OUTPUT',
    });
  });
  it.each([
    [
      { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      { inputTokens: 12, outputTokens: 7 },
    ],
    [
      { prompt_tokens: 0, completion_tokens: 0 },
      { inputTokens: 0, outputTokens: 0 },
    ],
    [
      { prompt_tokens: -1, completion_tokens: 1.5 },
      { inputTokens: undefined, outputTokens: undefined },
    ],
    [
      { prompt_tokens: '12', completion_tokens: Number.MAX_SAFE_INTEGER + 1 },
      { inputTokens: undefined, outputTokens: undefined },
    ],
    [{ prompt_tokens: 4 }, { inputTokens: 4, outputTokens: undefined }],
    [undefined, undefined],
  ])('maps only reported valid token usage %j', async (usage, expected) => {
    fetchMock.mockResolvedValue(Response.json({ ...completion(), usage }));
    expect((await provider.generateStructured(request())).usage).toEqual(
      expected,
    );
  });
  it('does not use another provider credential', async () => {
    await expect(
      new GroqProvider(testAiConfig()).generateStructured(request()),
    ).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
