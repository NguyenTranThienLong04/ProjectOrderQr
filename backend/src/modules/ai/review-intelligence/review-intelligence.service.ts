import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import { Review, ReviewDocument } from '../../review/review.schema';
import {
  REVIEW_SENTIMENTS,
  REVIEW_TAXONOMY_VERSION,
  REVIEW_TOPICS,
  REVIEW_TOPIC_LABELS,
  ReviewSentiment,
  ReviewTopic,
} from '../../review/review-taxonomy';
import { AiOrchestratorService } from '../ai-orchestrator.service';
import { AiError } from '../ai.errors';
import { AiPromptRegistry } from '../prompts/ai-prompt-registry.service';
import {
  REVIEW_CLASSIFICATION_PROMPT,
  REVIEW_SUMMARY_PROMPT,
} from '../prompts/review.prompt';
import { dateRange } from '../admin-analytics/analytics-period';
import {
  ReviewFilterDto,
  ReviewSourcesDto,
  reviewClassificationOutput,
  reviewSummaryOutput,
} from './review-intelligence.dto';

export const REVIEW_MIN_SAMPLE = 10;
export const REVIEW_BATCH_SIZE = 5;
export const REVIEW_SMALL_SAMPLE =
  'Chưa đủ dữ liệu để kết luận xu hướng đáng tin cậy (cần ít nhất 10 comment đã phân tích).';
const hasComment = { $regex: /\S/ };
const analyzed = {
  comment: hasComment,
  'aiInsight.taxonomyVersion': REVIEW_TAXONOMY_VERSION,
};
const percent = (count: number, total: number) =>
  total ? Math.round((count / total) * 10000) / 100 : 0;
const sentimentCounts = () =>
  Object.fromEntries(REVIEW_SENTIMENTS.map((s) => [s, 0])) as Record<
    ReviewSentiment,
    number
  >;
interface AggregateResult {
  totals: {
    totalReviews: number;
    commentCount: number;
    averageRating: number;
  }[];
  sentiments: { _id: ReviewSentiment; count: number }[];
  topics: {
    _id: { topic: ReviewTopic; sentiment: ReviewSentiment };
    count: number;
  }[];
}
export function reviewFilter(input: ReviewFilterDto): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (input.dishId) match.dishId = new Types.ObjectId(input.dishId);
  if (input.fromDate !== undefined || input.toDate !== undefined) {
    if (!input.fromDate || !input.toDate)
      throw new AiError('AI_INVALID_REQUEST');
    const range = dateRange(input.fromDate, input.toDate);
    match.createdAt = { $gte: new Date(range.from), $lte: new Date(range.to) };
  }
  return match;
}
export function reviewFacts(row: AggregateResult) {
  const totals = row.totals[0] ?? {
    totalReviews: 0,
    commentCount: 0,
    averageRating: null,
  };
  const sentiments = sentimentCounts();
  for (const entry of row.sentiments)
    if (REVIEW_SENTIMENTS.includes(entry._id))
      sentiments[entry._id] = entry.count;
  const sampleSize = Object.values(sentiments).reduce(
    (sum, count) => sum + count,
    0,
  );
  const topics = REVIEW_TOPICS.map((topic) => {
    const counts = sentimentCounts();
    for (const entry of row.topics)
      if (
        entry._id.topic === topic &&
        REVIEW_SENTIMENTS.includes(entry._id.sentiment)
      )
        counts[entry._id.sentiment] += entry.count;
    const count = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return {
      topic,
      label: REVIEW_TOPIC_LABELS[topic],
      count,
      percentage: percent(count, sampleSize),
      sentiments: counts,
    };
  });
  return {
    ...totals,
    analyzedCommentCount: sampleSize,
    sampleSize,
    analysisCoveragePercentage: percent(sampleSize, totals.commentCount),
    sentimentCounts: sentiments,
    sentimentPercentages: Object.fromEntries(
      REVIEW_SENTIMENTS.map((s) => [s, percent(sentiments[s], sampleSize)]),
    ),
    topics,
    minimumSample: REVIEW_MIN_SAMPLE,
    percentageDenominator: 'analyzedCommentCount' as const,
  };
}
export function reviewSummaryCandidates(
  facts: ReturnType<typeof reviewFacts>,
  warnings: string[],
) {
  const base = `Đã phân tích ${facts.sampleSize}/${facts.commentCount} comment trong ${facts.totalReviews} đánh giá.`;
  const themes = facts.topics
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
    .slice(0, 3)
    .map(
      (t) =>
        `${t.label}: ${t.count} comment đề cập, ${t.sentiments.positive} tích cực và ${t.sentiments.negative} tiêu cực.`,
    )
    .join(' ');
  const suffix = `${warnings.join(' ')} Dữ liệu này không xác định nguyên nhân hoặc chứng minh xu hướng.`;
  return [...new Set([`${base} ${suffix}`, `${base} ${themes} ${suffix}`])];
}

