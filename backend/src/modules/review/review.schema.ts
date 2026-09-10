import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { REVIEW_SENTIMENTS, REVIEW_TOPICS } from './review-taxonomy';
import type { ReviewSentiment, ReviewTopic } from './review-taxonomy';

@Schema({ _id: false })
export class ReviewTopicInsight {
  @Prop({ type: String, enum: REVIEW_TOPICS, required: true })
  topic!: ReviewTopic;
  @Prop({ type: String, enum: REVIEW_SENTIMENTS, required: true })
  sentiment!: ReviewSentiment;
}
@Schema({ _id: false })
export class ReviewAiInsight {
  @Prop({ type: String, enum: REVIEW_SENTIMENTS, required: true })
  sentiment!: ReviewSentiment;
  @Prop({
    type: [SchemaFactory.createForClass(ReviewTopicInsight)],
    required: true,
  })
  topics!: ReviewTopicInsight[];
  @Prop({ required: true }) taxonomyVersion!: string;
  @Prop({ required: true }) modelVersion!: string;
  @Prop({ required: true }) analyzedAt!: Date;
}

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
  @Prop({
    type: SchemaFactory.createForClass(ReviewAiInsight),
    default: undefined,
  })
  aiInsight?: ReviewAiInsight;
}

export const ReviewSchema = SchemaFactory.createForClass(Review);
ReviewSchema.index({ orderId: 1, dishId: 1 }, { unique: true });
ReviewSchema.index({ dishId: 1, createdAt: -1 });
ReviewSchema.index({ createdAt: -1, _id: -1 });
