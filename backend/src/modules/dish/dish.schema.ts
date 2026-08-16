import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DishDocument = HydratedDocument<Dish>;

@Schema({ timestamps: true, collection: 'dishes' })
export class Dish {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true })
  nameEn?: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ required: true, min: 0 })
  price!: number;

  @Prop()
  imageUrl?: string;

  @Prop({ type: Types.ObjectId, ref: 'Category', required: true })
  categoryId!: Types.ObjectId;

  @Prop({ default: true })
  isAvailable!: boolean;
}

export const DishSchema = SchemaFactory.createForClass(Dish);

DishSchema.index({ categoryId: 1, isAvailable: 1 });
DishSchema.index({ name: 'text' });
