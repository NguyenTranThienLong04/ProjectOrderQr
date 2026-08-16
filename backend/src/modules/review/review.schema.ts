import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ReviewDocument = HydratedDocument<Review>;

@Schema({ timestamps: true, collection: 'reviews' })
export class Review {
  @Prop({ type: Types.ObjectId, ref: 'Order', required: true })
  orderId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Dish', required: true })
  dishId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Table', required: true })
  tableId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Session', required: true })
  sessionId!: Types.ObjectId;
  @Prop({ required: true, min: 1, max: 5 }) rating!: number;
  @Prop({ trim: true, maxlength: 500 }) comment?: string;
}

export const ReviewSchema = SchemaFactory.createForClass(Review);
ReviewSchema.index({ orderId: 1, dishId: 1 }, { unique: true });
ReviewSchema.index({ dishId: 1, createdAt: -1 });
