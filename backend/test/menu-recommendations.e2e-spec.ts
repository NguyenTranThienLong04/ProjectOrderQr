import 'dotenv/config';
import * as dns from 'dns';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { RecommendationModule } from '../src/modules/menu/recommendation.module';
import { Category } from '../src/modules/category/category.schema';
import { Dish } from '../src/modules/dish/dish.schema';
import { Session } from '../src/modules/session/session.schema';
import { Table } from '../src/modules/table/table.schema';
import { Order } from '../src/modules/order/order.schema';
import { OrderStatus } from '../src/common/enums/order-status.enum';
import { SessionStatus } from '../src/common/enums/session-status.enum';
import { buildDataset, type Basket } from '../scripts/ai-demo/dataset';
import { type BasketEvidence } from '../src/modules/menu/recommendation-ranking';

if (process.env.CUSTOM_DNS_SERVERS)
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
jest.setTimeout(60000);
type Body = {
  result: {
    recommendations: {
      dish: Dish & { _id: string };
      reason: string;
      evidence: BasketEvidence;
    }[];
    sampleSize: number;
    cartDishIds: string[];
  };
  warnings: string[];
};
const body = (response: { body: unknown }) => response.body as Body;

describe('Phase 23 real Mongo/HTTP with explicitly synthetic Phase 16 baskets', () => {
  const dbName = `smartorder_p23_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const dataset = buildDataset();
  const baskets = dataset.ai_demo_baskets as Basket[];
  const anchor = dataset.dishes[0]._id;
  const tableId = new Types.ObjectId(),
    sessionId = new Types.ObjectId();
  const sentinelIds = [
    new Types.ObjectId(),
    new Types.ObjectId(),
    new Types.ObjectId(),
  ];
  const orderIds = [...baskets.map((b) => b._id), ...sentinelIds];
  let app: INestApplication<App>, connection: Connection;
  let dishes: Model<Dish>,
    categories: Model<Category>,
    sessions: Model<Session>,
    tables: Model<Table>,
    orders: Model<Order>;
  const post = (extra: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/menu/recommendations')
      .send({
        sessionId: sessionId.toString(),
        tableId: tableId.toString(),
        ...extra,
      });
  const setCart = (ids: Types.ObjectId[]) =>
    sessions.updateOne(
      { _id: sessionId },
      {
        $set: {
          cart: ids.map((dishId) => ({
            dishId,
            dishName: 'synthetic cart snapshot',
            unitPrice: 1,
            quantity: 1,
          })),
        },
      },
    );
  beforeAll(async () => {
    if (process.env.NODE_ENV === 'production' || !process.env.MONGODB_URI)
      throw new Error(
        'Requires non-production configured Mongo host; isolated dbName mandatory',
      );
    const fixture = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(process.env.MONGODB_URI, {
          dbName,
          retryAttempts: 0,
          serverSelectionTimeoutMS: 15000,
        }),
        RecommendationModule,
      ],
    }).compile();
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
    dishes = fixture.get(getModelToken(Dish.name));
    categories = fixture.get(getModelToken(Category.name));
    sessions = fixture.get(getModelToken(Session.name));
    tables = fixture.get(getModelToken(Table.name));
    orders = fixture.get(getModelToken(Order.name));
    await categories.insertMany(dataset.categories);
    await dishes.insertMany(dataset.dishes);
    await sessions.create({
      _id: sessionId,
      tableId,
      tableIds: [tableId],
      status: SessionStatus.ACTIVE,
    });
    await tables.create({
      _id: tableId,
      tableCode: 'P23-SYNTHETIC',
      qrCodeUrl: 'synthetic',
      currentSessionId: sessionId,
    });
    const snapshots = baskets.map((basket, index) => ({
      _id: basket._id,
      sessionId,
      tableId,
      status: OrderStatus.SERVED,
      items: basket.items.map((item) => ({
        ...item,
        status: OrderStatus.SERVED,
      })),
      totalAmount: basket.basketValueVnd,
      createdAt: new Date(Date.now() - (index + 1) * 3600000),
    }));
    // Fixture adapter ONLY in isolated tests. Never seed completed Orders in the app/demo DB.
    await orders.insertMany([
      ...snapshots,
      ...sentinelIds.map((_id, i) => ({
        ...snapshots[0],
        _id,
        status:
          i === 0
            ? OrderStatus.PENDING
            : i === 1
              ? OrderStatus.CANCELLED
              : OrderStatus.SERVED,
        createdAt: i === 2 ? new Date('2000-01-01') : new Date(),
      })),
    ]);
    await setCart([anchor]);
  });
  afterAll(async () => {
    if (
      connection &&
      connection.name === dbName &&
      /^smartorder_p23_[a-f0-9]{20}$/.test(dbName)
    ) {
      await orders.deleteMany({ _id: { $in: orderIds } });
      await sessions.deleteMany({ _id: sessionId });
      await tables.deleteMany({ _id: tableId });
      await dishes.deleteMany({
        _id: { $in: dataset.dishes.map((d) => d._id) },
      });
      await categories.deleteMany({
        _id: { $in: dataset.categories.map((c) => c._id) },
      });
      for (const collection of await connection.db!.collections())
        expect(await collection.countDocuments()).toBe(0);
    }
    await app?.close();
  });
  it('reconciles exact synthetic co-occurrence against all 640 original baskets', async () => {
    const result = body(await post().expect(201));
    expect(result.result.sampleSize).toBe(640);
    const anchorBaskets = baskets.filter((b) =>
      b.items.some((i) => i.dishId.equals(anchor)),
    );
    expect(result.result.recommendations).toHaveLength(4);
    for (const item of result.result.recommendations) {
      const count = anchorBaskets.filter((b) =>
        b.items.some((i) => i.dishId.toString() === item.dish._id),
      ).length;
      expect(item.evidence.pairCount).toBe(count);
      expect(item.evidence.confidence).toBe(count / anchorBaskets.length);
      expect(item.evidence.support).toBe(count / 640);
      expect(item.reason).toBe('frequently_bought_together');
      expect(item.dish.isAvailable).toBe(true);
      expect(item.dish._id).not.toBe(anchor.toString());
    }
    // Authored Phase 16 meal [0,15,35] should produce its side/drink signal.
    expect(result.result.recommendations.map((r) => r.dish._id)).toEqual(
      expect.arrayContaining([
        dataset.dishes[15]._id.toString(),
        dataset.dishes[35]._id.toString(),
      ]),
    );
    console.log(
      'P23 synthetic evidence',
      JSON.stringify({
        anchorCount: anchorBaskets.length,
        recommendations: result.result.recommendations.map((r) => ({
          name: r.dish.name,
          ...r.evidence,
        })),
      }),
    );
    expect(body(await post().expect(201))).toEqual(result);
  });
  it('fresh availability, deletion and inactive category override cached rankings', async () => {
    const initial = body(await post().expect(201));
    const chosen = initial.result.recommendations[0].dish;
    await dishes.updateOne(
      { _id: chosen._id },
      { $set: { isAvailable: false } },
    );
    expect(
      body(await post().expect(201)).result.recommendations.some(
        (r) => r.dish._id === chosen._id,
      ),
    ).toBe(false);
    await dishes.updateOne(
      { _id: chosen._id },
      { $set: { isAvailable: true } },
    );
    await dishes.deleteOne({ _id: chosen._id });
    expect(
      body(await post().expect(201)).result.recommendations.some(
        (r) => r.dish._id === chosen._id,
      ),
    ).toBe(false);
    await dishes.create(
      dataset.dishes.find((d) => d._id.toString() === chosen._id)!,
    );
    await categories.updateOne(
      { _id: chosen.categoryId },
      { $set: { isActive: false } },
    );
    expect(
      body(await post().expect(201)).result.recommendations.some(
        (r) => r.dish.categoryId.toString() === chosen.categoryId.toString(),
      ),
    ).toBe(false);
    await categories.updateOne(
      { _id: chosen.categoryId },
      { $set: { isActive: true } },
    );
  });
  it('hard filters allergens, dietary tags and price from real catalog', async () => {
    const response = body(
      await post({
        constraints: {
          excludedAllergens: ['peanut'],
          requiredDietaryTags: ['vegan'],
          maxPrice: 100000,
        },
      }).expect(201),
    );
    expect(response.warnings.join(' ')).toContain('Không thể xác minh');
    for (const { dish } of response.result.recommendations) {
      expect(dish.allergenTags).not.toContain('peanut');
      expect(dish.dietaryTags).toContain('vegan');
      expect(dish.price).toBeLessThanOrEqual(100000);
    }
  });
  it('multi-dish cart uses union counts and ignores note/quantity variants', async () => {
    const second = dataset.dishes[15]._id;
    await setCart([anchor, second, anchor]);
    const response = body(await post().expect(201));
    const union = baskets.filter((b) =>
      b.items.some((i) => i.dishId.equals(anchor) || i.dishId.equals(second)),
    );
    expect(response.result.cartDishIds).toHaveLength(2);
    for (const item of response.result.recommendations) {
      expect(item.evidence.anchorCount).toBe(union.length);
      expect(item.evidence.pairCount).toBe(
        union.filter((b) =>
          b.items.some((i) => i.dishId.toString() === item.dish._id),
        ).length,
      );
      expect([anchor.toString(), second.toString()]).not.toContain(
        item.dish._id,
      );
    }
    await setCart([anchor]);
  });
  it('empty and unseen baskets have honestly labeled popularity', async () => {
    for (const ids of [[], [new Types.ObjectId()]]) {
      await setCart(ids);
      const response = body(await post().expect(201));
      expect(response.result.recommendations.length).toBeGreaterThan(0);
      expect(
        response.result.recommendations.every((r) => r.reason === 'popular'),
      ).toBe(true);
    }
    await setCart([anchor]);
  });
  it('enforces active ownership and authoritative merged membership', async () => {
    await post({ sessionId: new Types.ObjectId().toString() }).expect(403);
    await post({ tableId: new Types.ObjectId().toString() }).expect(403);
    await sessions.updateOne(
      { _id: sessionId },
      { $set: { status: SessionStatus.CLOSED } },
    );
    await post().expect(403);
    await sessions.updateOne(
      { _id: sessionId },
      {
        $set: {
          status: SessionStatus.ACTIVE,
          tableIds: [new Types.ObjectId()],
        },
      },
    );
    await post().expect(403);
    await sessions.updateOne(
      { _id: sessionId },
      { $set: { tableIds: [tableId] } },
    );
    await post().expect(201);
  });
  it('strict HTTP DTO rejects invented facts, unsupported constraints and invalid IDs', async () => {
    for (const invalid of [
      { sessionId: 'bad' },
      { price: 1 },
      { dishIds: [anchor.toString()] },
      { constraints: { excludedAllergens: ['fake'] } },
      { constraints: { $where: 'true' } },
      { constraints: { maxPrice: '100' } },
    ])
      await post(invalid).expect(400);
  });
  it('localizes DB facts and performs no writes or provider calls', async () => {
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all([
          sessions.find().lean(),
          tables.find().lean(),
          orders.find().sort('_id').lean(),
        ]),
      );
    const before = await snapshot();
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Live provider forbidden'));
    try {
      const response = body(await post({ lang: 'en' }).expect(201));
      for (const item of response.result.recommendations) {
        const original = await dishes.findById(item.dish._id).lean();
        expect(item.dish.name).toBe(original!.nameEn || original!.name);
      }
      expect(await snapshot()).toBe(before);
      expect(fetch).not.toHaveBeenCalled();
      expect(
        body(
          await request(app.getHttpServer())
            .get('/menu')
            .query({ tableId: tableId.toString() })
            .expect(200),
        ),
      ).toBeDefined();
    } finally {
      fetch.mockRestore();
    }
  });
});
