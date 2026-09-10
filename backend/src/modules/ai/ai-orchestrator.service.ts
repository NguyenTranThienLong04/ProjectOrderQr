import { Inject, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AiAuditService } from './ai-audit.service';
import { AiConfig } from './ai.config';
import { AiError, normalizeAiError } from './ai.errors';
import type { AiRequest, AiResponse, AiTokenUsage } from './ai.types';
import { AiPromptRegistry } from './prompts/ai-prompt-registry.service';
import { AI_PROVIDER } from './providers/ai-provider.interface';
import type {
  AiProvider,
  AiProviderRequest,
  AiProviderResult,
} from './providers/ai-provider.interface';

@Injectable()
export class AiOrchestratorService {
  constructor(
    private readonly config: AiConfig,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly prompts: AiPromptRegistry,
    private readonly audit: AiAuditService,
  ) {}

  async generateStructured<T extends object>(
    request: AiRequest<T>,
  ): Promise<AiResponse<T>> {
    const started = performance.now();
    const metadata = this.config.metadata();
    const usage: AiTokenUsage = {};
    let attempts = 0;
    let failure: AiError | undefined;
    let result: T | undefined;
    try {
      const config = this.config.requireEnabled();
      const prompt = this.prompts.get(request.feature, request.promptVersion);
      if (
        typeof request.input !== 'string' ||
        !request.input.trim() ||
        request.input.length > 16000 ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(request.output.name) ||
        request.output.jsonSchema.type !== 'object' ||
        request.output.jsonSchema.additionalProperties !== false
      )
        throw new AiError('AI_INVALID_REQUEST');
      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        attempts++;
        try {
          const response = await this.callWithTimeout(
            {
              model: config.model,
              systemPrompt: prompt.systemPrompt,
              input: request.input,
              schemaName: request.output.name,
              jsonSchema: request.output.jsonSchema,
            },
            config.timeoutMs,
          );
          // Sum only usage actually reported, including schema-invalid attempts.
          for (const key of ['inputTokens', 'outputTokens'] as const) {
            const count = response.usage?.[key];
            if (
              typeof count === 'number' &&
              Number.isSafeInteger(count) &&
              count >= 0
            )
              usage[key] = (usage[key] ?? 0) + count;
          }
          if (
            typeof response.output !== 'object' ||
            response.output === null ||
            Array.isArray(response.output)
          )
            throw new AiError('AI_INVALID_OUTPUT');
          const parsed = plainToInstance(request.output.dto, response.output, {
            enableImplicitConversion: false,
          });
          const errors = await validate(parsed, {
            whitelist: true,
            forbidNonWhitelisted: true,
            forbidUnknownValues: true,
            validationError: { target: false, value: false },
          });
          if (errors.length) throw new AiError('AI_INVALID_OUTPUT');
          request.validateResult?.(parsed);
          result = parsed;
          break;
        } catch (error) {
          const normalized = normalizeAiError(error);
          if (!normalized.retryable || attempt === config.maxRetries)
            throw normalized;
          // Small bounded exponential backoff; no immediate request storm.
          await new Promise<void>((resolve) =>
            setTimeout(resolve, 250 * 2 ** attempt),
          );
        }
      }
    } catch (error) {
      failure = normalizeAiError(error);
    }
    const recorded = await this.audit.record({
      feature: request.feature,
      ...metadata,
      promptVersion: request.promptVersion,
      latencyMs: Math.round(performance.now() - started),
      ...usage,
      fallbackUsed: Boolean(failure && request.fallbackOnError),
      success: !failure,
      errorCode: failure?.code,
      attempts,
    });
    if (failure) throw failure;
    if (!result) throw new AiError('AI_INTERNAL_ERROR');
    return {
      result,
      modelVersion: `${metadata.provider}:${metadata.model}:${request.promptVersion}`,
      fallbackUsed: false,
      ...(recorded ? {} : { warnings: ['AI_AUDIT_UNAVAILABLE'] }),
    };
  }

  private async callWithTimeout(
    request: Omit<AiProviderRequest, 'signal'>,
    timeoutMs: number,
  ): Promise<AiProviderResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        // Race also bounds test doubles/adapters that accidentally ignore abort.
        Promise.resolve().then(() =>
          this.provider.generateStructured({
            ...request,
            signal: controller.signal,
          }),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new AiError('AI_TIMEOUT'));
            controller.abort();
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
