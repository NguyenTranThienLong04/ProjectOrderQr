import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { DISH_MODIFIERS } from '../../modules/dish/dish-metadata';

@Schema({ _id: false })
export class OrderNoteAnalysis {
  @Prop({ required: true, maxlength: 500 })
  summary!: string;
  @Prop({ type: [String], enum: DISH_MODIFIERS, default: [] })
  modifierTags!: string[];
  @Prop({ required: true })
  allergyMentioned!: boolean;
  @Prop({ type: [String], default: [] })
  warnings!: string[];
  @Prop({ required: true, validate: (value: boolean) => value === true })
  confirmedByCustomer!: boolean;
  @Prop({ required: true })
  modelVersion!: string;
  @Prop({ required: true })
  fallbackUsed!: boolean;
}
export const OrderNoteAnalysisSchema =
  SchemaFactory.createForClass(OrderNoteAnalysis);
