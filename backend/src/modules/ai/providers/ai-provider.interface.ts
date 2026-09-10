import type { AiTokenUsage } from '../ai.types';

export const AI_PROVIDER = Symbol('AI_PROVIDER');

export interface AiProviderRequest {
  model: string;
  systemPrompt: string;
  input: string;
  schemaName: string;
  jsonSchema: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export interface AiProviderResult {
  // Unknown until the orchestrator validates it; vendors cannot assert T.
  output: unknown;
  usage?: AiTokenUsage;
}

export interface AiProvider {
  generateStructured(request: AiProviderRequest): Promise<AiProviderResult>;
}
