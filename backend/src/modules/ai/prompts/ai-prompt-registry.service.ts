import { Injectable } from '@nestjs/common';
import { safeAiLabel } from '../ai.config';
import { AiError } from '../ai.errors';

export interface AiPrompt {
  feature: string;
  promptVersion: string;
  systemPrompt: string;
}

@Injectable()
export class AiPromptRegistry {
  private readonly prompts = new Map<string, Readonly<AiPrompt>>();

  /** Register server-owned prompts at module initialization, never from HTTP input. */
  register(prompt: AiPrompt): void {
    const key = `${prompt.feature}:${prompt.promptVersion}`;
    if (
      safeAiLabel(prompt.feature) === 'unknown' ||
      safeAiLabel(prompt.promptVersion) === 'unknown' ||
      !prompt.systemPrompt.trim() ||
      this.prompts.has(key)
    )
      throw new AiError('AI_INVALID_REQUEST');
    this.prompts.set(key, Object.freeze({ ...prompt }));
  }

  get(feature: string, version: string): Readonly<AiPrompt> {
    const prompt = this.prompts.get(`${feature}:${version}`);
    if (!prompt) throw new AiError('AI_UNSUPPORTED_FEATURE');
    return prompt;
  }
}
