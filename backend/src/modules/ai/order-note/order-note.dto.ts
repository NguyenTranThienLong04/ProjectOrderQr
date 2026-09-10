import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
} from 'class-validator';
import { DISH_MODIFIERS } from '../../dish/dish-metadata';
import type { AiOutputSchema } from '../ai.types';

export class AnalyzeOrderNoteDto {
  @IsMongoId() sessionId!: string;
  @IsMongoId() tableId!: string;
  @IsMongoId() dishId!: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/\S/u)
  @MaxLength(250)
  @ValidateBy({
    name: 'cartNoteLength',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && value.length <= 250,
    },
  })
  note!: string;
}
export class OrderNoteClassification {
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(DISH_MODIFIERS.length)
  @IsIn(DISH_MODIFIERS, { each: true })
  modifierTags!: string[];
  @IsBoolean() allergyMentioned!: boolean;
  @IsBoolean() forChildren!: boolean;
  @IsBoolean() needsStaffReview!: boolean;
}
export const ORDER_NOTE_OUTPUT: AiOutputSchema<OrderNoteClassification> = {
  name: 'order_note_v2',
  dto: OrderNoteClassification,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      modifierTags: {
        type: 'array',
        items: { type: 'string', enum: DISH_MODIFIERS },
        maxItems: DISH_MODIFIERS.length,
        uniqueItems: true,
      },
      allergyMentioned: { type: 'boolean' },
      forChildren: { type: 'boolean' },
      needsStaffReview: { type: 'boolean' },
    },
    required: [
      'modifierTags',
      'allergyMentioned',
      'forChildren',
      'needsStaffReview',
    ],
  },
};
