import 'dotenv/config';
import * as dns from 'dns';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { OrderStatus } from '../src/common/enums/order-status.enum';
import { SessionStatus } from '../src/common/enums/session-status.enum';
import { TableStatus } from '../src/common/enums/table-status.enum';
import { Dish, DishDocument } from '../src/modules/dish/dish.schema';
import { Order, OrderDocument } from '../src/modules/order/order.schema';
import { AbandonedSessionCleanupService } from '../src/modules/session/abandoned-session-cleanup.service';
import {
  Session,
  SessionDocument,
} from '../src/modules/session/session.schema';
import { SessionService } from '../src/modules/session/session.service';
import { Table, TableDocument } from '../src/modules/table/table.schema';
import {
  PaymentIntent,
  PaymentIntentDocument,
  PaymentIntentStatus,
} from '../src/modules/vnpay/payment-intent.schema';

if (process.env.CUSTOM_DNS_SERVERS) {
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
}

// Isolate this suite from ordinary dev Sessions in the shared Atlas database.
// Fixtures marked 2010 are stale; normal documents cannot reach this 10-year cutoff.
const originalTimeout = process.env.EMPTY_SESSION_TIMEOUT_MINUTES;
process.env.EMPTY_SESSION_TIMEOUT_MINUTES = '5256000';
jest.setTimeout(60_000);

