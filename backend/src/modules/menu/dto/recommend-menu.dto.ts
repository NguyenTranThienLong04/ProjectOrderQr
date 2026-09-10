import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsObject,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
  ValidateBy,
} from 'class-validator';
import { applyDecorators } from '@nestjs/common';
import { ALLERGEN_TAGS, DIETARY_TAGS } from '../../dish/dish-metadata';

const optional = () =>
  ValidateIf((_object, value: unknown) => value !== undefined);
const terms = () =>
  applyDecorators(
    optional(),
    IsArray(),
    ArrayUnique(),
    ArrayMaxSize(12),
    IsString({ each: true }),
    MinLength(1, { each: true }),
    MaxLength(80, { each: true }),
  );
const range = (field: 'minPrice' | 'minSpiceLevel') =>
  ValidateBy({
    name: 'orderedRange',
    validator: {
      validate: (value: unknown, args) => {
        const minimum = (args?.object as RecommendationFiltersDto)?.[field];
        return (
          typeof minimum !== 'number' ||
          typeof value !== 'number' ||
          minimum <= value
        );
      },
    },
  });
export class RecommendationFiltersDto {
  @optional() @IsInt() @Min(0) @Max(1000000000) minPrice?: number;
  @optional()
  @IsInt()
  @Min(0)
  @Max(1000000000)
  @range('minPrice')
  maxPrice?: number;
  @terms() categories?: string[];
  @terms() requiredIngredients?: string[];
  @terms() excludedIngredients?: string[];
  @terms() @IsIn(ALLERGEN_TAGS, { each: true }) excludedAllergens?: string[];
  @terms() @IsIn(DIETARY_TAGS, { each: true }) requiredDietaryTags?: string[];
  @terms() @IsIn(DIETARY_TAGS, { each: true }) excludedDietaryTags?: string[];
  @optional() @IsInt() @Min(0) @Max(5) minSpiceLevel?: number;
  @optional()
  @IsInt()
  @Min(0)
  @Max(5)
  @range('minSpiceLevel')
  maxSpiceLevel?: number;
}
export class RecommendMenuDto {
  @IsMongoId() sessionId!: string;
  @IsMongoId() tableId!: string;
  @optional() @IsIn(['vi', 'en']) lang?: 'vi' | 'en';
  @optional()
  @IsObject()
  @ValidateNested()
  @Type(() => RecommendationFiltersDto)
  constraints?: RecommendationFiltersDto;
}
