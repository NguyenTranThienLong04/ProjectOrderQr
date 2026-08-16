import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { PromotionType } from './promotion-type.enum';

export type PromotionDocument = HydratedDocument<Promotion>;

@Schema({ timestamps: true, collection: 'promotions' })
export class Promotion {
  @Prop({ required: true, unique: true, trim: true, uppercase: true })
  code!: string;
  @Prop({ required: true, enum: PromotionType, type: String })
  type!: PromotionType;
  @Prop({ required: true, min: 0 }) value!: number;
  @Prop({ required: true, min: 0, default: 0 }) minOrderAmount!: number;
  @Prop({ required: true, type: Date }) startDate!: Date;
  @Prop({ required: true, type: Date }) endDate!: Date;
  @Prop({ required: true, default: true }) isActive!: boolean;
  @Prop({ required: true, min: 1 }) usageLimit!: number;
  @Prop({ required: true, min: 0, default: 0 }) usedCount!: number;
}

export const PromotionSchema = SchemaFactory.createForClass(Promotion);
PromotionSchema.index({ code: 1 }, { unique: true });