describe('Abandoned zero-Order Session lifecycle (real MongoDB + Socket.io)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let sessionModel: Model<SessionDocument>;
  let tableModel: Model<TableDocument>;
  let orderModel: Model<OrderDocument>;
  let dishModel: Model<DishDocument>;
  let paymentIntentModel: Model<PaymentIntentDocument>;
  let cleanupService: AbandonedSessionCleanupService;
  let sessionService: SessionService;
  let dish: DishDocument;
  const tableIds: Types.ObjectId[] = [];
  const sessionIds: Types.ObjectId[] = [];
  const orderIds: Types.ObjectId[] = [];
  const paymentIntentIds: Types.ObjectId[] = [];
  const staleAt = new Date('2010-01-01T00:00:00.000Z');

  const createTableAndSession = async (
    cart: Array<{
      dishId: Types.ObjectId;
      dishName: string;
      unitPrice: number;
      quantity: number;
      note?: string;
    }> = [],
    tableStatus = TableStatus.OCCUPIED,
  ) => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const table = await tableModel.create({
      tableCode: `__AB_${suffix}__`,
      status: tableStatus,
      qrCodeUrl: 'data:image/png;base64,e2e',
      currentSessionId: null,
    });
    tableIds.push(table._id);
    const session = await sessionModel.create({
      tableId: table._id,
      tableIds: [table._id],
      status: SessionStatus.ACTIVE,
      cart,
      lastActivityAt: staleAt,
    });
    sessionIds.push(session._id);
    await tableModel.updateOne(
      { _id: table._id },
      { $set: { currentSessionId: session._id } },
    );
    return { table, session };
  };

  const createOrder = async (
    session: SessionDocument,
    table: TableDocument,
    status: OrderStatus,
  ) => {
    const order = await orderModel.create({
      sessionId: session._id,
      tableId: table._id,
      status,
      items: [
        {
          dishId: dish._id,
          dishName: dish.name,
          unitPrice: dish.price,
          quantity: 1,
          status,
        },
      ],
      subtotalAmount: dish.price,
      discountAmount: 0,
      totalAmount: dish.price,
    });
    orderIds.push(order._id);
    return order;
  };

  const connectToRoom = async (room: 'waiter' | 'admin') => {
    const socket = io(baseUrl, { transports: ['websocket'], forceNew: true });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    await new Promise<void>((resolve) => {
      socket.once('joined', () => resolve());
      socket.emit('join', { room });
    });
    return socket;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
    sessionModel = moduleFixture.get(getModelToken(Session.name));
    tableModel = moduleFixture.get(getModelToken(Table.name));
    orderModel = moduleFixture.get(getModelToken(Order.name));
    dishModel = moduleFixture.get(getModelToken(Dish.name));
    paymentIntentModel = moduleFixture.get(getModelToken(PaymentIntent.name));
    cleanupService = moduleFixture.get(AbandonedSessionCleanupService);
    sessionService = moduleFixture.get(SessionService);
    dish = await dishModel.create({
      name: `__abandonment_dish_${Date.now()}__`,
      price: 30_000,
      categoryId: new Types.ObjectId(),
      isAvailable: true,
    });
  });

  it('scan with zero Orders expires, releases the Table in realtime, and a new scan gets a new Session', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const table = await tableModel.create({
      tableCode: `__SCAN_${suffix}__`,
      status: TableStatus.AVAILABLE,
      qrCodeUrl: 'data:image/png;base64,e2e',
      currentSessionId: null,
    });
    tableIds.push(table._id);
    const firstScan = await request(app.getHttpServer())
      .get('/sessions/active')
      .query({ tableId: table.id })
      .expect(200);
    const firstSessionId = new Types.ObjectId(firstScan.body.sessionId);
    sessionIds.push(firstSessionId);
    expect((await tableModel.findById(table._id).exec())?.status).toBe(
      TableStatus.OCCUPIED,
    );
    await sessionModel.updateOne(
      { _id: firstSessionId },
      { $set: { lastActivityAt: staleAt } },
    );

    let waiterSocket: Socket | undefined;
    let adminSocket: Socket | undefined;
    try {
      [waiterSocket, adminSocket] = await Promise.all([
        connectToRoom('waiter'),
        connectToRoom('admin'),
      ]);
      const waiterUpdated = new Promise<void>((resolve) =>
        waiterSocket!.once('tables:updated', () => resolve()),
      );
      const adminUpdated = new Promise<void>((resolve) =>
        adminSocket!.once('tables:updated', () => resolve()),
      );

      await expect(cleanupService.cleanupAbandonedSessions()).resolves.toBe(1);
      await Promise.all([waiterUpdated, adminUpdated]);
    } finally {
      waiterSocket?.disconnect();
      adminSocket?.disconnect();
    }

    expect((await sessionModel.findById(firstSessionId).exec())?.status).toBe(
      SessionStatus.EXPIRED,
    );
    const releasedTable = await tableModel.findById(table._id).exec();
    expect(releasedTable?.status).toBe(TableStatus.AVAILABLE);
    expect(releasedTable?.currentSessionId).toBeNull();

    const secondScan = await request(app.getHttpServer())
      .get('/sessions/active')
      .query({ tableId: table.id })
      .expect(200);
    sessionIds.push(new Types.ObjectId(secondScan.body.sessionId));
    expect(secondScan.body.sessionId).not.toBe(firstSessionId.toString());
    expect(secondScan.body.cart).toEqual([]);
  });

  it('shared-cart activity from either tab extends timeout, then an abandoned non-empty cart expires', async () => {
    const { table, session } = await createTableAndSession();
    await sessionService.addToCart(session.id, dish.id, 1, 'Ít đá');
    await sessionService.addToCart(session.id, dish.id, 1, 'Ít đá');
    const afterTwoTabs = await sessionModel.findById(session._id).exec();
    expect(afterTwoTabs?.cart[0].quantity).toBe(2);
    expect(afterTwoTabs!.lastActivityAt.getTime()).toBeGreaterThan(
      staleAt.getTime(),
    );

    await expect(cleanupService.cleanupAbandonedSessions()).resolves.toBe(0);
    expect((await sessionModel.findById(session._id).exec())?.status).toBe(
      SessionStatus.ACTIVE,
    );

    await sessionModel.updateOne(
      { _id: session._id },
      { $set: { lastActivityAt: staleAt } },
    );
    await expect(cleanupService.cleanupAbandonedSessions()).resolves.toBe(1);
    const expired = await sessionModel.findById(session._id).exec();
    expect(expired?.status).toBe(SessionStatus.EXPIRED);
    expect(expired?.cart).toHaveLength(0);
    expect((await tableModel.findById(table._id).exec())?.status).toBe(
      TableStatus.AVAILABLE,
    );
  });

  it.each([
    OrderStatus.PENDING,
    OrderStatus.PREPARING,
    OrderStatus.READY,
    OrderStatus.SERVED,
    OrderStatus.PAID,
    OrderStatus.CANCELLED,
  ])(
    'an existing %s Order permanently disables abandonment timeout',
    async (status) => {
      const tableStatus =
        status === OrderStatus.PAID
          ? TableStatus.WAITING_PAYMENT
          : TableStatus.OCCUPIED;
      const { table, session } = await createTableAndSession([], tableStatus);
      const order = await createOrder(session, table, status);
      if (status === OrderStatus.SERVED) {
        const intent = await paymentIntentModel.create({
          txnRef: `AB_CANCEL_${Date.now()}_${Math.random()}`,
          coverageKey: `AB_CANCEL_COVERAGE_${Date.now()}_${Math.random()}`,
          sessionId: session._id,
          tableId: table._id,
          coveredOrderIds: [order._id],
          amount: order.totalAmount,
          paymentUrl: 'https://sandbox.vnpayment.vn/cancelled',
          status: PaymentIntentStatus.FAILED,
          expiresAt: new Date(Date.now() + 60_000),
          responseCode: '24',
        });
        paymentIntentIds.push(intent._id);
      }

      await cleanupService.cleanupAbandonedSessions();

      expect((await sessionModel.findById(session._id).exec())?.status).toBe(
        SessionStatus.ACTIVE,
      );
      expect((await tableModel.findById(table._id).exec())?.status).toBe(
        tableStatus,
      );
      if (status === OrderStatus.SERVED) {
        expect(
          await paymentIntentModel.exists({ sessionId: session._id }),
        ).not.toBeNull();
      }
    },
  );

  it('cart and create-Order races never leave a successful write inside an expired Session', async () => {
    const cartRace = await createTableAndSession([
      {
        dishId: dish._id,
        dishName: dish.name,
        unitPrice: dish.price,
        quantity: 1,
      },
    ]);
    const [cartCleanup, cartWrite] = await Promise.allSettled([
      cleanupService.cleanupAbandonedSessions(),
      sessionService.addToCart(cartRace.session.id, dish.id, 1),
    ]);
    const cartRaceAfter = await sessionModel
      .findById(cartRace.session._id)
      .exec();
    if (cartWrite.status === 'fulfilled') {
      expect(cartRaceAfter?.status).toBe(SessionStatus.ACTIVE);
      expect(cartRaceAfter!.lastActivityAt.getTime()).toBeGreaterThan(
        staleAt.getTime(),
      );
    } else {
      expect(cartCleanup.status).toBe('fulfilled');
      expect(cartRaceAfter?.status).toBe(SessionStatus.EXPIRED);
    }

    const orderRace = await createTableAndSession([
      {
        dishId: dish._id,
        dishName: dish.name,
        unitPrice: dish.price,
        quantity: 1,
      },
    ]);
    const [orderCleanup, orderWrite] = await Promise.allSettled([
      cleanupService.cleanupAbandonedSessions(),
      request(app.getHttpServer())
        .post('/orders')
        .send({ tableId: orderRace.table.id })
        .expect(201),
    ]);
    const orderRaceAfter = await sessionModel
      .findById(orderRace.session._id)
      .exec();
    const createdOrders = await orderModel
      .find({ sessionId: orderRace.session._id })
      .exec();
    orderIds.push(...createdOrders.map((order) => order._id));
    if (orderWrite.status === 'fulfilled') {
      expect(orderRaceAfter?.status).toBe(SessionStatus.ACTIVE);
      expect(createdOrders).toHaveLength(1);
    } else {
      expect(orderCleanup.status).toBe('fulfilled');
      expect(orderRaceAfter?.status).toBe(SessionStatus.EXPIRED);
      expect(createdOrders).toHaveLength(0);
    }
  });

  afterAll(async () => {
    await paymentIntentModel.deleteMany({ _id: { $in: paymentIntentIds } });
    await orderModel.deleteMany({ _id: { $in: orderIds } });
    await sessionModel.deleteMany({ _id: { $in: sessionIds } });
    await tableModel.deleteMany({ _id: { $in: tableIds } });
    if (dish) await dishModel.deleteOne({ _id: dish._id });
    await app.close();
    if (originalTimeout === undefined) {
      delete process.env.EMPTY_SESSION_TIMEOUT_MINUTES;
    } else {
      process.env.EMPTY_SESSION_TIMEOUT_MINUTES = originalTimeout;
    }
  });
});
