import 'dotenv/config';
import * as dns from 'dns';
import { randomUUID } from 'crypto';
import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
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
import { DatabaseModule } from '../src/database/database.module';
import { AiConfig } from '../src/modules/ai/ai.config';
import { AiError } from '../src/modules/ai/ai.errors';
import { AI_PROVIDER } from '../src/modules/ai/providers/ai-provider.interface';
import { AiInteraction } from '../src/modules/ai/schemas/ai-interaction.schema';
import {
  MockAiProvider,
  type MockAiStep,
} from '../src/modules/ai/testing/mock-ai-provider';
import { validAiEnv } from '../src/modules/ai/testing/ai-test.fixture';
import { Table } from '../src/modules/table/table.schema';
import { Session } from '../src/modules/session/session.schema';
import { SessionService } from '../src/modules/session/session.service';
import { Dish } from '../src/modules/dish/dish.schema';
import { Order } from '../src/modules/order/order.schema';
import type { OrderNoteAnalysis } from '../src/common/schemas/order-note-analysis.schema';
import { issueOrderNoteReceipt } from '../src/common/order-note-receipt';

if (process.env.CUSTOM_DNS_SERVERS)
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
jest.setTimeout(60000);
@Module({})
class IsolatedOrderNoteDatabaseModule {}
type Cart = {
  version: number;
  cart: {
    cartItemId: string;
    note?: string;
    quantity: number;
    aiNoteAnalysis?: OrderNoteAnalysis;
  }[];
};

