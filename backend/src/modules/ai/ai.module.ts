import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AiConfig } from './ai.config';
import { AiAuditService } from './ai-audit.service';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { AiPromptRegistry } from './prompts/ai-prompt-registry.service';
import { AI_PROVIDER } from './providers/ai-provider.interface';
import { OpenAiProvider } from './providers/openai-provider.service';
import { GeminiProvider } from './providers/gemini-provider.service';
import { GroqProvider } from './providers/groq-provider.service';
import { AiProviderResolver } from './providers/ai-provider-resolver.service';
import {
  AiInteraction,
  AiInteractionSchema,
} from './schemas/ai-interaction.schema';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: AiInteraction.name, schema: AiInteractionSchema },
    ]),
  ],
  providers: [
    AiConfig,
    AiAuditService,
    AiOrchestratorService,
    AiPromptRegistry,
    OpenAiProvider,
    GeminiProvider,
    GroqProvider,
    { provide: AI_PROVIDER, useClass: AiProviderResolver },
  ],
  exports: [AiOrchestratorService, AiPromptRegistry],
})
export class AiModule {}