@Injectable()
export class ReviewIntelligenceService implements OnModuleInit {
  private batchRunning = false;
  constructor(
    @InjectModel(Review.name) private readonly reviews: Model<ReviewDocument>,
    private readonly ai: AiOrchestratorService,
    private readonly prompts: AiPromptRegistry,
  ) {}
  onModuleInit() {
    this.prompts.register(REVIEW_CLASSIFICATION_PROMPT);
    this.prompts.register(REVIEW_SUMMARY_PROMPT);
  }

  async analyze(input: ReviewFilterDto) {
    const match = reviewFilter(input);
    if (this.batchRunning) throw new AiError('AI_RATE_LIMIT');
    this.batchRunning = true;
    try {
      const reviews = await this.reviews
        .find({
          ...match,
          comment: hasComment,
          'aiInsight.taxonomyVersion': { $ne: REVIEW_TAXONOMY_VERSION },
        })
        .sort({ _id: 1 })
        .limit(REVIEW_BATCH_SIZE)
        .select('_id comment')
        .lean()
        .exec();
      // Bounded enrichment only. ReviewService never imports or waits for AI.
      const outcomes = await Promise.all(
        reviews.map(async (review) => {
          try {
            const response = await this.ai.generateStructured({
              ...REVIEW_CLASSIFICATION_PROMPT,
              input: JSON.stringify({ comment: review.comment }),
              output: reviewClassificationOutput,
            });
            // Compare original text/version: concurrent batches cannot overwrite a newer insight.
            const saved = await this.reviews
              .updateOne(
                {
                  _id: review._id,
                  comment: review.comment,
                  'aiInsight.taxonomyVersion': { $ne: REVIEW_TAXONOMY_VERSION },
                },
                {
                  $set: {
                    aiInsight: {
                      ...response.result,
                      taxonomyVersion: REVIEW_TAXONOMY_VERSION,
                      modelVersion: response.modelVersion,
                      analyzedAt: new Date(),
                    },
                  },
                },
                { runValidators: true, timestamps: false },
              )
              .exec();
            return {
              reviewId: review._id.toString(),
              status: saved.modifiedCount ? 'analyzed' : 'unchanged',
              warnings: response.warnings ?? [],
            };
          } catch (error) {
            return {
              reviewId: review._id.toString(),
              status: 'failed',
              code:
                error instanceof AiError
                  ? error.code
                  : 'AI_ANALYTICS_UNAVAILABLE',
              warnings: [],
            };
          }
        }),
      );
      return {
        attempted: reviews.length,
        analyzed: outcomes.filter((o) => o.status === 'analyzed').length,
        outcomes,
        batchSize: REVIEW_BATCH_SIZE,
      };
    } catch (error) {
      if (error instanceof AiError) throw error;
      throw new AiError('AI_ANALYTICS_UNAVAILABLE');
    } finally {
      this.batchRunning = false;
    }
  }

