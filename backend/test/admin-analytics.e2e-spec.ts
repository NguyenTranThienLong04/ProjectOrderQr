import 'dotenv/config';
import * as dns from 'dns';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
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
import { AdminAnalyticsAiModule } from '../src/modules/ai/admin-analytics/admin-analytics-ai.module';
import { analyticsIntent } from '../src/modules/ai/admin-analytics/analytics.golden';
import type { AnalyticsIntent } from '../src/modules/ai/admin-analytics/analytics.dto';
import type { AnalyticsFact } from '../src/modules/ai/admin-analytics/analytics-tools.service';
import { AI_PROVIDER } from '../src/modules/ai/providers/ai-provider.interface';
import {
  MockAiProvider,
  MockAiStep,
} from '../src/modules/ai/testing/mock-ai-provider';
import { validAiEnv } from '../src/modules/ai/testing/ai-test.fixture';
import { AiInteraction } from '../src/modules/ai/schemas/ai-interaction.schema';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { Order } from '../src/modules/order/order.schema';
import { Dish } from '../src/modules/dish/dish.schema';
import { Review } from '../src/modules/review/review.schema';
import { OrderStatus } from '../src/common/enums/order-status.enum';
import { buildCatalog } from '../scripts/ai-demo/catalog';

if (process.env.CUSTOM_DNS_SERVERS)
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
jest.setTimeout(60000);
describe('Phase 21 real Mongo/HTTP aggregation (isolated synthetic fixtures)', () => {
  const dbName = `smartorder_p21_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const secret = 'phase21-integration-test',
    jwt = new JwtService({ secret });
  const authorization = `Bearer ${jwt.sign({ sub: 'fixture', email: 'fixture@example.invalid', role: 'admin' })}`;
  const steps: MockAiStep[] = [],
    provider = new MockAiProvider(steps);
  const dish = buildCatalog().dishes[0];
  const orderIds = Array.from({ length: 5 }, () => new Types.ObjectId());
  const reviewIds = Array.from({ length: 3 }, () => new Types.ObjectId());
  const tableId = new Types.ObjectId(),
    sessionId = new Types.ObjectId();
  let app: INestApplication<App>,
    connection: Connection,
    orders: Model<Order>,
    dishes: Model<Dish>,
    reviews: Model<Review>,
    audit: Model<AiInteraction>;
  const get = (path: string) =>
    request(app.getHttpServer())
      .get(`/admin/analytics/${path}`)
      .set('Authorization', authorization);
  const post = (
    intent: AnalyticsIntent,
    query = 'doanh thu',
    fromDate = '2026-08-01',
    toDate = '2026-08-31',
  ) => {
    steps.push({ output: intent }, (req) =>
      Promise.resolve({
        output: {
          answer: (req.jsonSchema.properties as { answer: { enum: string[] } })
            .answer.enum[0],
        },
      }),
    );
    return request(app.getHttpServer())
      .post('/ai/admin/analytics/query')
      .set('Authorization', authorization)
      .send({ query, fromDate, toDate });
  };
  const snapshot = async () =>
    JSON.stringify({
      orders: await orders.find().sort('_id').lean(),
      dishes: await dishes.find().sort('_id').lean(),
      reviews: await reviews.find().sort('_id').lean(),
    });
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
        AdminAnalyticsAiModule,
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
    await app.init();
    connection = fixture.get(getConnectionToken());
    expect(connection.name).toBe(dbName);
    orders = fixture.get(getModelToken(Order.name));
    dishes = fixture.get(getModelToken(Dish.name));
    reviews = fixture.get(getModelToken(Review.name));
    audit = fixture.get(getModelToken(AiInteraction.name));
    await dishes.insertMany([dish]);
    const amounts = [7500000, 5000000, 10000000, 9000000, 99999999];
    const times = [
      '2026-08-01T00:00:00.000Z',
      '2026-08-31T23:59:59.999Z',
      '2026-07-31T23:59:59.999Z',
      '2026-09-01T00:00:00.000Z',
      '2026-08-15T00:00:00.000Z',
    ];
    // Synthetic Paid snapshots exist ONLY in this unique test DB, never demo/main DB.
    await orders.insertMany(
      orderIds.map((_id, index) => ({
        _id,
        tableId,
        sessionId,
        status: index === 4 ? OrderStatus.SERVED : OrderStatus.PAID,
        paidAt: new Date(times[index]),
        totalAmount: amounts[index],
        subtotalAmount: amounts[index] + 1000,
        discountAmount: 1000,
        items: [
          {
            dishId: dish._id,
            dishName: dish.name,
            quantity: index + 1,
            unitPrice: 100000,
            status: OrderStatus.SERVED,
          },
        ],
      })),
    );
    await reviews.collection.insertMany(
      reviewIds.map((_id, index) => ({
        _id,
        orderId: orderIds[index],
        dishId: dish._id,
        tableId,
        sessionId,
        rating: [5, 4, 1][index],
        comment: 'SYNTHETIC TEST ONLY',
        createdAt: new Date(times[index]),
      })),
    );
  });
  afterAll(async () => {
    try {
      if (connection?.name === dbName) {
        await orders?.deleteMany({ _id: { $in: orderIds } });
        await dishes?.deleteOne({ _id: dish._id });
        await reviews?.deleteMany({ _id: { $in: reviewIds } });
        const entries = await audit
          ?.find({
            feature: {
              $in: ['admin-analytics-intent', 'admin-analytics-answer'],
            },
          })
          .select('_id')
          .lean();
        if (entries)
          await audit.deleteMany({
            _id: { $in: entries.map((entry) => entry._id) },
          });
        for (const collection of Object.values(connection.collections))
          expect(await collection.countDocuments()).toBe(0);
      }
    } finally {
      await app?.close();
      jest.restoreAllMocks();
    }
  });
  it('reconciles inclusive UTC Paid snapshot revenue with existing endpoint and does not mutate business data', async () => {
    const before = await snapshot();
    const response = await post(analyticsIntent()).expect(200);
    const facts = (response.body as { facts: AnalyticsFact[] }).facts;
    expect(facts.find((f) => f.metric === 'revenue')?.value).toBe(12500000);
    expect(facts.find((f) => f.metric === 'orders')?.value).toBe(2);
    expect(facts.find((f) => f.metric === 'averageOrderValue')?.value).toBe(
      6250000,
    );
    const legacy = await get(
      'revenue?from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:59.999Z',
    ).expect(200);
    expect(
      (legacy.body as { revenue: number }[]).reduce(
        (sum, row) => sum + row.revenue,
        0,
      ),
    ).toBe(12500000);
    expect(await snapshot()).toBe(before);
  });
  it('compares distinct periods with deterministic percentage', async () => {
    const response = await post(
      analyticsIntent({
        operation: 'compare',
        comparisonPeriod: {
          preset: 'custom',
          from: '1/7/2026',
          to: '31/7/2026',
        },
      }),
      'so với từ 1/7/2026 đến 31/7/2026',
    ).expect(200);
    expect((response.body as { facts: AnalyticsFact[] }).facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: 'revenueChangePercent', value: 25 }),
        expect.objectContaining({
          metric: 'revenueDifference',
          value: 2500000,
        }),
      ]),
    );
  });
  it('reuses top dishes with pre-discount item totals and deterministic ranking', async () => {
    const response = await post(
      analyticsIntent({ metric: 'topDishes' }),
    ).expect(200);
    expect((response.body as { facts: AnalyticsFact[] }).facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: 'quantity', value: 3 }),
        expect.objectContaining({ metric: 'dishGrossRevenue', value: 300000 }),
        expect.objectContaining({ metric: 'rank', value: 1 }),
      ]),
    );
    const legacy = await get(
      'top-dishes?from=2026-08-01&to=2026-08-31T23:59:59.999Z',
    ).expect(200);
    expect(legacy.body).toMatchObject([{ totalQuantity: 3, revenue: 300000 }]);
  });
  it('filters rating summary by review creation time', async () => {
    const response = await post(
      analyticsIntent({ metric: 'ratingSummary' }),
    ).expect(200);
    expect((response.body as { facts: AnalyticsFact[] }).facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: 'averageRating', value: 4.5 }),
        expect.objectContaining({ metric: 'reviewCount', value: 2 }),
      ]),
    );
  });
  it('filters top rated while existing all-time endpoint stays compatible', async () => {
    const response = await post(
      analyticsIntent({ metric: 'topRatedDishes' }),
    ).expect(200);
    expect(
      (response.body as { facts: AnalyticsFact[] }).facts.find(
        (f) => f.metric === 'averageRating',
      )?.value,
    ).toBe(4.5);
    const legacy = await get('top-rated-dishes').expect(200);
    expect(legacy.body).toMatchObject([
      { averageRating: 3.33, reviewCount: 3 },
    ]);
  });
  it('reports no data for empty period', async () => {
    const response = await post(
      analyticsIntent(),
      'doanh thu',
      '2020-01-01',
      '2020-01-31',
    ).expect(200);
    expect(
      (response.body as { facts: AnalyticsFact[] }).facts.find(
        (f) => f.metric === 'revenue',
      )?.value,
    ).toBe(0);
  });
  it('persists versioned audits without question, facts or raw provider content', async () => {
    const entries = await audit.find().lean();
    expect(entries).toHaveLength(12);
    for (const entry of entries)
      expect(entry).toMatchObject({
        promptVersion:
          entry.feature === 'admin-analytics-intent'
            ? 'admin-analytics-v2'
            : 'admin-analytics-v1',
        success: true,
        fallbackUsed: false,
      });
    expect(JSON.stringify(entries)).not.toMatch(
      /systemPrompt|SYNTHETIC TEST ONLY|12500000/,
    );
  });
});
