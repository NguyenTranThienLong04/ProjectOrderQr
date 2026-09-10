import 'dotenv/config';
import * as dns from 'dns';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { ReviewIntelligenceModule } from '../src/modules/ai/review-intelligence/review-intelligence.module';
import { AdminModule } from '../src/modules/admin/admin.module';
import { AI_PROVIDER } from '../src/modules/ai/providers/ai-provider.interface';
import {
  MockAiProvider,
  MockAiStep,
} from '../src/modules/ai/testing/mock-ai-provider';
import { validAiEnv } from '../src/modules/ai/testing/ai-test.fixture';
import { AiInteraction } from '../src/modules/ai/schemas/ai-interaction.schema';
import { REVIEW_GOLDEN } from '../src/modules/ai/review-intelligence/review.golden';
import { REVIEW_TAXONOMY_VERSION } from '../src/modules/review/review-taxonomy';
import { Review } from '../src/modules/review/review.schema';
import { Order } from '../src/modules/order/order.schema';
import { OrderStatus } from '../src/common/enums/order-status.enum';
import { Dish } from '../src/modules/dish/dish.schema';
import { buildCatalog } from '../scripts/ai-demo/catalog';
import { ReviewIntelligenceService } from '../src/modules/ai/review-intelligence/review-intelligence.service';
import { AiError } from '../src/modules/ai/ai.errors';

if (process.env.CUSTOM_DNS_SERVERS)
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
jest.setTimeout(60000);
const reportBody = (response: { body: unknown }) =>
  response.body as Awaited<ReturnType<ReviewIntelligenceService['summary']>>;
const sourcesBody = (response: { body: unknown }) =>
  response.body as { total: number; reviews: { _id: string }[] };