  async insights(input: ReviewFilterDto) {
    const match = reviewFilter(input);
    // One facet keeps denominators, ratings and classifications in the same Mongo read.
    const pipeline: PipelineStage[] = [
      { $match: match },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalReviews: { $sum: 1 },
                commentCount: {
                  $sum: {
                    $cond: [
                      {
                        $regexMatch: {
                          input: { $ifNull: ['$comment', ''] },
                          regex: /\S/,
                        },
                      },
                      1,
                      0,
                    ],
                  },
                },
                averageRating: { $avg: '$rating' },
              },
            },
            {
              $project: {
                _id: 0,
                totalReviews: 1,
                commentCount: 1,
                averageRating: { $round: ['$averageRating', 2] },
              },
            },
          ],
          sentiments: [
            { $match: analyzed },
            { $group: { _id: '$aiInsight.sentiment', count: { $sum: 1 } } },
          ],
          topics: [
            { $match: analyzed },
            { $unwind: '$aiInsight.topics' },
            {
              $group: {
                _id: {
                  topic: '$aiInsight.topics.topic',
                  sentiment: '$aiInsight.topics.sentiment',
                },
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ];
    try {
      const [row] = await this.reviews
        .aggregate<AggregateResult>(pipeline)
        .option({ maxTimeMS: 10000 })
        .exec();
      const facts = reviewFacts(row);
      const warnings: string[] = [];
      if (facts.sampleSize < REVIEW_MIN_SAMPLE)
        warnings.push(REVIEW_SMALL_SAMPLE);
      if (facts.sampleSize < facts.commentCount)
        warnings.push(
          'Chỉ một phần comment đã được phân tích; kết quả có thể chưa đại diện cho toàn bộ đánh giá.',
        );
      return {
        facts,
        warnings,
        taxonomyVersion: REVIEW_TAXONOMY_VERSION,
        filters: { ...input, timezone: 'UTC' },
        generatedAt: new Date().toISOString(),
      };
    } catch {
      throw new AiError('AI_ANALYTICS_UNAVAILABLE');
    }
  }

  async summary(input: ReviewFilterDto) {
    const report = await this.insights(input);
    if (!report.facts.sampleSize)
      return {
        ...report,
        summary: null,
        modelVersion: null,
        summaryStatus: 'empty' as const,
      };
    try {
      const response = await this.ai.generateStructured({
        ...REVIEW_SUMMARY_PROMPT,
        input: JSON.stringify({
          facts: report.facts,
          warnings: report.warnings,
        }),
        output: reviewSummaryOutput(
          reviewSummaryCandidates(report.facts, report.warnings),
        ),
      });
      return {
        ...report,
        summary: response.result.answer,
        modelVersion: response.modelVersion,
        summaryStatus: 'ready' as const,
        warnings: [...report.warnings, ...(response.warnings ?? [])],
      };
    } catch (error) {
      return {
        ...report,
        summary: null,
        modelVersion: null,
        summaryStatus: 'unavailable' as const,
        errorCode: error instanceof AiError ? error.code : 'AI_INTERNAL_ERROR',
      };
    }
  }

  async sources(input: ReviewSourcesDto) {
    const match = reviewFilter(input);
    if (input.topic || input.sentiment) {
      Object.assign(match, analyzed);
      if (input.topic)
        match['aiInsight.topics'] = {
          $elemMatch: {
            topic: input.topic,
            ...(input.sentiment ? { sentiment: input.sentiment } : {}),
          },
        };
      else match['aiInsight.sentiment'] = input.sentiment;
    }
    try {
      const [result] = await this.reviews
        .aggregate<{
          total: { count: number }[];
          reviews: Record<string, unknown>[];
        }>([
          { $match: match },
          {
            $facet: {
              total: [{ $count: 'count' }],
              reviews: [
                { $sort: { createdAt: -1, _id: -1 } },
                { $skip: (input.page - 1) * 20 },
                { $limit: 20 },
                {
                  $project: {
                    _id: 1,
                    dishId: 1,
                    rating: 1,
                    comment: 1,
                    createdAt: 1,
                    aiInsight: 1,
                  },
                },
              ],
            },
          },
        ])
        .option({ maxTimeMS: 10000 })
        .exec();
      return {
        reviews: result.reviews,
        total: result.total[0]?.count ?? 0,
        page: input.page,
        pageSize: 20,
        taxonomyVersion: REVIEW_TAXONOMY_VERSION,
      };
    } catch {
      throw new AiError('AI_ANALYTICS_UNAVAILABLE');
    }
  }
}
