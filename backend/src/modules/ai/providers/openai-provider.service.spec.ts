import { OpenAiProvider } from './openai-provider.service';
import type { AiProviderRequest } from './ai-provider.interface';
import { foundationRequest, testAiConfig } from '../testing/ai-test.fixture';

describe('OpenAiProvider HTTP contract (no Internet)', () => {
  let fetchMock: jest.SpyInstance;
  const provider = new OpenAiProvider(testAiConfig());
  const request: AiProviderRequest = {
    model: 'test-model-snapshot',
    systemPrompt: 'internal prompt',
    input: 'private note',
    schemaName: foundationRequest.output.name,
    jsonSchema: foundationRequest.output.jsonSchema,
    signal: new AbortController().signal,
  };
  const envelope = (
    content: unknown = [{ type: 'output_text', text: '{"value":2}' }],
  ) => ({
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content }],
    usage: { input_tokens: 9, output_tokens: 3 },
  });
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => jest.restoreAllMocks());
  it('sends native schema/store false, separates system/user, returns only output/real usage', async () => {
    fetchMock.mockResolvedValue(Response.json(envelope()));
    expect(await provider.generateStructured(request)).toEqual({
      output: { value: 2 },
      usage: { inputTokens: 9, outputTokens: 3 },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.signal).toBe(request.signal);
    expect(JSON.parse(init.body as string)).toMatchObject({
      store: false,
      max_output_tokens: 2048,
      model: request.model,
      input: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.input },
      ],
      text: {
        format: {
          type: 'json_schema',
          strict: true,
          schema: request.jsonSchema,
        },
      },
    });
  });
  it.each([
    [429, 'AI_RATE_LIMIT'],
    [500, 'AI_PROVIDER_UNAVAILABLE'],
    [503, 'AI_PROVIDER_UNAVAILABLE'],
    [401, 'AI_PROVIDER_AUTH_ERROR'],
    [403, 'AI_PROVIDER_AUTH_ERROR'],
    [400, 'AI_INVALID_REQUEST'],
    [404, 'AI_NOT_CONFIGURED'],
    [422, 'AI_INVALID_REQUEST'],
  ])('maps HTTP %s safely', async (status, code) => {
    fetchMock.mockResolvedValue(
      new Response('sensitive provider error', { status }),
    );
    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      code,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('maps network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('secret network details'));
    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      code: 'AI_PROVIDER_UNAVAILABLE',
    });
  });
  it('maps aborted fetch', async () => {
    fetchMock.mockRejectedValue(new Error('aborted'));
    await expect(
      provider.generateStructured({ ...request, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  });
  it.each([
    { ...envelope(), status: 'incomplete' },
    { status: 'completed', output: [] },
    envelope([{ type: 'output_text', text: '```json\n{"value":2}\n```' }]),
    envelope([
      { type: 'output_text', text: '{"value":2}' },
      { type: 'output_text', text: '{}' },
    ]),
    envelope([{ type: 'output_text', text: 'prefix {"value":2}' }]),
    { ...envelope(), output: 'malformed' },
  ])('rejects malformed/incomplete/free-text envelope %#', async (body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      code: 'AI_INVALID_OUTPUT',
    });
  });
  it('maps refusal without exposing refusal text', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        envelope([{ type: 'refusal', refusal: 'private details' }]),
      ),
    );
    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      code: 'AI_REFUSED',
    });
  });
  it('rejects non-JSON response body', async () => {
    fetchMock.mockResolvedValue(new Response('not JSON'));
    await expect(provider.generateStructured(request)).rejects.toMatchObject({
      code: 'AI_INVALID_OUTPUT',
    });
  });
  it('ignores reasoning and never invents usage', async () => {
    const body = envelope();
    fetchMock.mockResolvedValue(
      Response.json({
        ...body,
        usage: undefined,
        output: [
          { type: 'reasoning', summary: 'private reasoning' },
          ...body.output,
        ],
      }),
    );
    expect(await provider.generateStructured(request)).toEqual({
      output: { value: 2 },
      usage: undefined,
    });
  });
});
