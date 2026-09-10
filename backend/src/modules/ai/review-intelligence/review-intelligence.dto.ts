import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsObject,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { AiOutputSchema } from '../ai.types';
import { REVIEW_SENTIMENTS, REVIEW_TOPICS } from '../../review/review-taxonomy';
import type {
  ReviewSentiment,
  ReviewTopic,
} from '../../review/review-taxonomy';

export class ReviewFilterDto {
  @ValidateIf((_o, v: unknown) => v !== undefined) @IsMongoId() dishId?: string;
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  fromDate?: string;
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  toDate?: string;
}
export class ReviewSourcesDto extends ReviewFilterDto {
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsIn(REVIEW_TOPICS)
  topic?: ReviewTopic;
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsIn(REVIEW_SENTIMENTS)
  sentiment?: ReviewSentiment;
  @Type(() => Number) @IsInt() @Min(1) @Max(10000) page = 1;
}
export class ReviewTopicOutput {
  @IsIn(REVIEW_TOPICS) topic!: ReviewTopic;
  @IsIn(REVIEW_SENTIMENTS) sentiment!: ReviewSentiment;
}
export class ReviewClassification {
  @IsIn(REVIEW_SENTIMENTS) sentiment!: ReviewSentiment;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(9)
  @ArrayUnique((item: ReviewTopicOutput) => item?.topic)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => ReviewTopicOutput)
  topics!: ReviewTopicOutput[];
}
export const reviewClassificationOutput: AiOutputSchema<ReviewClassification> =
  {
    name: 'review_classification_v1',
    dto: ReviewClassification,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sentiment: { type: 'string', enum: REVIEW_SENTIMENTS },
        topics: {
          type: 'array',
          minItems: 1,
          maxItems: 9,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              topic: { type: 'string', enum: REVIEW_TOPICS },
              sentiment: { type: 'string', enum: REVIEW_SENTIMENTS },
            },
            required: ['topic', 'sentiment'],
          },
        },
      },
      required: ['sentiment', 'topics'],
    },
  };
export function reviewSummaryOutput(
  candidates: string[],
): AiOutputSchema<{ answer: string }> {
  class Summary {
    @IsIn(candidates) answer!: string;
  }
  return {
    name: 'review_summary_v1',
    dto: Summary,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { answer: { type: 'string', enum: candidates } },
      required: ['answer'],
    },
  };
}
