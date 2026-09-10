import 'dotenv/config';
import * as dns from 'node:dns';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INestApplication,
  Logger,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { AppService } from '../src/app.service';
import { OrderStatus } from '../src/common/enums/order-status.enum';
import { TableStatus } from '../src/common/enums/table-status.enum';
import { SessionStatus } from '../src/common/enums/session-status.enum';
import { DatabaseModule } from '../src/database/database.module';
import { AiConfig } from '../src/modules/ai/ai.config';
import { analyticsIntent } from '../src/modules/ai/admin-analytics/analytics.golden';
import { emptyMenuIntent } from '../src/modules/ai/menu-search/menu-search.golden';
import { AiInteraction } from '../src/modules/ai/schemas/ai-interaction.schema';
import { Category } from '../src/modules/category/category.schema';
import { Dish } from '../src/modules/dish/dish.schema';
import { Order, OrderDocument } from '../src/modules/order/order.schema';
import { Review } from '../src/modules/review/review.schema';
import { Session } from '../src/modules/session/session.schema';
import { Table } from '../src/modules/table/table.schema';
import { PaymentIntent } from '../src/modules/vnpay/payment-intent.schema';
import { VnpayService } from '../src/modules/vnpay/vnpay.service';
import { RecommendationService } from '../src/modules/menu/recommendation.service';
import { MenuService } from '../src/modules/menu/menu.service';
import { searchCases } from '../scripts/ai-evaluation/dataset.v1';

if (process.env.CUSTOM_DNS_SERVERS)
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
jest.setTimeout(60000);
@Module({})
class ReleaseDatabase {}

const modes = [
  { name: 'disabled', code: 'AI_DISABLED', status: 503, attempts: 0 },
  { name: 'missing-key', code: 'AI_NOT_CONFIGURED', status: 503, attempts: 0 },
  { name: 'timeout', code: 'AI_TIMEOUT', status: 504, attempts: 2 },
  { name: 'provider-429', code: 'AI_RATE_LIMIT', status: 429, attempts: 2 },
  {
    name: 'provider-5xx',
    code: 'AI_PROVIDER_UNAVAILABLE',
    status: 503,
    attempts: 2,
  },
  {
    name: 'invalid-output',
    code: 'AI_INVALID_OUTPUT',
    status: 502,
    attempts: 2,
  },
  { name: 'malformed-client', code: '', status: 400, attempts: 0 },
] as const;
type Mode = (typeof modes)[number];
const endpoints = [
  'dish',
  'note',
  'search',
  'analytics-intent',
  'analytics-answer',
  'review-classify',
  'review-summary',
] as const;
type Endpoint = (typeof endpoints)[number];
type ProviderBody = {
  input: { role: string; content: string }[];
  text: {
    format: {
      name: string;
      schema: { properties: { answer?: { enum: string[] } } };
    };
  };
  store: boolean;
};
type Cart = {
  cart: {
    dishId: string;
    quantity: number;
    note?: string;
    aiNoteAnalysis?: { modifierTags: string[] };
  }[];
};
// Supertest exposes body as any. Keep the test wire contract explicit at that boundary.
interface ReleaseBody {
  fallbackUsed: boolean;
  result: {
    dishes: {
      _id: string;
      name: string;
      price: number;
      ingredients: string[];
      allergenTags: string[];
    }[];
    appliedFilters: Record<string, unknown>;
  };
  warnings: string[];
  code: string;
  orderId: string;
  amount: number;
  coveredOrderIds: string[];
  txnRef: string;
  analysisToken: string;
  analyzed: number;
  summaryStatus: string;
  facts: { sampleSize: number; commentCount: number };
}
const body = (response: { body: unknown }) => response.body as ReleaseBody;
const envelope = (output: unknown) =>
  Response.json({
    status: 'completed',
    output: [
      { type: 'reasoning', summary: 'P24_REASONING_CANARY' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify(output) }],
      },
    ],
  });

