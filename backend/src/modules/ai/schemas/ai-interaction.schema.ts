import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type AiInteractionDocument = HydratedDocument<AiInteraction>;

@Schema({
  collection: 'ai_interactions',
  versionKey: false,
  bufferCommands: false,
  strict: 'throw',
})
export class AiInteraction {
  @Prop({ required: true, maxlength: 128 }) feature!: string;
  @Prop({ required: true, maxlength: 128 }) provider!: string;
  @Prop({ required: true, maxlength: 128 }) model!: string;
  @Prop({ required: true, maxlength: 128 }) promptVersion!: string;
  @Prop({ required: true, min: 0 }) latencyMs!: number;
  @Prop({ min: 0 }) inputTokens?: number;
  @Prop({ min: 0 }) outputTokens?: number;
  @Prop({ required: true }) fallbackUsed!: boolean;
  @Prop({ required: true }) success!: boolean;
  @Prop({ maxlength: 64 }) errorCode?: string;
  @Prop({ required: true, min: 0, max: 3 }) attempts!: number;
  @Prop({ required: true, default: Date.now }) createdAt!: Date;
}

export const AiInteractionSchema = SchemaFactory.createForClass(AiInteraction);
AiInteractionSchema.index({ feature: 1, createdAt: -1 });
AiInteractionSchema.index({ success: 1, createdAt: -1 });
