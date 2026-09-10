import { Injectable } from '@nestjs/common';
import { AiConfig } from '../ai.config';
import { AiError } from '../ai.errors';
import type {
  AiProvider,
  AiProviderRequest,
  AiProviderResult,
} from './ai-provider.interface';
import { groqResponseFormat } from './groq-structured-output';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
function transportError(error: unknown, signal: AbortSignal): AiError {
  if (
    signal.aborted ||
    (record(error) &&
      ['AbortError', 'TimeoutError'].includes(String(error.name)))
  )
    return new AiError('AI_TIMEOUT');
  return new AiError('AI_PROVIDER_UNAVAILABLE');
}

@Injectable()
export class GroqProvider implements AiProvider {
  constructor(private readonly config: AiConfig) {}

  async generateStructured(
    request: AiProviderRequest,
  ): Promise<AiProviderResult> {
    const { apiKey, provider } = this.config.requireEnabled();
    if (provider !== 'groq') throw new AiError('AI_NOT_CONFIGURED');
    if (request.signal.aborted) throw new AiError('AI_TIMEOUT');
    let response: Response;
    try {
      // OpenAI-compatible wire API; native fetch adds no dependency or retries.
      response = await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          redirect: 'error',
          signal: request.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: request.model,
            max_completion_tokens: 2048,
            messages: [
              { role: 'system', content: request.systemPrompt },
              { role: 'user', content: request.input },
            ],
            response_format: groqResponseFormat(
              request.model,
              request.schemaName,
              request.jsonSchema,
            ),
          }),
        },
      );
    } catch (error) {
      throw transportError(error, request.signal);
    }
    if (request.signal.aborted) throw new AiError('AI_TIMEOUT');
    if (!response.ok) {
      // Never retain vendor error text, which may echo input or credentials.
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403)
        throw new AiError('AI_PROVIDER_AUTH_ERROR');
      if (response.status === 429) throw new AiError('AI_PROVIDER_RATE_LIMIT');
      if (response.status === 408) throw new AiError('AI_TIMEOUT');
      if (response.status >= 500) throw new AiError('AI_PROVIDER_UNAVAILABLE');
      if (response.status === 404) throw new AiError('AI_NOT_CONFIGURED');
      throw new AiError('AI_INVALID_REQUEST');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (
        !request.signal.aborted &&
        (error instanceof SyntaxError ||
          (record(error) && error.name === 'SyntaxError'))
      )
        throw new AiError('AI_INVALID_OUTPUT');
      throw transportError(error, request.signal);
    }
    if (request.signal.aborted) throw new AiError('AI_TIMEOUT');
    if (
      !record(body) ||
      !Array.isArray(body.choices) ||
      body.choices.length !== 1 ||
      !record(body.choices[0])
    )
      throw new AiError('AI_INVALID_OUTPUT');
    const choice = body.choices[0];
    if (!record(choice.message) || choice.message.role !== 'assistant')
      throw new AiError('AI_INVALID_OUTPUT');
    const message = choice.message;
    if (message.refusal || choice.finish_reason === 'content_filter')
      throw new AiError('AI_REFUSED');
    if (
      choice.finish_reason !== 'stop' ||
      typeof message.content !== 'string' ||
      message.tool_calls ||
      message.function_call
    )
      throw new AiError('AI_INVALID_OUTPUT');
    let output: unknown;
    try {
      output = JSON.parse(message.content);
    } catch {
      throw new AiError('AI_INVALID_OUTPUT');
    }
    // DTO and semantic validation remain authoritative in the orchestrator.
    const usage = record(body.usage)
      ? {
          inputTokens: tokens(body.usage.prompt_tokens),
          outputTokens: tokens(body.usage.completion_tokens),
        }
      : undefined;
    return { output, usage };
  }
}
