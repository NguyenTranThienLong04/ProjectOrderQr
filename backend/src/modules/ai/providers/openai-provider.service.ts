import { Injectable } from '@nestjs/common';
import { AiConfig } from '../ai.config';
import { AiError } from '../ai.errors';
import type {
  AiProvider,
  AiProviderRequest,
  AiProviderResult,
} from './ai-provider.interface';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

@Injectable()
export class OpenAiProvider implements AiProvider {
  constructor(private readonly config: AiConfig) {}

  async generateStructured(
    request: AiProviderRequest,
  ): Promise<AiProviderResult> {
    const { apiKey } = this.config.requireEnabled();
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        signal: request.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          store: false,
          max_output_tokens: 2048,
          input: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.input },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: request.schemaName,
              strict: true,
              schema: request.jsonSchema,
            },
          },
        }),
      });
    } catch {
      throw new AiError(
        request.signal.aborted ? 'AI_TIMEOUT' : 'AI_PROVIDER_UNAVAILABLE',
      );
    }
    if (!response.ok) {
      // Do not read the error body: it may contain request text or credentials.
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403)
        throw new AiError('AI_PROVIDER_AUTH_ERROR');
      if (response.status === 429) throw new AiError('AI_RATE_LIMIT');
      if (response.status >= 500) throw new AiError('AI_PROVIDER_UNAVAILABLE');
      if (response.status === 404) throw new AiError('AI_NOT_CONFIGURED');
      throw new AiError('AI_INVALID_REQUEST');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AiError(
        request.signal.aborted ? 'AI_TIMEOUT' : 'AI_INVALID_OUTPUT',
      );
    }
    if (
      !record(body) ||
      body.status !== 'completed' ||
      !Array.isArray(body.output)
    )
      throw new AiError('AI_INVALID_OUTPUT');
    const content: Record<string, unknown>[] = [];
    for (const item of body.output as unknown[]) {
      if (!record(item) || item.type !== 'message') continue;
      if (item.role !== 'assistant' || !Array.isArray(item.content))
        throw new AiError('AI_INVALID_OUTPUT');
      for (const part of item.content as unknown[]) {
        if (!record(part)) throw new AiError('AI_INVALID_OUTPUT');
        if (part.type === 'refusal') throw new AiError('AI_REFUSED');
        if (part.type === 'output_text') content.push(part);
      }
    }
    if (content.length !== 1 || typeof content[0].text !== 'string')
      throw new AiError('AI_INVALID_OUTPUT');
    let output: unknown;
    // Only decode the provider-native structured field; no free-text extraction.
    try {
      output = JSON.parse(content[0].text);
    } catch {
      throw new AiError('AI_INVALID_OUTPUT');
    }
    const usage = record(body.usage)
      ? {
          inputTokens: tokens(body.usage.input_tokens),
          outputTokens: tokens(body.usage.output_tokens),
        }
      : undefined;
    return { output, usage };
  }
}
