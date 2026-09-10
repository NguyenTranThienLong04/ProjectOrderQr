import type { ClassConstructor } from 'class-transformer';

export interface AiOutputSchema<T extends object> {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  /** Local class-validator DTO. Keep constraints aligned with jsonSchema. */
  readonly dto: ClassConstructor<T>;
}

export interface AiRequest<T extends object> {
  feature: string;
  promptVersion: string;
  input: string;
  output: AiOutputSchema<T>;
  /** Server-owned semantic validation, before a successful audit is recorded. */
  validateResult?: (result: T) => void;
  /** Server-owned promise: the feature catches AI failures and supplies a fallback. */
  fallbackOnError?: boolean;
}

export interface AiResponse<T> {
  result: T;
  warnings?: string[];
  modelVersion: string;
  fallbackUsed: boolean;
  /** Only a feature with a defensible measured score may supply confidence. */
  confidence?: number;
}

export interface AiTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}
