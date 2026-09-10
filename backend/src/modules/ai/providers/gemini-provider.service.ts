import { Injectable } from '@nestjs/common';
import {
  ApiError,
  BlockedReason,
  FinishReason,
  GoogleGenAI,
} from '@google/genai';
import type { GenerateContentResponse } from '@google/genai';
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

function hasOneCandidate(value: unknown): boolean {
  return Array.isArray(value) && value.length === 1 && record(value[0]);
}

function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function invalidKey(error: ApiError): boolean {
  // SDK exposes Google's structured ErrorInfo only inside message JSON.
  // Inspect the allowlisted reason, then discard the body; never log/retain it.
  try {
    const body: unknown = JSON.parse(error.message);
    return (
      record(body) &&
      record(body.error) &&
      Array.isArray(body.error.details) &&
      body.error.details.some(
        (detail: unknown) =>
          record(detail) &&
          detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
          detail.domain === 'googleapis.com' &&
          [
            'API_KEY_INVALID',
            'API_KEY_EXPIRED',
            'API_KEY_SERVICE_BLOCKED',
          ].includes(String(detail.reason)),
      )
    );
  } catch {
    return false;
  }
}

function providerError(error: unknown, signal: AbortSignal): AiError {
  if (
    signal.aborted ||
    (record(error) &&
      ['AbortError', 'TimeoutError'].includes(String(error.name)))
  )
    return new AiError('AI_TIMEOUT');
  if (error instanceof ApiError) {
    if (
      error.status === 401 ||
      error.status === 403 ||
      (error.status === 400 && invalidKey(error))
    )
      return new AiError('AI_PROVIDER_AUTH_ERROR');
    if (error.status === 429) return new AiError('AI_PROVIDER_RATE_LIMIT');
    if (error.status === 408) return new AiError('AI_TIMEOUT');
    if (error.status >= 500) return new AiError('AI_PROVIDER_UNAVAILABLE');
    if (error.status === 404) return new AiError('AI_NOT_CONFIGURED');
    return new AiError('AI_INVALID_REQUEST');
  }
  if (error instanceof SyntaxError) return new AiError('AI_INVALID_OUTPUT');
  return new AiError('AI_PROVIDER_UNAVAILABLE');
}

@Injectable()
export class GeminiProvider implements AiProvider {
  constructor(private readonly config: AiConfig) {}

  async generateStructured(
    request: AiProviderRequest,
  ): Promise<AiProviderResult> {
    const { apiKey, provider } = this.config.requireEnabled();
    if (provider !== 'gemini') throw new AiError('AI_NOT_CONFIGURED');
    if (request.signal.aborted) throw new AiError('AI_TIMEOUT');
    let response: GenerateContentResponse;
    try {
      // Explicit API key and API backend: never fall back to ambient Google auth.
      const client = new GoogleGenAI({
        apiKey,
        vertexai: false,
        httpOptions: {
          baseUrl: 'https://generativelanguage.googleapis.com',
          retryOptions: { attempts: 1 },
        },
      });
      response = await client.models.generateContent({
        model: request.model,
        contents: [{ role: 'user', parts: [{ text: request.input }] }],
        config: {
          systemInstruction: request.systemPrompt,
          responseMimeType: 'application/json',
          responseJsonSchema: request.jsonSchema,
          candidateCount: 1,
          maxOutputTokens: 2048,
          abortSignal: request.signal,
        },
      });
    } catch (error) {
      throw providerError(error, request.signal);
    }
    if (request.signal.aborted) throw new AiError('AI_TIMEOUT');
    if (
      response.promptFeedback?.blockReason &&
      response.promptFeedback.blockReason !==
        BlockedReason.BLOCKED_REASON_UNSPECIFIED
    )
      throw new AiError('AI_REFUSED');
    const candidates = response.candidates;
    if (!candidates || !hasOneCandidate(candidates))
      throw new AiError('AI_INVALID_OUTPUT');
    const candidate = candidates[0];
    if (
      [
        'SAFETY',
        'RECITATION',
        'BLOCKLIST',
        'PROHIBITED_CONTENT',
        'SPII',
      ].includes(candidate.finishReason ?? '')
    )
      throw new AiError('AI_REFUSED');
    if (
      candidate.finishReason !== FinishReason.STOP ||
      candidate.content?.role !== 'model'
    )
      throw new AiError('AI_INVALID_OUTPUT');
    // Avoid SDK text getter (may log non-text parts). Ignore thoughts entirely.
    if (
      !Array.isArray(candidate.content.parts) ||
      candidate.content.parts.some((part) => !record(part))
    )
      throw new AiError('AI_INVALID_OUTPUT');
    const parts = candidate.content.parts.filter((part) => !part.thought);
    if (
      !parts?.length ||
      parts.some(
        (part) =>
          typeof part.text !== 'string' ||
          Object.keys(part).some(
            (key) => !['text', 'thought', 'thoughtSignature'].includes(key),
          ),
      )
    )
      throw new AiError('AI_INVALID_OUTPUT');
    let output: unknown;
    try {
      output = JSON.parse(parts.map((part) => part.text).join(''));
    } catch {
      throw new AiError('AI_INVALID_OUTPUT');
    }
    // Schema/semantic validation remains the orchestrator's responsibility.
    const usage = response.usageMetadata
      ? {
          inputTokens: tokens(response.usageMetadata.promptTokenCount),
          outputTokens: tokens(response.usageMetadata.candidatesTokenCount),
        }
      : undefined;
    return { output, usage };
  }
}
