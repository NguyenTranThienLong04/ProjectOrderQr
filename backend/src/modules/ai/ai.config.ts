import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiError } from './ai.errors';

export const AI_PROVIDER_SETTINGS = {
  openai: { apiKey: 'AI_API_KEY', model: 'AI_MODEL' },
  gemini: { apiKey: 'GEMINI_API_KEY', model: 'GEMINI_MODEL' },
  groq: { apiKey: 'GROQ_API_KEY', model: 'GROQ_MODEL' },
} as const;
export type AiProviderType = keyof typeof AI_PROVIDER_SETTINGS;
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';

export function safeAiModelLabel(value: unknown): string {
  return typeof value === 'string' &&
    value.length <= 128 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(value)
    ? value
    : 'unknown';
}

export function safeAiLabel(value: unknown): string {
  return typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
    ? value
    : 'unknown';
}

@Injectable()
export class AiConfig {
  constructor(private readonly config: ConfigService) {}

  metadata() {
    const selected = this.config.get<string>('AI_PROVIDER');
    const provider: AiProviderType | 'unknown' =
      selected === 'openai' || selected === 'gemini' || selected === 'groq'
        ? selected
        : 'unknown';
    const model =
      provider === 'unknown'
        ? undefined
        : (this.config.get<string>(AI_PROVIDER_SETTINGS[provider].model) ??
          (provider === 'groq' ? DEFAULT_GROQ_MODEL : undefined));
    return {
      provider,
      model: provider === 'groq' ? safeAiModelLabel(model) : safeAiLabel(model),
    };
  }

  // Lazy validation deliberately never prevents core application startup.
  requireEnabled() {
    const enabled = this.config.get<string>('AI_ENABLED') ?? 'false';
    if (enabled === 'false') throw new AiError('AI_DISABLED');
    if (enabled !== 'true') throw new AiError('AI_NOT_CONFIGURED');
    const { provider, model } = this.metadata();
    const apiKey =
      provider === 'unknown'
        ? undefined
        : this.config
            .get<string>(AI_PROVIDER_SETTINGS[provider].apiKey)
            ?.trim();
    if (
      provider === 'unknown' ||
      model === 'unknown' ||
      !apiKey ||
      apiKey.startsWith('<')
    )
      throw new AiError('AI_NOT_CONFIGURED');
    return {
      provider,
      model,
      apiKey,
      timeoutMs: this.integer('AI_TIMEOUT_MS', 10000, 100, 60000),
      maxRetries: this.integer('AI_MAX_RETRIES', 1, 0, 2),
    };
  }

  private integer(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const raw = this.config.get<string>(key);
    const value = raw === undefined ? fallback : Number(raw);
    if (
      raw?.trim() === '' ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    )
      throw new AiError('AI_NOT_CONFIGURED');
    return value;
  }
}
