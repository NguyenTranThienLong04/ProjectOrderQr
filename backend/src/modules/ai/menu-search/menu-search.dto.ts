import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import { ALLERGEN_TAGS, DIETARY_TAGS } from '../../dish/dish-metadata';
import type { AiOutputSchema } from '../ai.types';

export class SearchMenuDto {
  @IsMongoId() tableId!: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/\S/u)
  @MaxLength(500)
  @ValidateBy({
    name: 'queryLength',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && value.length <= 500,
    },
  })
  query!: string;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['vi', 'en'])
  lang?: 'vi' | 'en';
}

const terms = () =>
  applyDecorators(
    IsArray(),
    ArrayUnique(),
    ArrayMaxSize(12),
    IsString({ each: true }),
    MinLength(1, { each: true }),
    MaxLength(80, { each: true }),
    Matches(/\S/u, { each: true }),
  );
const range = (field: 'minPrice' | 'minSpiceLevel') =>
  ValidateBy({
    name: 'orderedRange',
    validator: {
      validate: (value: unknown, args) => {
        const minimum = (args?.object as MenuSearchIntent | undefined)?.[field];
        return (
          typeof minimum !== 'number' ||
          typeof value !== 'number' ||
          minimum <= value
        );
      },
    },
  });
export class MenuSearchIntent {
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsInt()
  @Min(0)
  @Max(1000000000)
  minPrice!: number | null;
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsInt()
  @Min(0)
  @Max(1000000000)
  @range('minPrice')
  maxPrice!: number | null;
  @terms() categories!: string[];
  @terms() requiredIngredients!: string[];
  @terms() excludedIngredients!: string[];
  @terms() @IsIn(DIETARY_TAGS, { each: true }) requiredDietaryTags!: string[];
  @terms() @IsIn(DIETARY_TAGS, { each: true }) excludedDietaryTags!: string[];
  @terms() @IsIn(ALLERGEN_TAGS, { each: true }) excludedAllergens!: string[];
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsInt()
  @Min(0)
  @Max(5)
  minSpiceLevel!: number | null;
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsInt()
  @Min(0)
  @Max(5)
  @range('minSpiceLevel')
  maxSpiceLevel!: number | null;
  @terms() keywords!: string[];
  @terms()
  @IsIn(['medical', 'nutrition', 'other'], { each: true })
  unsupportedCriteria!: string[];
}
const stringArray = (values?: readonly string[]) => ({
  type: 'array',
  maxItems: 12,
  uniqueItems: true,
  items: {
    type: 'string',
    minLength: 1,
    maxLength: 80,
    ...(values ? { enum: values } : {}),
  },
});
const properties = {
  minPrice: { type: ['integer', 'null'], minimum: 0, maximum: 1000000000 },
  maxPrice: { type: ['integer', 'null'], minimum: 0, maximum: 1000000000 },
  categories: stringArray(),
  requiredIngredients: stringArray(),
  excludedIngredients: stringArray(),
  requiredDietaryTags: stringArray(DIETARY_TAGS),
  excludedDietaryTags: stringArray(DIETARY_TAGS),
  excludedAllergens: stringArray(ALLERGEN_TAGS),
  minSpiceLevel: { type: ['integer', 'null'], minimum: 0, maximum: 5 },
  maxSpiceLevel: { type: ['integer', 'null'], minimum: 0, maximum: 5 },
  keywords: stringArray(),
  unsupportedCriteria: stringArray(['medical', 'nutrition', 'other']),
};
export const MENU_SEARCH_OUTPUT: AiOutputSchema<MenuSearchIntent> = {
  name: 'menu_search_v1',
  dto: MenuSearchIntent,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  },
};