describe('Phase 22 real Mongo/HTTP; isolated synthetic reviews and mock provider', () => {
  const dbName = `smartorder_p22_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const secret = 'phase22-test-only',
    jwt = new JwtService({ secret });
  const auth = (role = 'admin') =>
    `Bearer ${jwt.sign({ sub: 'fixture', email: 'fixture@example.invalid', role })}`;
  const steps: MockAiStep[] = [],
    provider = new MockAiProvider(steps);
  const ids = Array.from({ length: 25 }, () => new Types.ObjectId());
  const orderIds = Array.from({ length: 26 }, () => new Types.ObjectId());
  const tableId = new Types.ObjectId(),
    sessionId = new Types.ObjectId();
  const dish = buildCatalog().dishes[0];
  const period = { fromDate: '2026-08-01', toDate: '2026-08-31' };
  let app: INestApplication<App>,
    connection: Connection,
    reviews: Model<Review>,
    orders: Model<Order>,
    dishes: Model<Dish>,
    audit: Model<AiInteraction>;
  let createdReviewId: Types.ObjectId | undefined;
  const get = (suffix = '', query: object = {}) =>
    request(app.getHttpServer())
      .get(`/ai/admin/review-insights${suffix}`)
      .set('Authorization', auth())
      .query(query);
  const post = (suffix: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(`/ai/admin/review-insights/${suffix}`)
      .set('Authorization', auth())
      .send(body);
  beforeAll(async () => {
    if (process.env.NODE_ENV === 'production' || !process.env.MONGODB_URI)
      throw new Error(
        'Requires non-production MONGODB_URI; isolated dbName only',
      );
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Live provider forbidden'));
    const fixture = await Test.createTestingModule({
      imports: [
        ConfigModule,
        MongooseModule.forRoot(process.env.MONGODB_URI, {
          dbName,
          retryAttempts: 0,
          serverSelectionTimeoutMS: 15000,
        }),
        ReviewIntelligenceModule,
        AdminModule,
      ],
      providers: [JwtStrategy],
    })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          ...validAiEnv,
          AI_MAX_RETRIES: '0',
          JWT_ACCESS_SECRET: secret,
        }),
      )
      .overrideProvider(AI_PROVIDER)
      .useValue(provider)
      .compile();
    app = fixture.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    connection = fixture.get(getConnectionToken());
    expect(connection.name).toBe(dbName);
    reviews = fixture.get(getModelToken(Review.name));
    orders = fixture.get(getModelToken(Order.name));
    dishes = fixture.get(getModelToken(Dish.name));
    audit = fixture.get(getModelToken(AiInteraction.name));
    await reviews.init();
    await dishes.insertMany([dish]);
    await orders.insertMany(
      orderIds.map((_id) => ({
        _id,
        tableId,
        sessionId,
        status: OrderStatus.PAID,
        totalAmount: 100000,
        items: [
          {
            dishId: dish._id,
            dishName: dish.name,
            unitPrice: 100000,
            quantity: 1,
            status: OrderStatus.SERVED,
          },
        ],
      })),
    );
    // Authored synthetic snapshots, including old documents without aiInsight.
    await reviews.collection.insertMany(
      ids.map((_id, i) => ({
        _id,
        orderId: orderIds[i],
        dishId: dish._id,
        tableId,
        sessionId,
        rating: i < 5 ? 5 : i < 10 ? 1 : 3,
        ...(i < 15
          ? {
              comment:
                i < 10
                  ? `SYNTHETIC ${i < 5 ? 'Món ngon' : 'Món nguội'}`
                  : REVIEW_GOLDEN[i - 10][0],
            }
          : i === 15
            ? { comment: '   ' }
            : {}),
        createdAt: new Date(
          i === 0
            ? '2026-08-01T00:00:00.000Z'
            : i === 23
              ? '2026-08-31T23:59:59.999Z'
              : i === 24
                ? '2026-09-01T00:00:00.000Z'
                : '2026-08-15T12:00:00.000Z',
        ),
        ...(i < 10
          ? {
              aiInsight: {
                sentiment: i < 5 ? 'positive' : 'negative',
                topics: [
                  {
                    topic: i < 5 ? 'taste' : 'temperature',
                    sentiment: i < 5 ? 'positive' : 'negative',
                  },
                ],
                taxonomyVersion: REVIEW_TAXONOMY_VERSION,
                modelVersion: 'synthetic:authored-fixture:v1',
                analyzedAt: new Date('2026-09-08'),
              },
            }
          : {}),
      })),
    );
  });
  afterAll(async () => {
    try {
      if (connection?.name === dbName) {
        await reviews?.deleteMany({
          _id: { $in: [...ids, ...(createdReviewId ? [createdReviewId] : [])] },
        });
        await orders?.deleteMany({ _id: { $in: orderIds } });
        await dishes?.deleteOne({ _id: dish._id });
        const entries = await audit
          ?.find({
            feature: { $in: ['review-classification', 'review-summary'] },
          })
          .select('_id')
          .lean();
        if (entries)
          await audit.deleteMany({ _id: { $in: entries.map((e) => e._id) } });
        for (const collection of Object.values(connection.collections))
          expect(await collection.countDocuments()).toBe(0);
      }
    } finally {
      await app?.close();
      jest.restoreAllMocks();
    }
  });
  it('enforces Admin RBAC on reads, source reviews and both AI writes', async () => {
    for (const suffix of ['', '/sources']) {
      await request(app.getHttpServer())
        .get(`/ai/admin/review-insights${suffix}`)
        .expect(401);
      for (const role of ['customer', 'kitchen', 'waiter'])
        await request(app.getHttpServer())
          .get(`/ai/admin/review-insights${suffix}`)
          .set('Authorization', auth(role))
          .expect(403);
    }
    for (const suffix of ['analyze', 'summary']) {
      await request(app.getHttpServer())
        .post(`/ai/admin/review-insights/${suffix}`)
        .send({})
        .expect(401);
      for (const role of ['kitchen'])
        await request(app.getHttpServer())
          .post(`/ai/admin/review-insights/${suffix}`)
          .set('Authorization', auth(role))
          .send({})
          .expect(403);
    }
    expect(provider.calls).toHaveLength(0);
  });
  it('rejects invalid filters, unknown topics, source pages and arbitrary database queries', async () => {
    for (const query of [
      { dishId: 'bad' },
      { fromDate: '2026-02-30', toDate: '2026-03-01' },
      { fromDate: '2026-01-01' },
      { pipeline: '[]' },
    ])
      await get('', query).expect(400);
    for (const query of [
      { topic: 'api_key' },
      { sentiment: 'happy' },
      { page: 0 },
      { page: 10001 },
    ])
      await get('/sources', query).expect(400);
  });
  it('reconciles Mongo totals, averages, comment/sample distinction, dates and dish filter', async () => {
    const all = await get().expect(200);
    expect(reportBody(all).facts).toMatchObject({
      totalReviews: 25,
      commentCount: 15,
      analyzedCommentCount: 10,
      sampleSize: 10,
      averageRating: 3,
      analysisCoveragePercentage: 66.67,
      sentimentCounts: { positive: 5, negative: 5, mixed: 0, neutral: 0 },
      sentimentPercentages: { positive: 50, negative: 50 },
    });
    expect(reportBody(all).warnings).toHaveLength(1);
    const filtered = await get('', {
      ...period,
      dishId: dish._id.toString(),
    }).expect(200);
    expect(reportBody(filtered).facts.totalReviews).toBe(24);
    const empty = await get('', {
      dishId: new Types.ObjectId().toString(),
    }).expect(200);
    expect(reportBody(empty).facts).toMatchObject({
      totalReviews: 0,
      averageRating: null,
      sampleSize: 0,
    });
    expect(provider.calls).toHaveLength(0);
  });
  it('pages source reviews with exact topic sentiment matching and no session/order identifiers', async () => {
    const first = await get('/sources').expect(200),
      second = await get('/sources', { page: 2 }).expect(200);
    expect(sourcesBody(first).reviews).toHaveLength(20);
    expect(sourcesBody(second).reviews).toHaveLength(5);
    expect(
      new Set(
        [...sourcesBody(first).reviews, ...sourcesBody(second).reviews].map(
          (r: { _id: string }) => r._id,
        ),
      ).size,
    ).toBe(25);
    expect(sourcesBody(first).reviews[0]).not.toHaveProperty('sessionId');
    expect(sourcesBody(first).reviews[0]).not.toHaveProperty('orderId');
    const taste = await get('/sources', {
      topic: 'taste',
      sentiment: 'positive',
    }).expect(200);
    expect(sourcesBody(taste).total).toBe(5);
    const negativeTaste = await get('/sources', {
      topic: 'taste',
      sentiment: 'negative',
    }).expect(200);
    expect(sourcesBody(negativeTaste).total).toBe(0);
  });
  it('enriches exactly five pending comments; factual fields, old reviews and ratings remain unchanged', async () => {
    const before = await reviews.find().select('-aiInsight').sort('_id').lean();
    steps.push(...REVIEW_GOLDEN.slice(0, 5).map(([, output]) => ({ output })));
    const result = await post('analyze').expect(200);
    expect(result.body).toMatchObject({ attempted: 5, analyzed: 5 });
    expect(
      await reviews.find().select('-aiInsight').sort('_id').lean(),
    ).toEqual(before);
    expect(provider.calls).toHaveLength(5);
    const report = await get().expect(200);
    expect(reportBody(report).facts).toMatchObject({
      totalReviews: 25,
      commentCount: 15,
      sampleSize: 15,
      averageRating: 3,
      analysisCoveragePercentage: 100,
      sentimentCounts: { positive: 6, negative: 6, mixed: 3, neutral: 0 },
      sentimentPercentages: { positive: 40, negative: 40, mixed: 20 },
    });
    expect(reportBody(report).facts.topics[0]).toMatchObject({
      topic: 'taste',
      count: 8,
      percentage: 53.33,
    });
    expect(reportBody(report).warnings).toEqual([]);
    expect(
      (await reviews.findById(ids[10]).lean())?.aiInsight?.modelVersion,
    ).toBe('openai:test-model-snapshot:review-classification-v1');
  });
  it('skips whitespace/rating-only and already-analyzed reviews without more provider calls', async () => {
    expect((await post('analyze').expect(200)).body).toMatchObject({
      attempted: 0,
      analyzed: 0,
    });
    expect(provider.calls).toHaveLength(5);
  });
  it('returns a grounded summary and exact source IDs behind topics', async () => {
    steps.push((req) =>
      Promise.resolve({
        output: {
          answer: (
            req.jsonSchema.properties as { answer: { enum: string[] } }
          ).answer.enum.at(-1),
        },
      }),
    );
    const result = await post('summary').expect(200);
    expect(reportBody(result).summary).toContain('15/15');
    expect(reportBody(result).summary).toContain('Hương vị: 8 comment');
    const source = await get('/sources', {
      topic: 'taste',
      sentiment: 'positive',
    }).expect(200);
    expect(sourcesBody(source).total).toBe(8);
    expect(
      sourcesBody(source).reviews.map((r: { _id: string }) => r._id),
    ).toEqual(
      expect.arrayContaining([
        ids[10].toString(),
        ids[11].toString(),
        ids[14].toString(),
      ]),
    );
  });
  it('AI unavailable preserves summary facts and cannot break POST review ownership/duplicate rules', async () => {
    steps.push(new AiError('AI_PROVIDER_UNAVAILABLE'));
    expect((await post('summary').expect(200)).body).toMatchObject({
      summaryStatus: 'unavailable',
      facts: { sampleSize: 15 },
    });
    const payload = {
      orderId: orderIds[25].toString(),
      dishId: dish._id.toString(),
      sessionId: sessionId.toString(),
      rating: 4,
      comment: 'SYNTHETIC mới',
    };
    await request(app.getHttpServer())
      .post('/reviews')
      .send({ ...payload, sessionId: new Types.ObjectId().toString() })
      .expect(403);
    await request(app.getHttpServer())
      .post('/reviews')
      .send({ ...payload, dishId: new Types.ObjectId().toString() })
      .expect(404);
    await orders.updateOne(
      { _id: orderIds[25] },
      { $set: { status: OrderStatus.SERVED } },
    );
    await request(app.getHttpServer())
      .post('/reviews')
      .send(payload)
      .expect(403);
    await orders.updateOne(
      { _id: orderIds[25] },
      { $set: { status: OrderStatus.PAID } },
    );
    const created = await request(app.getHttpServer())
      .post('/reviews')
      .send(payload)
      .expect(201);
    createdReviewId = new Types.ObjectId(
      (created.body as { reviewId: string }).reviewId,
    );
    await request(app.getHttpServer())
      .post('/reviews')
      .send(payload)
      .expect(409);
    expect(provider.calls).toHaveLength(7);
    const old = await request(app.getHttpServer())
      .get('/reviews/reviewable')
      .query({
        orderId: orderIds[16].toString(),
        sessionId: sessionId.toString(),
      })
      .expect(200);
    expect(
      (old.body as { items: { reviewed: boolean }[] }).items[0].reviewed,
    ).toBe(true);
    steps.push(new AiError('AI_PROVIDER_UNAVAILABLE'));
    expect(
      (
        (await post('analyze').expect(200)).body as {
          outcomes: { status: string }[];
        }
      ).outcomes[0].status,
    ).toBe('failed');
    expect((await reviews.findById(createdReviewId).lean())?.comment).toBe(
      payload.comment,
    );
  });
  it('preserves existing top-rated analytics and records private model/version audit', async () => {
    const rated = await request(app.getHttpServer())
      .get('/admin/analytics/top-rated-dishes')
      .set('Authorization', auth())
      .expect(200);
    expect((rated.body as unknown[])[0]).toMatchObject({
      averageRating: 3.04,
      reviewCount: 26,
    });
    const entries = await audit
      .find({ feature: { $in: ['review-classification', 'review-summary'] } })
      .lean();
    expect(entries).toHaveLength(8);
    expect(entries.filter((e) => e.success)).toHaveLength(6);
    expect(
      entries.some((e) => e.promptVersion === 'review-classification-v1'),
    ).toBe(true);
    for (const comment of REVIEW_GOLDEN.map(([text]) => text))
      expect(JSON.stringify(entries)).not.toContain(comment);
    expect(JSON.stringify(entries)).not.toContain('test-only-not-a-real-key');
  });
});
