import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import {
  ALLERGEN_TAGS,
  DIETARY_TAGS,
  DISH_METADATA_OPTIONS,
  DISH_MODIFIERS,
  consistentDietaryTags,
  parseMetadataArray,
  parseSpiceLevel,
  trimMetadata,
} from '../dish-metadata';

/** No defaults here: a partial edit must not erase existing metadata. */
export class DishMetadataDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => trimMetadata(value))
  @IsString()
  @MaxLength(DISH_METADATA_OPTIONS.limits.descriptionEn)
  descriptionEn?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => parseMetadataArray(value))
  @IsArray()
  @ArrayMaxSize(DISH_METADATA_OPTIONS.limits.ingredients)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(DISH_METADATA_OPTIONS.limits.ingredientLength, { each: true })
  ingredients?: string[];

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => parseMetadataArray(value))
  @IsArray()
  @ArrayMaxSize(ALLERGEN_TAGS.length)
  @ArrayUnique()
  @IsIn(ALLERGEN_TAGS, { each: true })
  allergenTags?: string[];

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => parseMetadataArray(value))
  @IsArray()
  @ArrayMaxSize(DIETARY_TAGS.length)
  @ArrayUnique()
  @IsIn(DIETARY_TAGS, { each: true })
  @ValidateBy({
    name: 'consistentDietaryTags',
    validator: {
      validate: consistentDietaryTags,
      defaultMessage: () => 'Nhãn có thịt không thể đi cùng nhãn chay',
    },
  })
  dietaryTags?: string[];

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseSpiceLevel(value))
  @IsInt()
  @Min(0)
  @Max(5)
  spiceLevel?: number | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => trimMetadata(value))
  @IsString()
  @MaxLength(DISH_METADATA_OPTIONS.limits.servingSize)
  servingSize?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => parseMetadataArray(value))
  @IsArray()
  @ArrayMaxSize(DISH_MODIFIERS.length)
  @ArrayUnique()
  @IsIn(DISH_MODIFIERS, { each: true })
  availableModifiers?: string[];
}
