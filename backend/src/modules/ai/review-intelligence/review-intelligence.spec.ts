import { model, Model, Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AiAuditService } from '../ai-audit.service';
import { AiOrchestratorService } from '../ai-orchestrator.service';
import { AiError } from '../ai.errors';
import { AiPromptRegistry } from '../prompts/ai-prompt-registry.service';
import { MockAiProvider, MockAiStep } from '../testing/mock-ai-provider';
import { testAiConfig } from '../testing/ai-test.fixture';
import {
  Review,
  ReviewDocument,
  ReviewSchema,
} from '../../review/review.schema';
import { REVIEW_TAXONOMY_VERSION } from '../../review/review-taxonomy';
import { REVIEW_GOLDEN } from './review.golden';
import {
  ReviewClassification,
  ReviewSourcesDto,
} from './review-intelligence.dto';
import {
  ReviewIntelligenceService,
  reviewFacts,
  reviewFilter,
  REVIEW_SMALL_SAMPLE,
} from './review-intelligence.service';

describe('Phase 22 classification, enrichment isolation and grounded summary', () => {
  const steps: MockAiStep[] = [];
  const audit = { record: jest.fn().mockResolvedValue(true) };
  const rows: { _id: Types.ObjectId; comment?: string }[] = [];
  const query = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn(),
  };
  const aggregate = { option: jest.fn().mockReturnThis(), exec: jest.fn() };
  const reviews = {
    find: jest.fn(() => query),
    updateOne: jest.fn(),
    aggregate: jest.fn(() => aggregate),
  };
  let service: ReviewIntelligenceService, provider: MockAiProvider;
  beforeEach(() => {
    jest.clearAllMocks();
    steps.length = 0;
    rows.length = 0;
    rows.push({ _id: new Types.ObjectId(), comment: REVIEW_GOLDEN[0][0] });
    query.exec.mockImplementation(() => Promise.resolve(rows));
    reviews.updateOne.mockReturnValue({
      exec: () => Promise.resolve({ modifiedCount: 1 }),
    });
    audit.record.mockResolvedValue(true);
    aggregate.exec.mockResolvedValue([
      {
        totals: [{ totalReviews: 4, commentCount: 3, averageRating: 4.25 }],
        sentiments: [{ _id: 'mixed', count: 2 }],
        topics: [{ _id: { topic: 'taste', sentiment: 'positive' }, count: 2 }],
      },
    ]);
    const prompts = new AiPromptRegistry();
    provider = new MockAiProvider(steps);
    const ai = new AiOrchestratorService(
      testAiConfig({ AI_MAX_RETRIES: '0', AI_TIMEOUT_MS: '100' }),
      provider,
      prompts,
      audit as unknown as AiAuditService,
    );
    service = new ReviewIntelligenceService(
      reviews as unknown as Model<ReviewDocument>,
      ai,
      prompts,
    );
    service.onModuleInit();
  });
  it.each(REVIEW_GOLDEN)(
    'accepts synthetic golden structured output: %s',
    async (comment, classification) => {
      rows[0].comment = comment;
      steps.push({ output: classification });
      expect(await service.analyze({})).toMatchObject({
        attempted: 1,
        analyzed: 1,
      });
      const call = reviews.updateOne.mock.calls[0] as unknown as [
        object,
        { $set: { aiInsight: object } },
        object,
      ];
      expect(call[1]).toEqual({
        $set: {
          aiInsight: {
            ...classification,
            taxonomyVersion: REVIEW_TAXONOMY_VERSION,
            modelVersion: 'openai:test-model-snapshot:review-classification-v1',
            analyzedAt: expect.any(Date) as Date,
          },
        },
      });
      expect(call[0]).toMatchObject({ comment });
      expect(call[2]).toEqual({ runValidators: true, timestamps: false });
      expect(provider.calls[0].input).toBe(JSON.stringify({ comment }));
      expect(provider.calls[0].systemPrompt).not.toContain(comment);
      expect(provider.calls[0]).not.toHaveProperty('tools');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          feature: 'review-classification',
          promptVersion: 'review-classification-v1',
          success: true,
        }),
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(comment);
    },
  );
  it.each([
    {},
    { sentiment: 'happy', topics: [] },
    {
      sentiment: 'positive',
      topics: [{ topic: 'staff', sentiment: 'positive' }],
    },
    { sentiment: 'positive', topics: [] },
    { sentiment: 'positive', topics: [null] },
    { sentiment: 'positive', topics: ['taste'] },
    {
      sentiment: 'positive',
      topics: [{ topic: 'taste', sentiment: 'positive', secret: 'x' }],
    },
    { ...REVIEW_GOLDEN[0][1], rating: 5 },
    {
      sentiment: 'positive',
      topics: [
        { topic: 'taste', sentiment: 'positive' },
        { topic: 'taste', sentiment: 'negative' },
      ],
    },
  ])(
    'rejects invalid/unknown/duplicate output without writing raw response: %j',
    async (output) => {
      steps.push({ output });
      const result = await service.analyze({});
      expect(result.outcomes[0]).toMatchObject({
        status: 'failed',
        code: 'AI_INVALID_OUTPUT',
      });
      expect(reviews.updateOne).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ success: false }),
      );
    },
  );
  it('skips rating-only comments at the database boundary without AI', async () => {
    rows.length = 0;
    expect(await service.analyze({})).toMatchObject({
      attempted: 0,
      analyzed: 0,
    });
    expect(reviews.find).toHaveBeenCalledWith(
      expect.objectContaining({ comment: { $regex: /\S/ } }),
    );
    expect(provider.calls).toHaveLength(0);
  });
  it.each(['AI_PROVIDER_UNAVAILABLE', 'AI_DISABLED', 'AI_TIMEOUT'] as const)(
    'contains %s',
    async (code) => {
      steps.push(new AiError(code));
      expect((await service.analyze({})).outcomes[0].code).toBe(code);
      expect(reviews.updateOne).not.toHaveBeenCalled();
    },
  );
  it('aborts an actual provider deadline', async () => {
    steps.push(() => new Promise(() => {}));
    expect((await service.analyze({})).outcomes[0].code).toBe('AI_TIMEOUT');
    expect(provider.calls[0].signal.aborted).toBe(true);
  });
  it('refuses overlapping in-process batches and releases the lock', async () => {
    let release!: () => void;
    steps.push(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ output: REVIEW_GOLDEN[0][1] });
        }),
    );
    const pending = service.analyze({});
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.analyze({})).rejects.toMatchObject({
      code: 'AI_RATE_LIMIT',
    });
    release();
    await pending;
    rows.length = 0;
    await expect(service.analyze({})).resolves.toMatchObject({ attempted: 0 });
  });
  it('does not overwrite a concurrently analyzed or edited review', async () => {
    steps.push({ output: REVIEW_GOLDEN[0][1] });
    reviews.updateOne.mockReturnValue({
      exec: () => Promise.resolve({ modifiedCount: 0 }),
    });
    expect((await service.analyze({})).outcomes[0].status).toBe('unchanged');
  });
  it('contains persistence failure and carries audit warning', async () => {
    steps.push({ output: REVIEW_GOLDEN[0][1] });
    audit.record.mockResolvedValue(false);
    expect((await service.analyze({})).outcomes[0].warnings).toEqual([
      'AI_AUDIT_UNAVAILABLE',
    ]);
    steps.push({ output: REVIEW_GOLDEN[0][1] });
    reviews.updateOne.mockReturnValue({
      exec: () => Promise.reject(new Error('private database details')),
    });
    expect((await service.analyze({})).outcomes[0].code).toBe(
      'AI_ANALYTICS_UNAVAILABLE',
    );
  });
  it('calculates counts/percentages with explicit analyzed denominator', () => {
    const facts = reviewFacts({
      totals: [{ totalReviews: 5, commentCount: 4, averageRating: 3.8 }],
      sentiments: [
        { _id: 'positive', count: 2 },
        { _id: 'mixed', count: 1 },
      ],
      topics: [
        { _id: { topic: 'taste', sentiment: 'positive' }, count: 2 },
        { _id: { topic: 'taste', sentiment: 'negative' }, count: 1 },
      ],
    });
    expect(facts).toMatchObject({
      totalReviews: 5,
      commentCount: 4,
      sampleSize: 3,
      analysisCoveragePercentage: 75,
      sentimentPercentages: { positive: 66.67, mixed: 33.33 },
      topics: [
        { count: 3, percentage: 100 },
        ...Array.from({ length: 8 }, () => expect.any(Object) as object),
      ],
    });
  });
  it('returns zero-safe empty facts and skips summary calls', async () => {
    aggregate.exec.mockResolvedValue([
      { totals: [], sentiments: [], topics: [] },
    ]);
    expect(await service.summary({})).toMatchObject({
      summaryStatus: 'empty',
      facts: {
        sampleSize: 0,
        averageRating: null,
        analysisCoveragePercentage: 0,
      },
    });
    expect(provider.calls).toHaveLength(0);
  });
  it('summarizes only Mongo facts with mandatory small-sample and coverage warnings', async () => {
    steps.push((req) =>
      Promise.resolve({
        output: {
          answer: (
            req.jsonSchema.properties as { answer: { enum: string[] } }
          ).answer.enum.at(-1),
        },
      }),
    );
    const result = await service.summary({});
    expect(result.summary).toContain('2/3');
    expect(result.summary).toContain(REVIEW_SMALL_SAMPLE);
    expect(result.summary).toContain('Hương vị: 2 comment');
    expect(result.summaryStatus).toBe('ready');
    expect(provider.calls[0].input).not.toContain(REVIEW_GOLDEN[0][0]);
    expect(result.modelVersion).toBe(
      'openai:test-model-snapshot:review-summary-v1',
    );
  });
  it.each([
    'Có 999 đánh giá tốt.',
    'Chín trăm người khen món.',
    'Do thiếu nhân viên nên phục vụ chậm.',
    'Hương vị: 2 tiêu cực.',
  ])('rejects ungrounded summary: %s', async (answer) => {
    steps.push({ output: { answer } });
    expect(await service.summary({})).toMatchObject({
      summaryStatus: 'unavailable',
      summary: null,
      errorCode: 'AI_INVALID_OUTPUT',
      facts: { totalReviews: 4 },
    });
  });
  it('summary provider failure preserves factual report', async () => {
    steps.push(new AiError('AI_PROVIDER_UNAVAILABLE'));
    expect(await service.summary({})).toMatchObject({
      summaryStatus: 'unavailable',
      facts: { sampleSize: 2 },
    });
  });
  it('uses same-topic sentiment in source drill-down and omits session ownership', async () => {
    aggregate.exec.mockResolvedValue([{ total: [], reviews: [] }]);
    await service.sources(
      Object.assign(new ReviewSourcesDto(), {
        topic: 'taste',
        sentiment: 'negative',
      }),
    );
    const pipeline = reviews.aggregate.mock.calls[0] as unknown as [object[]];
    expect(pipeline[0][0]).toEqual({
      $match: expect.objectContaining({
        'aiInsight.topics': {
          $elemMatch: { topic: 'taste', sentiment: 'negative' },
        },
      }) as object,
    });
    expect(JSON.stringify(pipeline)).not.toContain('sessionId');
  });
  it.each([
    { fromDate: '2026-02-30', toDate: '2026-03-01' },
    { fromDate: '2026-09-08' },
    { fromDate: '2026-09-08', toDate: '2026-08-01' },
    { fromDate: '2020-01-01', toDate: '2026-01-01' },
  ])('rejects invalid filter %j', (input) => {
    expect(() => reviewFilter(input)).toThrow(AiError);
  });
  it('casts dish/date filters and includes final UTC millisecond', () => {
    const id = new Types.ObjectId();
    expect(
      reviewFilter({
        dishId: id.toHexString(),
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
      }),
    ).toEqual({
      dishId: id,
      createdAt: {
        $gte: new Date('2026-08-01T00:00:00.000Z'),
        $lte: new Date('2026-08-31T23:59:59.999Z'),
      },
    });
  });
  it('validates nested taxonomy locally and rejects client query extensions', async () => {
    expect(
      await validate(
        plainToInstance(ReviewClassification, REVIEW_GOLDEN[0][1]),
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(ReviewSourcesDto, {
          topic: 'secret',
          page: 0,
          pipeline: [],
        }),
        { whitelist: true, forbidNonWhitelisted: true },
      ),
    ).toHaveLength(3);
  });
  it('old Review documents validate without optional insight', async () => {
    const ReviewModel = model<Review>('ReviewPhase22Legacy', ReviewSchema);
    const review = new ReviewModel({
      orderId: new Types.ObjectId(),
      dishId: new Types.ObjectId(),
      tableId: new Types.ObjectId(),
      sessionId: new Types.ObjectId(),
      rating: 5,
    });
    await expect(review.validate()).resolves.toBeUndefined();
    expect(review.toObject()).not.toHaveProperty('aiInsight');
  });
});
