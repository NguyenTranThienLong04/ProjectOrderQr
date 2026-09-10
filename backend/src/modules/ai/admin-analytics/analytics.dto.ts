import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { AiOutputSchema } from '../ai.types';

export class AnalyticsQueryDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  query!: string;

  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  fromDate?: string;

  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  toDate?: string;
}

export const METRICS = [
  'revenue',
  'orders',
  'averageOrderValue',
  'topDishes',
  'topRatedDishes',
  'ratingSummary',
  'unsupported',
] as const;
export const PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_year',
  'custom',
  'selected',
] as const;
export class AnalyticsPeriodIntent {
  @IsIn(PERIODS) preset!: (typeof PERIODS)[number];
  @IsString() @MaxLength(10) from!: string;
  @IsString() @MaxLength(10) to!: string;
}
export class AnalyticsIntent {
  @IsIn(METRICS) metric!: (typeof METRICS)[number];
  @IsIn(['value', 'compare']) operation!: 'value' | 'compare';
  @IsObject()
  @ValidateNested()
  @Type(() => AnalyticsPeriodIntent)
  currentPeriod!: AnalyticsPeriodIntent;
  @IsObject()
  @ValidateNested()
  @Type(() => AnalyticsPeriodIntent)
  comparisonPeriod!: AnalyticsPeriodIntent;
  @IsInt() @Min(1) @Max(10) limit!: number;
}
const periodSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    preset: { type: 'string', enum: PERIODS },
    from: { type: 'string', maxLength: 10 },
    to: { type: 'string', maxLength: 10 },
  },
  required: ['preset', 'from', 'to'],
};
export const analyticsIntentOutput: AiOutputSchema<AnalyticsIntent> = {
  name: 'admin_analytics_intent',
  dto: AnalyticsIntent,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      metric: { type: 'string', enum: METRICS },
      operation: { type: 'string', enum: ['value', 'compare'] },
      currentPeriod: periodSchema,
      comparisonPeriod: periodSchema,
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: [
      'metric',
      'operation',
      'currentPeriod',
      'comparisonPeriod',
      'limit',
    ],
  },
};

// Constrained realization: the model chooses an evidence-backed business explanation.
// Exact enum validation also rejects spelled-out numbers, swapped metrics and invented causes.
export function analyticsAnswerOutput(
  answers: string[],
): AiOutputSchema<{ answer: string }> {
  class GroundedAnswer {
    @IsString() @IsIn(answers) answer!: string;
  }
  return {
    name: 'admin_analytics_answer',
    dto: GroundedAnswer,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { answer: { type: 'string', enum: answers } },
      required: ['answer'],
    },
  };
}