type ResponseBody = {
  result: Pick<
    OrderNoteAnalysis,
    'summary' | 'modifierTags' | 'allergyMentioned'
  >;
  warnings: string[];
  modelVersion: string;
  analysisToken: string;
  orderId: string;
};
const body = (response: { body: unknown }) => response.body as ResponseBody;
describe('Phase 19 real HTTP/Mongo/Socket cart/order/Kitchen (mock provider)', () => {
  const dbName = `smartorder_p19_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const tableId = new Types.ObjectId();
  const otherTableId = new Types.ObjectId();
  const sessionId = new Types.ObjectId();
  const otherSessionId = new Types.ObjectId();
  const dishId = new Types.ObjectId();
  const note = 'Không hành, ít cay, dị ứng đậu phộng';
  const steps: MockAiStep[] = [];
  const provider = new MockAiProvider(steps);
  const config = new ConfigService({ ...validAiEnv, AI_MAX_RETRIES: '0' });
  let app: INestApplication<App>;
  let connection: Connection;
  let tables: Model<Table>;
  let sessions: Model<Session>;
  let dishes: Model<Dish>;
  let audits: Model<AiInteraction>;
  let orders: Model<Order>;
  let service: SessionService;
  let clients: Socket[] = [];
  let token: string;
  let snapshot: OrderNoteAnalysis;
  let orderId: string;
  let kitchenAuth: string;
  let waiterAuth: string;
  const post = () =>
    request(app.getHttpServer()).post('/ai/order-notes/analyze').send({
      sessionId: sessionId.toString(),
      tableId: tableId.toString(),
      dishId: dishId.toString(),
      note,
    });
  const waitCart = (socket: Socket, predicate: (cart: Cart) => boolean) =>
    new Promise<Cart>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off('cart:synced', listener);
        reject(new Error('Cart sync timed out'));
      }, 8000);
      const listener = (cart: Cart) => {
        if (predicate(cart)) {
          clearTimeout(timer);
          socket.off('cart:synced', listener);
          resolve(cart);
        }
      };
      socket.on('cart:synced', listener);
    });
  beforeAll(async () => {
    if (process.env.NODE_ENV === 'production' || !process.env.MONGODB_URI)
      throw new Error(
        'Requires non-production Mongo; isolated dbName always overrides URI',
      );
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Live provider forbidden'));
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideModule(DatabaseModule)
      .useModule({
        module: IsolatedOrderNoteDatabaseModule,
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
      .overrideProvider(AI_PROVIDER)
      .useValue(provider)
      .compile();
    jest
      .spyOn(fixture.get(AppService), 'onApplicationBootstrap')
      .mockResolvedValue(undefined);
    app = fixture.createNestApplication<INestApplication<App>>();
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
    audits = fixture.get(getModelToken(AiInteraction.name));
    orders = fixture.get(getModelToken(Order.name));
    service = fixture.get(SessionService);
    const secret =
      fixture.get(ConfigService).get<string>('JWT_ACCESS_SECRET') ||
      'default_access_secret_1234567890';
    const jwt = new JwtService({ secret });
    const auth = (role: string) =>
      `Bearer ${jwt.sign({ sub: new Types.ObjectId().toString(), email: 'test@example.invalid', role })}`;
    kitchenAuth = auth('kitchen');
    waiterAuth = auth('waiter');
    await tables.create([
      {
        _id: tableId,
        tableCode: 'P19-A',
        qrCodeUrl: 'test-only',
        currentSessionId: sessionId,
        status: 'occupied',
      },
      { _id: otherTableId, tableCode: 'P19-B', qrCodeUrl: 'test-only' },
    ]);
    await sessions.create({
      _id: sessionId,
      tableId,
      tableIds: [tableId],
      status: 'active',
      cart: [],
    });
    await dishes.create({
      _id: dishId,
      name: 'Món thử Phase 19',
      categoryId: new Types.ObjectId(),
      price: 50000,
      isAvailable: true,
      availableModifiers: ['NO_ONION', 'LESS_SPICY'],
      allergenTags: ['peanut'],
    });
    await audits.init();
    clients = [
      io(await app.getUrl(), { transports: ['websocket'], autoConnect: false }),
      io(await app.getUrl(), { transports: ['websocket'], autoConnect: false }),
    ];
    for (const socket of clients) {
      const synced = waitCart(socket, () => true);
      socket.on('connect', () =>
        socket.emit('cart:join', { sessionId: sessionId.toString() }),
      );
      socket.connect();
      await synced;
    }
  });
  afterAll(async () => {
    clients.forEach((socket) => socket.disconnect());
    try {
      if (connection?.name === dbName) {
        await orders?.deleteMany({ sessionId });
        await sessions?.deleteMany({
          _id: { $in: [sessionId, otherSessionId] },
        });
        await tables?.deleteMany({ _id: { $in: [tableId, otherTableId] } });
        await dishes?.deleteOne({ _id: dishId });
        const ids = await audits
          ?.find({ feature: 'order-note' })
          .select('_id')
          .lean();
        if (ids)
          await audits.deleteMany({
            _id: { $in: ids.map((item) => item._id) },
          });
        for (const collection of Object.values(connection.collections))
          expect(await collection.countDocuments()).toBe(0);
      }
    } finally {
      await app?.close();
      jest.restoreAllMocks();
    }
  });
  it('analyzes without changing session/dish and stores only private audit metadata', async () => {
    const before = JSON.stringify({
      session: await sessions.findById(sessionId).lean(),
      dish: await dishes.findById(dishId).lean(),
    });
    steps.push({
      output: {
        modifierTags: ['NO_ONION', 'LESS_SPICY'],
        allergyMentioned: false,
        forChildren: false,
        needsStaffReview: false,
      },
      usage: { inputTokens: 30, outputTokens: 10 },
    });
    const res = await post().expect(200);
    token = body(res).analysisToken;
    snapshot = {
      ...body(res).result,
      warnings: body(res).warnings,
      confirmedByCustomer: true,
      modelVersion: body(res).modelVersion,
      fallbackUsed: false,
    };
    expect(snapshot.allergyMentioned).toBe(true);
    expect(snapshot.warnings.join(' ')).toContain(
      'ghi nhận allergen đậu phộng',
    );
    expect(
      JSON.stringify({
        session: await sessions.findById(sessionId).lean(),
        dish: await dishes.findById(dishId).lean(),
      }),
    ).toBe(before);
    expect(await audits.findOne({ success: true }).lean()).toMatchObject({
      feature: 'order-note',
      promptVersion: 'order-note-v2',
      inputTokens: 30,
    });
    expect(JSON.stringify(await audits.find().lean())).not.toContain(note);
  });
  it('requires explicit confirmation; same normalized note updates one row and both clients see metadata', async () => {
    const synced = waitCart(clients[1], (cart) => cart.cart.length === 1);
    clients[0].emit('cart:add', {
      sessionId: sessionId.toString(),
      dishId: dishId.toString(),
      quantity: 1,
      note: `  ${note}  `,
      analysisToken: token,
    });
    const first = await synced;
    expect(first.cart[0].note).toBe(note);
    expect(first.cart[0].aiNoteAnalysis).toBeUndefined();
    const updates = clients.map((client) =>
      waitCart(client, (cart) => cart.cart[0]?.quantity === 2),
    );
    clients[1].emit('cart:add', {
      sessionId: sessionId.toString(),
      dishId: dishId.toString(),
      quantity: 1,
      note,
      analysisToken: token,
      confirmedByCustomer: true,
    });
    for (const cart of await Promise.all(updates)) {
      expect(cart.cart).toHaveLength(1);
      expect(cart.cart[0].aiNoteAnalysis).toEqual(snapshot);
      expect(cart.cart[0].cartItemId).toBe(first.cart[0].cartItemId);
    }
  });
  it('keeps different notes separate, drops forged/replayed metadata, concurrent adds preserve quantity', async () => {
    await service.addToCart(
      sessionId.toString(),
      dishId.toString(),
      1,
      'ít cay',
      token,
      true,
    );
    await service.addToCart(
      sessionId.toString(),
      dishId.toString(),
      1,
      'ghi chú khác',
      'forged',
      true,
    );
    await Promise.all(
      Array.from({ length: 8 }, () =>
        service.addToCart(
          sessionId.toString(),
          dishId.toString(),
          1,
          note,
          token,
          true,
        ),
      ),
    );
    const cart = await service.getCart(sessionId.toString());
    expect(cart.cart).toHaveLength(3);
    expect(cart.cart.find((item) => item.note === note)).toMatchObject({
      quantity: 10,
      aiNoteAnalysis: snapshot,
    });
    expect(
      cart.cart
        .filter((item) => item.note !== note)
        .every((item) => !item.aiNoteAnalysis),
    ).toBe(true);
  });
  it('moving tables preserves cart notes and accepted metadata', async () => {
    const before = JSON.stringify(
      (await service.getCart(sessionId.toString())).cart,
    );
    await service.moveSessionToTable(
      sessionId.toString(),
      otherTableId.toString(),
    );
    expect(
      JSON.stringify((await service.getCart(sessionId.toString())).cart),
    ).toBe(before);
    await service.moveSessionToTable(sessionId.toString(), tableId.toString());
    expect(
      JSON.stringify((await service.getCart(sessionId.toString())).cart),
    ).toBe(before);
  });
  it('merge/unmerge preserves identity, quantities and accepted metadata snapshots', async () => {
    await sessions.create({
      _id: otherSessionId,
      tableId: otherTableId,
      tableIds: [otherTableId],
      status: 'active',
      cart: [],
    });
    await tables.updateOne(
      { _id: otherTableId },
      { $set: { currentSessionId: otherSessionId, status: 'occupied' } },
    );
    const receipt = issueOrderNoteReceipt(
      otherSessionId.toString(),
      dishId.toString(),
      note,
      snapshot,
    );
    await service.addToCart(
      otherSessionId.toString(),
      dishId.toString(),
      1,
      note,
      receipt,
      true,
    );
    await service.mergeTables(otherTableId.toString(), tableId.toString());
    const merged = await service.getCart(sessionId.toString());
    expect(merged.cart).toHaveLength(3);
    expect(merged.cart.find((item) => item.note === note)).toMatchObject({
      quantity: 11,
      aiNoteAnalysis: snapshot,
    });
    await service.unmergeSession(otherSessionId.toString());
    const root = await service.getCart(sessionId.toString());
    const child = await service.getCart(otherSessionId.toString());
    expect(root.cart.find((item) => item.note === note)).toMatchObject({
      quantity: 10,
      aiNoteAnalysis: snapshot,
    });
    expect(child.cart[0]).toMatchObject({
      quantity: 1,
      note,
      aiNoteAnalysis: snapshot,
    });
  });
  it('disabled AI does not block POST /orders; snapshot and Kitchen preserve original plus confirmed metadata', async () => {
    config.set('AI_ENABLED', 'false');
    await post().expect(503);
    const callsBefore = provider.calls.length;
    const res = await request(app.getHttpServer())
      .post('/orders')
      .send({ tableId: tableId.toString() })
      .expect(201);
    orderId = body(res).orderId;
    expect(provider.calls).toHaveLength(callsBefore);
    const order = await orders.findById(orderId).lean();
    expect(order?.items.find((item) => item.note === note)).toMatchObject({
      note,
      aiNoteAnalysis: snapshot,
      quantity: 10,
    });
    expect((await service.getCart(sessionId.toString())).cart).toHaveLength(0);
    const kitchen = await request(app.getHttpServer())
      .get('/orders/kitchen')
      .set('Authorization', kitchenAuth)
      .expect(200);
    expect(
      (kitchen.body as { items: { note?: string }[] }[])[0].items.find(
        (item: { note?: string }) => item.note === note,
      ),
    ).toMatchObject({ note, aiNoteAnalysis: snapshot });
  });
  it('Kitchen transitions keep snapshots and reject skipped state/incorrect role', async () => {
    const order = await orders.findById(orderId).orFail();
    for (const item of order.items) {
      const url = `/orders/${orderId}/items/${item._id.toString()}/status`;
      await request(app.getHttpServer())
        .patch(url)
        .set('Authorization', kitchenAuth)
        .send({ status: 'Ready' })
        .expect(403);
      await request(app.getHttpServer())
        .patch(url)
        .set('Authorization', waiterAuth)
        .send({ status: 'Preparing' })
        .expect(403);
      await request(app.getHttpServer())
        .patch(url)
        .set('Authorization', kitchenAuth)
        .send({ status: 'Preparing' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(url)
        .set('Authorization', kitchenAuth)
        .send({ status: 'Ready' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(url)
        .set('Authorization', waiterAuth)
        .send({ status: 'Served' })
        .expect(200);
    }
    const stored = await orders.findById(orderId).orFail();
    expect(stored.status).toBe('Served');
    expect(
      stored.items.find((item) => item.note === note)?.aiNoteAnalysis?.summary,
    ).toBe(snapshot.summary);
  });
  it.each(['unavailable', 'timeout', 'invalid-output', 'missing-key'])(
    '%s never blocks a later original-note order',
    async (kind) => {
      config.set('AI_ENABLED', 'true');
      config.set('AI_API_KEY', validAiEnv.AI_API_KEY);
      config.set('AI_TIMEOUT_MS', '100');
      if (kind === 'unavailable')
        steps.push(new AiError('AI_PROVIDER_UNAVAILABLE'));
      if (kind === 'timeout') steps.push(() => new Promise(() => {}));
      if (kind === 'invalid-output')
        steps.push({ output: { summary: 'unsafe extra prose' } });
      if (kind === 'missing-key') config.set('AI_API_KEY', '');
      await post().expect(
        kind === 'timeout' ? 504 : kind === 'invalid-output' ? 502 : 503,
      );
      const callsBefore = provider.calls.length;
      await service.addToCart(sessionId.toString(), dishId.toString(), 1, note);
      const res = await request(app.getHttpServer())
        .post('/orders')
        .send({ tableId: tableId.toString() })
        .expect(201);
      expect(provider.calls).toHaveLength(callsBefore);
      const order = await orders.findById(body(res).orderId).orFail();
      expect(order.items[0].note).toBe(note);
      expect(order.items[0].aiNoteAnalysis).toBeUndefined();
    },
  );
});
