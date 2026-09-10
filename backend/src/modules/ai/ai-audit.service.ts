import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { safeAiLabel, safeAiModelLabel } from './ai.config';
import type { AiErrorCode } from './ai.errors';
import { AiInteraction } from './schemas/ai-interaction.schema';

export interface AiAuditEntry {
  feature: string;
  provider: string;
  model: string;
  promptVersion: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  fallbackUsed: boolean;
  success: boolean;
  errorCode?: AiErrorCode;
  attempts: number;
}

@Injectable()
export class AiAuditService {
  private readonly logger = new Logger(AiAuditService.name);

  constructor(
    @InjectModel(AiInteraction.name)
    private readonly model: Model<AiInteraction>,
  ) {}

  async record(entry: AiAuditEntry): Promise<boolean> {
    try {
      // Explicit allowlist: never spread an input/request/provider object here.
      const document = new this.model({
        feature: safeAiLabel(entry.feature),
        provider: safeAiLabel(entry.provider),
        model: safeAiModelLabel(entry.model),
        promptVersion: safeAiLabel(entry.promptVersion),
        latencyMs: entry.latencyMs,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        fallbackUsed: entry.fallbackUsed,
        success: entry.success,
        errorCode: entry.errorCode,
        attempts: entry.attempts,
      });
      await document.validate();
      // Driver CSOT bounds selection + write; buffering is disabled on this schema.
      await this.model.collection.insertOne(document.toObject(), {
        timeoutMS: 1500,
      });
      return true;
    } catch {
      this.logger.warn('AI_AUDIT_WRITE_FAILED');
      return false;
    }
  }
}
