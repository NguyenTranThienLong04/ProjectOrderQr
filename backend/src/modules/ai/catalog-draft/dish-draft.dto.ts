import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsMongoId,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export const DISH_DRAFT_FIELDS = [
  'nameEn',
  'description',
  'descriptionEn',
] as const;
export type DishDraftField = (typeof DISH_DRAFT_FIELDS)[number];
export type DishDraftResult = Partial<Record<DishDraftField, string>>;
export const DISH_DRAFT_LIMITS = {
  nameEn: 200,
  description: 1000,
  descriptionEn: 1000,
} as const;

const normalizeText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.normalize('NFC').trim() : value;

export class DishDraftDto {
  @Transform(normalizeText)
  @IsString()
  @Matches(/\S/u)
  @MaxLength(200)
  name!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(normalizeText)
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(normalizeText)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(normalizeText)
  @IsString()
  @MaxLength(2000)
  descriptionEn?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsMongoId()
  categoryId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn(DISH_DRAFT_FIELDS, { each: true })
  generateFields!: DishDraftField[];
}
