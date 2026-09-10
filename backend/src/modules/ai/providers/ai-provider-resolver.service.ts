import { Injectable } from '@nestjs/common';
import { AiConfig } from '../ai.config';
import type { AiProvider, AiProviderRequest } from './ai-provider.interface';
import { GeminiProvider } from './gemini-provider.service';
import { OpenAiProvider } from './openai-provider.service';
import { GroqProvider } from './groq-provider.service';
import { AiError } from '../ai.errors';

@Injectable()
export class AiProviderResolver implements AiProvider {
  constructor(
    private readonly config: AiConfig,
    private readonly openai: OpenAiProvider,
    private readonly gemini: GeminiProvider,
    private readonly groq: GroqProvider,
  ) {}

  // Resolve lazily: disabled/misconfigured AI must not prevent core startup.
  resolve(): AiProvider {
    const { provider } = this.config.requireEnabled();
    switch (provider) {
      case 'openai':
        return this.openai;
      case 'gemini':
        return this.gemini;
      case 'groq':
        return this.groq;
      default:
        throw new AiError('AI_NOT_CONFIGURED');
    }
  }

  generateStructured(request: AiProviderRequest) {
    return this.resolve().generateStructured(request);
  }
}
