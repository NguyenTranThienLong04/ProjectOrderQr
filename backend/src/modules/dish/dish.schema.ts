import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  ALLERGEN_TAGS,
  DIETARY_TAGS,
  DISH_METADATA_OPTIONS,
  DISH_MODIFIERS,
  consistentDietaryTags,
} from './dish-metadata';

const uniqueBounded = (limit: number) => ({
  validator: (values: string[]) =>
    Array.isArray(values) &&
    values.length <= limit &&
    new Set(values).size === values.length,
  message: 'Metadata phải là danh sách không trùng, trong giới hạn cho phép',
});

export type DishDocument = HydratedDocument<Dish>;

@Schema({ timestamps: true, collection: 'dishes' })
export class Dish {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true })
  nameEn?: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ trim: true, maxlength: DISH_METADATA_OPTIONS.limits.descriptionEn })
  descriptionEn?: string;

  @Prop({
    type: [
      {
        type: String,
        trim: true,
        minlength: 1,
        maxlength: DISH_METADATA_OPTIONS.limits.ingredientLength,
      },
    ],
    default: [],
    castNonArrays: false,
    validate: uniqueBounded(DISH_METADATA_OPTIONS.limits.ingredients),
  })
  ingredients!: string[];

  /** An empty list means no recorded tags, NEVER verified allergy safety. */
  @Prop({
    type: [{ type: String, enum: ALLERGEN_TAGS }],
    default: [],
    castNonArrays: false,
    validate: uniqueBounded(ALLERGEN_TAGS.length),
  })
  allergenTags!: string[];

  @Prop({
    type: [{ type: String, enum: DIETARY_TAGS }],
    default: [],
    castNonArrays: false,
    validate: [
      uniqueBounded(DIETARY_TAGS.length),
      {
        validator: consistentDietaryTags,
        message: 'Nhãn có thịt không thể đi cùng nhãn chay',
      },
    ],
  })
  dietaryTags!: string[];

  @Prop({
    type: Number,
    min: 0,
    max: 5,
    validate: {
      validator: (value: number | null) =>
        value == null || Number.isInteger(value),
      message: 'Độ cay phải là số nguyên từ 0 đến 5',
    },
  })
  spiceLevel?: number | null;

  @Prop({ trim: true, maxlength: DISH_METADATA_OPTIONS.limits.servingSize })
  servingSize?: string;

  @Prop({
    type: [{ type: String, enum: DISH_MODIFIERS }],
    default: [],
    castNonArrays: false,
    validate: uniqueBounded(DISH_MODIFIERS.length),
  })
  availableModifiers!: string[];

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