describe('Phase 24 release: real AppModule / Mongo / HTTP / Socket; simulated provider and signed test IPN', () => {
  const dbName = `smartorder_p24_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const tableId = new Types.ObjectId(),
    sessionId = new Types.ObjectId(),
    categoryId = new Types.ObjectId();
  const dishIds = Array.from({ length: 5 }, () => new Types.ObjectId());
  const seedReviewIds = [new Types.ObjectId(), new Types.ObjectId()];
  const matrixFilter = { fromDate: '2026-01-01', toDate: '2026-01-01' };
  const syntheticKey = 'P24_SYNTHETIC_KEY_CANARY';
  const rawNote = 'dị ứng đậu phộng P24_PRIVATE_NOTE';
  const config = new ConfigService({
    AI_ENABLED: 'true',
    AI_PROVIDER: 'openai',
    AI_MODEL: 'phase24-fixture',
    AI_API_KEY: syntheticKey,
    AI_TIMEOUT_MS: '100',
    AI_MAX_RETRIES: '1',
  });
  let app: INestApplication<App>,
    connection: Connection,
    tables: Model<Table>,
    sessions: Model<Session>,
    dishes: Model<Dish>,
    categories: Model<Category>,
    orders: Model<OrderDocument>,
    reviews: Model<Review>,
    audits: Model<AiInteraction>,
    intents: Model<PaymentIntent>;
  let vnpay: VnpayService, menu: MenuService;
  let fetchMock: jest.SpyInstance;
  let warnings: jest.SpyInstance;
  let errors: jest.SpyInstance;
  let admin: string, kitchen: string, waiter: string;
  let address = 1;
  let providerInputs: ProviderBody[] = [];
  let signals: AbortSignal[] = [];
  const rows: Record<string, unknown>[] = [];
  const coreRows: string[] = [];
  const goldenRows: string[] = [];
  const benchmark: Record<string, unknown> = {};
  const ownership = {
    tableId: tableId.toString(),
    sessionId: sessionId.toString(),
  };
  const noteInput = {
    ...ownership,
    dishId: dishIds[0].toString(),
    note: rawNote,
  };
  const post = (path: string, body: object, auth?: string, ip?: string) => {
    const req = request(app.getHttpServer())
      .post(path)
      .set('X-Forwarded-For', ip ?? `192.0.2.${(address++ % 250) + 1}`);
    if (auth) req.set('Authorization', auth);
    return req.send(body);
  };
  const routes: Record<
    Endpoint,
    { path: string; body: () => object; auth: () => string | undefined }
  > = {
    dish: {
      path: '/ai/admin/dish-draft',
      body: () => ({ name: 'Phở bò tái', generateFields: ['nameEn'] }),
      auth: () => admin,
    },
    note: {
      path: '/ai/order-notes/analyze',
      body: () => noteInput,
      auth: () => undefined,
    },
    search: {
      path: '/ai/menu/search',
      body: () => ({ tableId: ownership.tableId, query: 'Phở' }),
      auth: () => undefined,
    },
    'analytics-intent': {
      path: '/ai/admin/analytics/query',
      body: () => ({ query: 'doanh thu' }),
      auth: () => admin,
    },
    'analytics-answer': {
      path: '/ai/admin/analytics/query',
      body: () => ({ query: 'doanh thu' }),
      auth: () => admin,
    },
    'review-classify': {
      path: '/ai/admin/review-insights/analyze',
      body: () => matrixFilter,
      auth: () => admin,
    },
    'review-summary': {
      path: '/ai/admin/review-insights/summary',
      body: () => matrixFilter,
      auth: () => admin,
    },
  };
  const installFetch = (
    reply: (
      body: ProviderBody,
      signal: AbortSignal,
    ) => Response | Promise<Response>,
  ) => {
    fetchMock.mockReset();
    providerInputs = [];
    signals = [];
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as ProviderBody;
      providerInputs.push(body);
      signals.push(init.signal as AbortSignal);
      return Promise.resolve(reply(body, init.signal as AbortSignal));
    });
  };
  const configure = (mode: Mode, endpoint?: Endpoint) => {
    config.set('AI_ENABLED', mode.name === 'disabled' ? 'false' : 'true');
    config.set('AI_API_KEY', mode.name === 'missing-key' ? '' : syntheticKey);
    installFetch((body) => {
      if (
        endpoint === 'analytics-answer' &&
        body.text.format.name === 'admin_analytics_intent'
      )
        return envelope(analyticsIntent());
      if (mode.name === 'timeout')
        return new Promise<Response>(() => undefined);
      if (mode.name === 'provider-429')
        return new Response('P24_PRIVATE_NOTE', { status: 429 });
      if (mode.name === 'provider-5xx')
        return new Response('P24_PRIVATE_NOTE', { status: 503 });
      return envelope({
        systemPrompt: 'P24_SYSTEM_CANARY',
        mongoQuery: 'db.users.find()',
        rawNote,
      });
    });
  };
  const snapshot = async () =>
    JSON.stringify({
      dishes: await dishes.find().sort('_id').lean(),
      sessions: await sessions.find().sort('_id').lean(),
      tables: await tables.find().sort('_id').lean(),
      orders: await orders.find().sort('_id').lean(),
      reviews: await reviews.find().sort('_id').lean(),
    });
  const waitCart = (socket: Socket, accept: (value: Cart) => boolean) =>
    new Promise<Cart>((resolve, reject) => {
      const handler = (value: Cart) => {
        if (accept(value)) {
          clearTimeout(timer);
          socket.off('cart:synced', handler);
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        socket.off('cart:synced', handler);
        reject(new Error('P24 cart synchronization deadline'));
      }, 8000);
      socket.on('cart:synced', handler);
    });

  beforeAll(async () => {
    if (process.env.NODE_ENV === 'production' || !process.env.MONGODB_URI)
      throw new Error(
        'Requires development/test Mongo; isolated dbName override mandatory',
      );
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('External network forbidden'));
    warnings = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errors = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideModule(DatabaseModule)
      .useModule({
        module: ReleaseDatabase,
        imports: [
          MongooseModule.forRoot(process.env.MONGODB_URI, {
            dbName,
            retryAttempts: 0,
            serverSelectionTimeoutMS: 15000,
          }),
        ],
      })
      .overrideProvider(AiConfig)
      .useValue(new AiConfig(config))
      .compile();
    jest
      .spyOn(fixture.get(AppService), 'onApplicationBootstrap')
      .mockResolvedValue(undefined);
    const appConfig = fixture.get(ConfigService);
    appConfig.set('VNP_TMN_CODE', 'P24TEST');
    appConfig.set('VNP_HASH_SECRET', 'phase24-synthetic-signature-key');
    appConfig.set(
      'VNP_URL',
      'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    );
    appConfig.set('VNP_RETURN_URL', 'http://127.0.0.1/unused-return');
    app = fixture.createNestApplication<INestApplication<App>>();
    // Only this loopback test app trusts simulated source IPs to isolate quota cases.
    (
      app.getHttpAdapter().getInstance() as {
        set: (key: string, value: string) => void;
      }
    ).set('trust proxy', 'loopback');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
    connection = fixture.get(getConnectionToken());
    expect(connection.name).toBe(dbName);
    tables = fixture.get(getModelToken(Table.name));
    sessions = fixture.get(getModelToken(Session.name));
    dishes = fixture.get(getModelToken(Dish.name));
    categories = fixture.get(getModelToken(Category.name));
    orders = fixture.get(getModelToken(Order.name));
    reviews = fixture.get(getModelToken(Review.name));
    audits = fixture.get(getModelToken(AiInteraction.name));
    intents = fixture.get(getModelToken(PaymentIntent.name));
    vnpay = fixture.get(VnpayService);
    menu = fixture.get(MenuService);
    const jwt = new JwtService({
      secret:
        appConfig.get<string>('JWT_ACCESS_SECRET') ||
        'default_access_secret_1234567890',
    });
    const auth = (role: string) =>
      `Bearer ${jwt.sign({ sub: new Types.ObjectId().toString(), email: 'p24@example.invalid', role })}`;
    admin = auth('admin');
    kitchen = auth('kitchen');
    waiter = auth('waiter');
    await tables.create({
      _id: tableId,
      tableCode: 'P24',
      qrCodeUrl: 'synthetic',
      currentSessionId: sessionId,
      status: TableStatus.OCCUPIED,
    });
    await sessions.create({
      _id: sessionId,
      tableId,
      tableIds: [tableId],
      status: SessionStatus.ACTIVE,
      cart: [],
    });
    await categories.create({
      _id: categoryId,
      name: 'Món ăn',
      isActive: true,
    });
    await dishes.insertMany(
      [
        {
          _id: dishIds[0],
          name: 'Phở bò tái',
          price: 80000,
          ingredients: ['bò'],
          spiceLevel: 0,
        },
        {
          _id: dishIds[1],
          name: 'Đậu hũ',
          price: 40000,
          ingredients: ['đậu hũ'],
          dietaryTags: ['vegetarian'],
          spiceLevel: 0,
        },
        { _id: dishIds[2], name: 'Món thiếu metadata', price: 30000 },
        {
          _id: dishIds[3],
          name: 'Bò đậu phộng',
          price: 90000,
          ingredients: ['bò', 'đậu phộng'],
          allergenTags: ['peanut'],
          spiceLevel: 1,
        },
        {
          _id: dishIds[4],
          name: 'Bún bò Huế',
          price: 120000,
          ingredients: ['bò', 'đậu phộng'],
          allergenTags: ['peanut'],
          spiceLevel: 2,
        },
      ].map((d) => ({
        ...d,
        categoryId,
        isAvailable: true,
        availableModifiers: ['NO_ONION'],
      })),
    );
    // These two authored reviews exist only to exercise failure paths with nonempty samples.
    await reviews.insertMany(
      seedReviewIds.map((_id, i) => ({
        _id,
        orderId: new Types.ObjectId(),
        sessionId,
        tableId,
        dishId: dishIds[0],
        rating: 4,
        comment: `P24_SYNTHETIC_REVIEW_${i}`,
        createdAt: new Date('2026-01-01T12:00:00Z'),
        ...(i
          ? {
              aiInsight: {
                sentiment: 'positive',
                topics: [{ topic: 'taste', sentiment: 'positive' }],
                taxonomyVersion: 'review-topics-v1',
                modelVersion: 'synthetic',
                analyzedAt: new Date(),
              },
            }
          : {}),
      })),
    );
    await audits.init();
    await intents.init();
  });
  afterAll(async () => {
    try {
      if (connection?.name === dbName) {
        // Exact fixture ownership / IDs only, never drop a database or touch app/demo records.
        await intents.deleteMany({ sessionId });
        await reviews.deleteMany({ sessionId });
        await orders.deleteMany({ sessionId });
        await sessions.deleteOne({ _id: sessionId });
        await tables.deleteOne({ _id: tableId });
        await dishes.deleteMany({ _id: { $in: dishIds } });
        await categories.deleteOne({ _id: categoryId });
        const ids = await audits
          .find({ model: 'phase24-fixture' })
          .select('_id')
          .lean();
        await audits.deleteMany({ _id: { $in: ids.map((d) => d._id) } });
        for (const collection of Object.values(connection.collections))
          expect(await collection.countDocuments()).toBe(0);
        const folder = join(__dirname, '../../docs/evaluation');
        mkdirSync(folder, { recursive: true });
        writeFileSync(
          join(folder, 'phase24-http.json'),
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              provider:
                'real adapter with fetch simulation; no real tokens/cost',
              database: 'isolated synthetic Mongo',
              failureMatrix: rows,
              coreRegressions: coreRows,
              goldenDatabase: goldenRows,
              benchmark,
              cleanup: 'PASS',
            },
            null,
            2,
          ) + '\n',
        );
      }
    } finally {
      if (app) await app.close();
      jest.restoreAllMocks();
    }
  });

  describe.each(modes)('$name', (mode) => {
    it.each(endpoints)(
      '%s contains failure, preserves business records, records attempts without sensitive content',
      async (endpoint) => {
        configure(mode, endpoint);
        const before = await snapshot();
        const auditCount = await audits.countDocuments();
        const route = routes[endpoint];
        const started = performance.now();
        const response = await post(
          route.path,
          {
            ...route.body(),
            ...(mode.name === 'malformed-client'
              ? { mongoQuery: { $where: 'return true' } }
              : {}),
          },
          route.auth(),
        );
        const latencyMs = Math.round(performance.now() - started);
        if (mode.name === 'malformed-client') expect(response.status).toBe(400);
        else if (endpoint === 'search') {
          expect(response.status).toBe(200);
          expect(body(response).fallbackUsed).toBe(true);
          expect(
            body(response).result.dishes.map((d: { _id: string }) => d._id),
          ).toEqual([dishIds[0].toString()]);
          expect(body(response).result.appliedFilters).toEqual({});
          expect(body(response).warnings.length).toBeGreaterThan(0);
        } else if (endpoint === 'review-classify') {
          expect(response.status).toBe(200);
          expect(response.body).toMatchObject({
            attempted: 1,
            analyzed: 0,
            outcomes: [{ status: 'failed', code: mode.code }],
          });
        } else if (endpoint === 'review-summary') {
          expect(response.status).toBe(200);
          expect(response.body).toMatchObject({
            summaryStatus: 'unavailable',
            summary: null,
            errorCode: mode.code,
            facts: { sampleSize: 1, totalReviews: 2, commentCount: 2 },
          });
        } else {
          expect(response.status).toBe(mode.status);
          expect(body(response).code).toBe(mode.code);
        }
        const extraIntent =
          endpoint === 'analytics-answer' && mode.attempts > 0 ? 1 : 0;
        expect(fetchMock).toHaveBeenCalledTimes(mode.attempts + extraIntent);
        if (mode.name === 'timeout') {
          expect(signals.slice(extraIntent).every((s) => s.aborted)).toBe(true);
          expect(latencyMs).toBeGreaterThanOrEqual(450);
          expect(latencyMs).toBeLessThan(5000);
        }
        expect(await snapshot()).toBe(before);
        const entries = await audits
          .find()
          .sort({ createdAt: 1 })
          .skip(auditCount)
          .lean();
        if (mode.name === 'malformed-client') expect(entries).toHaveLength(0);
        else
          expect(entries.at(-1)).toMatchObject({
            success: false,
            attempts: mode.attempts,
            errorCode: mode.code,
          });
        const privateSurface = JSON.stringify({
          response: response.body as unknown,
          audits: entries,
          logs: [
            ...(warnings.mock.calls as unknown[][]),
            ...(errors.mock.calls as unknown[][]),
          ],
        });
        for (const secret of [
          syntheticKey,
          rawNote,
          'P24_SYSTEM_CANARY',
          'P24_REASONING_CANARY',
          'db.users.find()',
          'P24_SYNTHETIC_REVIEW',
        ])
          expect(privateSurface).not.toContain(secret);
        expect(
          entries.every(
            (e) => e.inputTokens === undefined && e.outputTokens === undefined,
          ),
        ).toBe(true);
        rows.push({
          feature: endpoint,
          failure: mode.name,
          status: 'PASS',
          httpStatus: response.status,
          latencyMs,
          attempts: mode.attempts,
          retries: Math.max(0, mode.attempts - 1),
          tokenUsage: 'not reported',
        });
      },
    );
    it('Menu → two-client Cart → Order → Kitchen → Waiter → Session payment → Review → Dashboard stays usable', async () => {
      configure(mode);
      await coreFlow();
      expect(fetchMock).not.toHaveBeenCalled();
      coreRows.push(`${mode.name}: PASS`);
    });
  });

  async function coreFlow(analysisToken?: string) {
    await request(app.getHttpServer())
      .get('/menu')
      .query({ tableId: ownership.tableId })
      .expect(200);
    const sockets = [0, 1].map(() =>
      io('http://127.0.0.1', {
        autoConnect: false,
        transports: ['websocket'],
        reconnection: false,
      }),
    );
    const created: string[] = [];
    try {
      for (let i = 0; i < sockets.length; i++) {
        sockets[i] = io(await app.getUrl(), {
          autoConnect: false,
          transports: ['websocket'],
          reconnection: false,
        });
        const ready = waitCart(sockets[i], () => true);
        sockets[i].on('connect', () =>
          sockets[i].emit('cart:join', { sessionId: ownership.sessionId }),
        );
        sockets[i].connect();
        await ready;
      }
      for (let turn = 0; turn < 2; turn++) {
        const synced = sockets.map((s) =>
          waitCart(s, (c) => c.cart.length === 1),
        );
        sockets[turn].emit('cart:add', {
          sessionId: ownership.sessionId,
          dishId: dishIds[0].toString(),
          quantity: 1,
          note: rawNote,
          analysisToken,
          confirmedByCustomer: !!analysisToken,
        });
        for (const cart of await Promise.all(synced)) {
          expect(cart.cart[0].note).toBe(rawNote);
          if (analysisToken)
            expect(cart.cart[0].aiNoteAnalysis?.modifierTags).toEqual([
              'NO_ONION',
            ]);
        }
        const order = await post('/orders', {
          tableId: ownership.tableId,
        }).expect(201);
        const id = String(body(order).orderId);
        created.push(id);
        const stored = await orders.findById(id).exec();
        expect(stored?.items[0].note).toBe(rawNote);
        const itemId = stored!.items[0]._id.toString();
        await request(app.getHttpServer())
          .get('/orders/kitchen')
          .set('Authorization', kitchen)
          .expect(200);
        for (const status of [
          OrderStatus.PREPARING,
          OrderStatus.READY,
          OrderStatus.SERVED,
        ]) {
          await request(app.getHttpServer())
            .patch(`/orders/${id}/items/${itemId}/status`)
            .set(
              'Authorization',
              status === OrderStatus.SERVED ? waiter : kitchen,
            )
            .send({ status })
            .expect(200);
        }
        await request(app.getHttpServer())
          .get('/orders/waiter')
          .set('Authorization', waiter)
          .expect(200);
      }
      const payment = await post('/vnpay/create-payment-url', ownership).expect(
        201,
      );
      expect(body(payment).amount).toBe(160000);
      expect([...body(payment).coveredOrderIds].sort()).toEqual(
        [...created].sort(),
      );
      const params: Record<string, string> = {
        vnp_TxnRef: String(body(payment).txnRef),
        vnp_Amount: '16000000',
        vnp_ResponseCode: '00',
        vnp_TransactionNo: 'P24_SYNTHETIC_IPN',
      };
      params.vnp_SecureHash = (
        vnpay as unknown as { sign: (p: Record<string, string>) => string }
      ).sign(params);
      await request(app.getHttpServer())
        .get('/vnpay/ipn')
        .query(params)
        .expect(200)
        .expect({ RspCode: '00', Message: 'Confirm Success' });
      await request(app.getHttpServer())
        .get('/vnpay/ipn')
        .query(params)
        .expect(200)
        .expect({ RspCode: '02', Message: 'Order already confirmed' });
      expect(
        (await orders.find({ _id: { $in: created } }).lean()).every(
          (o) => o.status === OrderStatus.PAID,
        ),
      ).toBe(true);
      expect((await sessions.findById(sessionId).lean())?.status).toBe(
        'active',
      );
      await post('/reviews', {
        orderId: created[0],
        dishId: dishIds[0].toString(),
        sessionId: ownership.sessionId,
        rating: 5,
        comment: 'Món ngon.',
      }).expect(201);
      const revenue = await request(app.getHttpServer())
        .get('/admin/analytics/revenue')
        .set('Authorization', admin)
        .expect(200);
      const totals = revenue.body as { revenue: number; orders: number }[];
      expect(totals.reduce((n, r) => n + r.revenue, 0)).toBe(
        (await orders.countDocuments({ status: OrderStatus.PAID })) * 80000,
      );
    } finally {
      sockets.forEach((s) => s.disconnect());
    }
  }

  it.each(searchCases)('golden DB filter: $id', async (c) => {
    config.set('AI_ENABLED', 'true');
    config.set('AI_API_KEY', syntheticKey);
    installFetch(() => envelope(c.intent));
    const response = await post('/ai/menu/search', {
      tableId: ownership.tableId,
      query: c.query,
    }).expect(200);
    expect(
      body(response)
        .result.dishes.map((d: { name: string }) => d.name)
        .sort(),
    ).toEqual([...c.expectedNames].sort());
    for (const dish of body(response).result.dishes as {
      _id: string;
      price: number;
      ingredients: string[];
      allergenTags: string[];
    }[]) {
      const record = await dishes.findById(dish._id).lean();
      expect(record).not.toBeNull();
      expect(dish.price).toBe(record!.price);
      expect(dish.ingredients).toEqual(record!.ingredients ?? []);
      expect(dish.allergenTags).toEqual(record!.allergenTags ?? []);
    }
    goldenRows.push(`${c.id}: PASS`);
  });

  it('Semantic → selected Dish → confirmed AI note → shared cart → Paid → Review Intelligence → Analytics', async () => {
    config.set('AI_ENABLED', 'true');
    config.set('AI_API_KEY', syntheticKey);
    installFetch((body) => {
      const format = body.text.format;
      if (format.name === 'menu_search_v1')
        return envelope({
          ...emptyMenuIntent(),
          requiredIngredients: ['beef'],
          excludedAllergens: ['peanut'],
        });
      if (format.name === 'order_note_v2')
        return envelope({
          modifierTags: ['NO_ONION'],
          allergyMentioned: true,
          forChildren: false,
          needsStaffReview: true,
        });
      if (format.name === 'review_classification_v1')
        return envelope({
          sentiment: 'positive',
          topics: [{ topic: 'taste', sentiment: 'positive' }],
        });
      if (format.name === 'admin_analytics_intent')
        return envelope(analyticsIntent());
      return envelope({ answer: format.schema.properties.answer!.enum[0] });
    });
    const selected = await post('/ai/menu/search', {
      tableId: ownership.tableId,
      query: 'có bò nhưng không đậu phộng',
    }).expect(200);
    expect(
      body(selected).result.dishes.map((d: { _id: string }) => d._id),
    ).toEqual([dishIds[0].toString()]);
    const note = await post('/ai/order-notes/analyze', {
      ...noteInput,
      dishId: body(selected).result.dishes[0]._id,
    }).expect(200);
    const calls = fetchMock.mock.calls.length;
    await coreFlow(String(body(note).analysisToken));
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    const today = new Date().toISOString().slice(0, 10);
    const filter = { fromDate: today, toDate: today };
    const enriched = await post(
      '/ai/admin/review-insights/analyze',
      filter,
      admin,
    ).expect(200);
    expect(body(enriched).analyzed).toBe(5);
    const summary = await post(
      '/ai/admin/review-insights/summary',
      filter,
      admin,
    ).expect(200);
    expect(body(summary).summaryStatus).toBe('ready');
    expect(body(summary).facts.sampleSize).toBe(5);
    expect(body(summary).facts.commentCount).toBe(8);
    const analytics = await post(
      '/ai/admin/analytics/query',
      { query: 'doanh thu' },
      admin,
    ).expect(200);
    const analyticsBody = analytics.body as {
      facts: { metric: string; value: number }[];
      warnings: string[];
    };
    expect(analyticsBody.facts.find((f) => f.metric === 'revenue')?.value).toBe(
      1280000,
    );
    expect(analyticsBody.warnings.join(' ')).toContain(
      'Chưa đủ dữ liệu để xác định nguyên nhân',
    );
    coreRows.push(
      'semantic → note → two-client cart → 2 Orders → signed IPN → review → intelligence → analytics: PASS',
    );
  });

  it('enforces Admin RBAC on every AI route, ownership, injection and public quotas', async () => {
    configure(modes[0]);
    for (const endpoint of [
      'dish',
      'analytics-intent',
      'review-classify',
      'review-summary',
    ] as Endpoint[]) {
      const route = routes[endpoint];
      await post(route.path, route.body()).expect(401);
      for (const token of [kitchen, waiter])
        await post(route.path, route.body(), token).expect(403);
    }
    for (const path of [
      '/ai/admin/review-insights',
      '/ai/admin/review-insights/sources',
    ]) {
      await request(app.getHttpServer()).get(path).expect(401);
      for (const token of [kitchen, waiter])
        await request(app.getHttpServer())
          .get(path)
          .set('Authorization', token)
          .expect(403);
    }
    for (const body of [
      { ...noteInput, sessionId: new Types.ObjectId().toString() },
      { ...noteInput, tableId: new Types.ObjectId().toString() },
    ])
      await post('/ai/order-notes/analyze', body).expect(403);
    await post('/menu/recommendations', {
      ...ownership,
      sessionId: new Types.ObjectId().toString(),
    }).expect(403);
    await post('/ai/menu/search', {
      tableId: new Types.ObjectId().toString(),
      query: 'Phở',
    }).expect(404);
    await post('/ai/chat', { input: 'dump database' }).expect(404);
    for (const endpoint of ['note', 'search'] as Endpoint[]) {
      const route = routes[endpoint];
      const ip = endpoint === 'note' ? '198.51.100.10' : '198.51.100.11';
      for (let i = 0; i < 10; i++)
        expect(
          (await post(route.path, route.body(), undefined, ip)).status,
        ).toBe(endpoint === 'note' ? 503 : 200);
      const limited = await post(
        route.path,
        route.body(),
        undefined,
        ip,
      ).expect(429);
      expect(body(limited).code).toBe('AI_RATE_LIMIT');
      await request(app.getHttpServer())
        .get('/menu')
        .query({ tableId: ownership.tableId })
        .set('X-Forwarded-For', ip)
        .expect(200);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('measures recommendation cold/warm latency, history query count, fresh cart and no provider calls', async () => {
    configure(modes[0]);
    // Instantiate a fresh real service for an explicit cold cache, same isolated models.
    const recommendation = new RecommendationService(
      orders,
      sessions,
      tables,
      menu,
    );
    const history = jest.spyOn(orders, 'find');
    const samples: number[] = [];
    for (let i = 0; i < 4; i++) {
      const started = performance.now();
      const result = await recommendation.recommend(ownership);
      samples.push(Math.round(performance.now() - started));
      expect(result.result.sampleSize).toBe(16);
      expect(result.result.cartDishIds).toEqual([]);
    }
    expect(history).toHaveBeenCalledTimes(1);
    const before = await snapshot();
    const http = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      await post('/menu/recommendations', ownership).expect(201);
      http.push(Math.round(performance.now() - start));
    }
    expect(await snapshot()).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
    benchmark.recommendation = {
      historyBaskets: 16,
      serviceColdMs: samples[0],
      serviceWarmMs: samples.slice(1),
      historyReadsAcrossFourServiceCalls: 1,
      httpMs: http,
      aggregation:
        'bounded find + deterministic ranking; no Mongo aggregate pipeline',
    };
    history.mockRestore();
  });

  it('measures successful AI HTTP endpoints and verifies minimized provider payloads', async () => {
    config.set('AI_ENABLED', 'true');
    config.set('AI_API_KEY', syntheticKey);
    installFetch((input) => {
      const format = input.text.format;
      if (format.name.startsWith('dish_draft'))
        return envelope({ nameEn: 'Phở bò tái' });
      if (format.name === 'menu_search_v1')
        return envelope({ ...emptyMenuIntent(), keywords: ['Phở'] });
      if (format.name === 'order_note_v2')
        return envelope({
          modifierTags: [],
          allergyMentioned: true,
          forChildren: false,
          needsStaffReview: true,
        });
      if (format.name === 'admin_analytics_intent')
        return envelope(analyticsIntent());
      if (format.name === 'review_classification_v1')
        return envelope({
          sentiment: 'neutral',
          topics: [{ topic: 'other', sentiment: 'neutral' }],
        });
      return envelope({ answer: format.schema.properties.answer!.enum[0] });
    });
    const results: Record<string, unknown>[] = [];
    for (const endpoint of endpoints.filter((e) => e !== 'analytics-answer')) {
      const route = routes[endpoint],
        durations: number[] = [],
        attempts: number[] = [];
      for (let i = 0; i < 3; i++) {
        if (endpoint === 'review-classify')
          await reviews.updateOne(
            { _id: seedReviewIds[0] },
            { $unset: { aiInsight: 1 } },
            { timestamps: false },
          );
        const previousCalls = fetchMock.mock.calls.length;
        const start = performance.now();
        const response = await post(
          route.path,
          route.body(),
          route.auth(),
        ).expect(200);
        durations.push(Math.round(performance.now() - start));
        attempts.push(fetchMock.mock.calls.length - previousCalls);
        if (endpoint === 'review-classify')
          expect(body(response).analyzed).toBe(1);
        if (endpoint === 'review-summary')
          expect(body(response).summaryStatus).toBe('ready');
        expect(JSON.stringify(response.body as unknown)).not.toMatch(
          /P24_SYSTEM_CANARY|P24_REASONING_CANARY|P24_SYNTHETIC_KEY_CANARY/,
        );
      }
      expect(attempts).toEqual(
        Array(3).fill(endpoint === 'analytics-intent' ? 2 : 1),
      );
      results.push({
        endpoint,
        samplesMs: durations,
        medianMs: [...durations].sort((a, b) => a - b)[1],
        providerCallsPerRequest: attempts,
        retries: 0,
        tokenUsage: 'not reported',
        providerLatency: 'simulated; not a live provider measurement',
      });
    }
    for (const input of providerInputs) {
      expect(input.store).toBe(false);
      expect(input.input.map((m) => m.role)).toEqual(['system', 'user']);
      expect(JSON.stringify(input)).not.toContain(syntheticKey);
      const user = JSON.parse(input.input[1].content) as Record<
        string,
        unknown
      >;
      expect(Object.keys(user)).not.toEqual(
        expect.arrayContaining(['sessionId', 'tableId']),
      );
      if (input.text.format.name === 'review_summary_v1')
        expect(JSON.stringify(user)).not.toContain('P24_SYNTHETIC_REVIEW');
    }
    benchmark.aiSuccess = results;
  });
});
