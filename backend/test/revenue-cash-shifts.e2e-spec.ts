import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Connection, Model, Types } from 'mongoose';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/common/enums/user-role.enum';
import { OrderStatus } from '../src/common/enums/order-status.enum';
import { TableStatus } from '../src/common/enums/table-status.enum';
import { User } from '../src/modules/user/user.schema';
import { Order } from '../src/modules/order/order.schema';
import { Table } from '../src/modules/table/table.schema';
import { Session } from '../src/modules/session/session.schema';
import {
  PaymentIntent,
  PaymentIntentStatus,
} from '../src/modules/vnpay/payment-intent.schema';
import { CashShift } from '../src/modules/finance/cash-shift.schema';
import {
  CashShiftService,
  CashActor,
} from '../src/modules/finance/cash-shift.service';
import { VnpayService } from '../src/modules/vnpay/vnpay.service';
import { OrderStateMachineService } from '../src/modules/order/order-state-machine.service';
import { clearTestCollections } from './support/test-database';
import { SocketAuthService } from '../src/gateway/socket-auth.service';

describe('Settlement revenue and cash shift reconciliation', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let receipts: Model<PaymentIntent>;
  let shifts: Model<CashShift>;
  let payments: VnpayService;
  let drawer: CashShiftService;
  let actors: Record<string, CashActor>;
  let tokens: Record<string, string>;
  const http = () => app.getHttpServer();
  const auth = (name = 'admin') => `Bearer ${tokens[name]}`;
  const report = (query: Record<string, string | number> = {}) =>
    request(http())
      .get('/admin/revenue')
      .set('Authorization', auth())
      .query({ from: '2026-10-17', to: '2026-10-17', ...query });
  const open = (name = 'waiter', openingCash = 50000) =>
    request(http())
      .post('/cash-shifts')
      .set('Authorization', auth(name))
      .send({ openingCash });
  const submit = (
    id: string,
    version: number,
    declaredCash: number,
    name = 'waiter',
  ) =>
    request(http())
      .post(`/cash-shifts/${id}/submit`)
      .set('Authorization', auth(name))
      .send({ version, declaredCash });

  const verify = (
    id: string,
    version: number,
    verifiedCash: number,
    name = 'admin',
  ) =>
    request(http())
      .post(`/admin/cash-shifts/${id}/verify`)
      .set('Authorization', auth(name))
      .send({ version, verifiedCash });
  const auditedCurrent = async (name: string) => {
    const current = await drawer.current(actors[name]);
    return current
      ? drawer.detail(
          String(current.id),
          actors[name === 'admin' ? 'admin2' : 'admin'],
        )
      : null;
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    connection = app.get(getConnectionToken());
    receipts = app.get(getModelToken(PaymentIntent.name));
    shifts = app.get(getModelToken(CashShift.name));
    payments = app.get(VnpayService);
    drawer = app.get(CashShiftService);
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await clearTestCollections(connection);
    actors = {};
    tokens = {};
    const users = app.get<Model<User>>(getModelToken(User.name));
    for (const [name, role] of [
      ['admin', UserRole.ADMIN],
      ['admin2', UserRole.ADMIN],
      ['waiter', UserRole.WAITER],
      ['other', UserRole.WAITER],
      ['kitchen', UserRole.KITCHEN],
    ] as const) {
      const user = await users.create({
        fullName: name,
        email: `${name}@cash-shifts.test`,
        role,
        passwordHash: 'fixture',
      });
      actors[name] = { id: String(user._id), role };
      tokens[name] = new JwtService({
        secret: process.env.JWT_ACCESS_SECRET,
      }).sign({ sub: user.id, role, email: user.email });
    }
  });
  afterAll(async () => {
    await app?.close();
  });

  async function bill(amount = 5000000) {
    const tables = app.get<Model<Table>>(getModelToken(Table.name));
    const sessions = app.get<Model<Session>>(getModelToken(Session.name));
    const orders = app.get<Model<Order>>(getModelToken(Order.name));
    const table = await tables.create({
      tableCode: `T-${new Types.ObjectId()}`,
      qrCodeUrl: 'fixture',
      status: TableStatus.WAITING_PAYMENT,
    });
    const session = await sessions.create({
      tableId: table._id,
      tableIds: [table._id],
    });
    await tables.updateOne(
      { _id: table._id },
      { $set: { currentSessionId: session._id } },
    );
    const order = await orders.create({
      tableId: table._id,
      sessionId: session._id,
      status: OrderStatus.SERVED,
      totalAmount: amount,
      subtotalAmount: amount,
      items: [
        {
          dishId: new Types.ObjectId(),
          dishName: 'Rice',
          quantity: 1,
          unitPrice: amount,
          status: OrderStatus.SERVED,
        },
      ],
    });
    return {
      table,
      session,
      order,
      preview: await payments.getCashSettlementSummary(table.id),
    };
  }
  function fixture(
    method: PaymentIntent['paymentMethod'] = 'CASH',
    amount = 100000,
    completedAt = '2026-10-16T17:00:00.000Z',
    status = PaymentIntentStatus.SUCCEEDED,
    cashShiftId?: Types.ObjectId,
    staffId = actors.waiter.id,
  ) {
    return receipts.create({
      txnRef: String(new Types.ObjectId()),
      coverageKey: String(new Types.ObjectId()),
      sessionId: new Types.ObjectId(),
      tableId: new Types.ObjectId(),
      coveredOrderIds: [new Types.ObjectId()],
      amount,
      paymentMethod: method,
      paymentUrl: 'about:blank',
      status,
      ipnConfirmed: method === 'vnpay',
      transactionNo: method === 'vnpay' ? 'provider-123' : undefined,
      settledByUserId: method === 'CASH' ? staffId : undefined,
      cashShiftId,
      completedAt: new Date(completedAt),
      expiresAt: new Date(completedAt),
    });
  }
  function latch() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function signed(
    checkout: { txnRef: string; amount: number },
    overrides: Record<string, string> = {},
  ) {
    const params: Record<string, string> = {
      vnp_TxnRef: checkout.txnRef,
      vnp_Amount: String(checkout.amount * 100),
      vnp_TmnCode: 'TESTCODE',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TransactionNo: '777001',
      ...overrides,
    };
    const data = Object.keys(params)
      .sort()
      .map(
        (key) =>
          `${key}=${encodeURIComponent(params[key]).replace(/%20/g, '+')}`,
      )
      .join('&');
    params.vnp_SecureHash = createHmac('sha512', process.env.VNP_HASH_SECRET!)
      .update(data)
      .digest('hex');
    return params;
  }

  it('keeps every owner OPEN response blind until submission, including receipt amounts', async () => {
    const opened = await open().expect(201);
    const id = opened.body.id as string;
    const sale = await bill(8000);
    await payments.settleCash(sale.table.id, sale.preview, actors.waiter);
    const responses = [opened.body];
    for (const path of [
      '/cash-shifts/current',
      '/cash-shifts/mine',
      `/cash-shifts/${id}`,
    ]) {
      const result = (
        await request(http())
          .get(path)
          .set('Authorization', auth('waiter'))
          .expect(200)
      ).body;
      responses.push(result.shifts ? result.shifts[0] : result);
    }
    for (const response of responses) {
      for (const field of [
        'cashSales',
        'expectedCash',
        'variance',
        'declaredVariance',
        'verifiedVariance',
      ])
        expect(response).not.toHaveProperty(field);
      if (response.transactions) expect(response.transactions).toEqual([]);
      expect(response.canSubmit).toBe(true);
      expect(response.canVerify).toBe(false);
    }
    const pending = await submit(id, 1, 57000).expect(201);
    expect(pending.body).toMatchObject({
      status: 'PENDING_REVIEW',
      expectedCash: 58000,
      cashSales: 8000,
      declaredCash: 57000,
      declaredVariance: -1000,
      declaredBy: actors.waiter.id,
      verifiedCash: null,
      verifiedAt: null,
      closedAt: null,
      canSubmit: false,
    });
    expect(pending.body.transactions).toHaveLength(1);
    expect((await drawer.current(actors.waiter))?.status).toBe(
      'PENDING_REVIEW',
    );
  });

  it('rejects client cash totals, variances, verification and legacy close payloads', async () => {
    const id = (await open().expect(201)).body.id as string;
    for (const extra of [
      { expectedCash: 0 },
      { declaredVariance: 0 },
      { verifiedCash: 0 },
      { variance: 0 },
      { declaredBy: actors.other.id },
    ]) {
      await request(http())
        .post(`/cash-shifts/${id}/submit`)
        .set('Authorization', auth('waiter'))
        .send({ version: 0, declaredCash: 0, ...extra })
        .expect(400);
    }
    await request(http())
      .post(`/cash-shifts/${id}/close`)
      .set('Authorization', auth('waiter'))
      .send({ version: 0, actualCash: 50000 })
      .expect(404);
    await submit(id, 0, 50000).expect(201);
    for (const extra of [
      { expectedCash: 0 },
      { verifiedVariance: 0 },
      { declaredCash: 0 },
    ]) {
      await request(http())
        .post(`/admin/cash-shifts/${id}/verify`)
        .set('Authorization', auth())
        .send({ version: 1, verifiedCash: 50000, ...extra })
        .expect(400);
    }
  });

  it('commits only one simultaneous submission and rejects duplicate retries without changing the declaration', async () => {
    const id = (await open().expect(201)).body.id as string;
    const attempts = await Promise.all([
      submit(id, 0, 51000),
      submit(id, 0, 52000),
    ]);
    expect(attempts.map((result) => result.status).sort()).toEqual([201, 409]);
    const stored = await shifts.findById(id).lean().orFail();
    await submit(id, 0, 50000).expect(409);
    await submit(id, 1, 50000).expect(409);
    const openings = await Promise.all([open(), open()]);
    expect(openings.map((result) => result.status)).toEqual([409, 409]);
    expect(await shifts.findById(id).lean().orFail()).toEqual(stored);
  });

  it('commits only one of two Admin verifications and keeps the complete CLOSED audit immutable on retry', async () => {
    const id = (await open().expect(201)).body.id as string;
    await submit(id, 0, 49000).expect(201);
    await verify(id, 0, 50000).expect(409);
    const attempts = await Promise.all([
      verify(id, 1, 48000),
      verify(id, 1, 47000, 'admin2'),
    ]);
    expect(attempts.map((result) => result.status).sort()).toEqual([201, 409]);
    const winner = attempts.find((result) => result.status === 201)!.body;
    expect(winner).toMatchObject({
      status: 'CLOSED',
      declaredCash: 49000,
      declaredVariance: -1000,
      version: 2,
    });
    expect(winner.verifiedVariance).toBe(
      winner.verifiedCash - winner.expectedCash,
    );
    expect(winner.verifiedAt).toBe(winner.closedAt);
    expect(winner.verifiedBy).toBe(winner.closedBy);
    const stored = await shifts.findById(id).lean().orFail();
    await verify(id, 1, winner.verifiedCash).expect(409);
    await verify(id, 2, 0, 'admin2').expect(409);
    expect(await shifts.findById(id).lean().orFail()).toEqual(stored);
    await open().expect(201);
  });

  it('requires a different Admin to verify an Admin own shift', async () => {
    const opened = await open('admin').expect(201);
    expect(opened.body).not.toHaveProperty('expectedCash');
    const id = opened.body.id as string;
    await submit(id, 0, 50000, 'admin').expect(201);
    await verify(id, 1, 50000, 'admin').expect(403);
    await open('admin').expect(409);
    await verify(id, 1, 50000, 'admin2').expect(201);
    await open('admin').expect(201);
  });

  it('blocks fresh CASH during PENDING_REVIEW and after verification without changing revenue', async () => {
    const id = (await open().expect(201)).body.id as string;
    await fixture(
      'CASH',
      10000,
      undefined,
      PaymentIntentStatus.SUCCEEDED,
      new Types.ObjectId(id),
    );
    await fixture(
      'vnpay',
      12000,
      undefined,
      PaymentIntentStatus.SUCCEEDED,
      new Types.ObjectId(id),
    );
    await fixture('CASH', 7000); // Historical/unassigned stays independent.
    const before = (await report().expect(200)).body;
    const sale = await bill(8000);
    const pending = await submit(id, 0, 59000).expect(201);
    expect(pending.body.expectedCash).toBe(60000); // Excludes VNPAY even with a legacy shift link.
    await expect(
      payments.settleCash(sale.table.id, sale.preview, actors.waiter),
    ).rejects.toThrow();
    const during = (await report().expect(200)).body;
    await verify(id, 1, 58000).expect(201);
    await expect(
      payments.settleCash(sale.table.id, sale.preview, actors.waiter),
    ).rejects.toThrow();
    const after = (await report().expect(200)).body;
    expect(during).toMatchObject({
      cashInOpenShifts: 0,
      cashInPendingReviewShifts: 10000,
      cashInClosedShifts: 0,
    });
    expect(after).toMatchObject({
      cashInOpenShifts: 0,
      cashInPendingReviewShifts: 0,
      cashInClosedShifts: 10000,
    });
    for (const result of [during, after]) {
      for (const key of [
        'totalRevenue',
        'cashRevenue',
        'vnpayRevenue',
        'transactionCount',
        'unassignedHistoricalCash',
        'byDay',
        'byPaymentMethod',
        'cashByStaff',
        'transactions',
      ])
        expect(result[key]).toEqual(before[key]);
    }
    expect((await shifts.findById(id).orFail()).expectedCash).toBe(60000);
    expect(await receipts.countDocuments({ sessionId: sale.session._id })).toBe(
      0,
    );
  });

  it('reads legacy CLOSED evidence without inventing declared or verified data or rewriting documents', async () => {
    const id = new Types.ObjectId();
    const legacy = {
      _id: id,
      staffId: new Types.ObjectId(actors.waiter.id),
      staffName: 'legacy',
      openedAt: new Date('2026-10-01'),
      closedAt: new Date('2026-10-02'),
      openingCash: 50000,
      status: 'CLOSED',
      expectedCash: 60000,
      actualCash: 59000,
      variance: -1000,
      closedBy: new Types.ObjectId(actors.waiter.id),
      closedByName: 'waiter',
      version: 1,
    };
    await shifts.collection.insertOne(legacy);
    await drawer.onModuleInit(); // Additive, repeatable index installation.
    const response = await request(http())
      .get(`/cash-shifts/${id}`)
      .set('Authorization', auth('waiter'))
      .expect(200);
    expect(response.body).toMatchObject({
      status: 'CLOSED',
      actualCash: 59000,
      variance: -1000,
      expectedCash: 60000,
      declaredCash: null,
      verifiedCash: null,
      declaredBy: null,
      verifiedBy: null,
      submittedAt: null,
      verifiedAt: null,
      canSubmit: false,
      canVerify: false,
    });
    await verify(String(id), 1, 60000).expect(409);
    expect(await shifts.collection.findOne({ _id: id })).toEqual(legacy);
  });

  it('separates open, closed and historical CASH over the whole multi-day range, independently of pagination', async () => {
    const openShift = (await open('waiter', 1000).expect(201)).body
      .id as string;
    const closedShift = (await open('other', 2000).expect(201)).body
      .id as string;
    await fixture('CASH', 100, '2026-10-16T17:00:00.000Z');
    await fixture(
      'CASH',
      200,
      '2026-10-16T18:00:00.000Z',
      PaymentIntentStatus.SUCCEEDED,
      new Types.ObjectId(closedShift),
      actors.other.id,
    );
    await fixture(
      'CASH',
      300,
      '2026-10-17T17:00:00.000Z',
      PaymentIntentStatus.SUCCEEDED,
      new Types.ObjectId(openShift),
    );
    await fixture('vnpay', 400, '2026-10-18T16:59:59.999Z');
    await fixture('CASH', 999, '2026-10-18T17:00:00.000Z');
    await submit(closedShift, 0, 2200, 'other').expect(201);
    await verify(closedShift, 1, 2200).expect(201);
    const totals = {
      cashRevenue: 600,
      vnpayRevenue: 400,
      totalRevenue: 1000,
      cashInOpenShifts: 300,
      cashInClosedShifts: 200,
      unassignedHistoricalCash: 100,
      transactionCount: 4,
    };
    const response = await report({ to: '2026-10-18' }).expect(200);
    expect(response.body).toMatchObject(totals);
    expect(response.body.byDay).toMatchObject([
      { date: '2026-10-17', totalRevenue: 300 },
      { date: '2026-10-18', totalRevenue: 700 },
    ]);
    const nextPage = await report({ to: '2026-10-18', page: 2 }).expect(200);
    expect(nextPage.body).toMatchObject(totals);
    expect(nextPage.body.transactions).toHaveLength(0);
    expect(
      (
        await report({
          from: '2026-10-16T17:00:00Z',
          to: '2026-10-18T17:00:00Z',
        }).expect(200)
      ).body,
    ).toMatchObject(totals);
    expect(
      (await report({ to: '2026-10-18', paymentMethod: 'VNPAY' }).expect(200))
        .body,
    ).toMatchObject({
      cashRevenue: 0,
      cashInOpenShifts: 0,
      cashInClosedShifts: 0,
      unassignedHistoricalCash: 0,
    });
    expect(
      (await report({ to: '2026-10-18', staffId: actors.other.id }).expect(200))
        .body,
    ).toMatchObject({
      cashRevenue: 200,
      cashInClosedShifts: 200,
      cashInOpenShifts: 0,
      unassignedHistoricalCash: 0,
    });
    await submit(openShift, 0, 1300).expect(201);
    await verify(openShift, 1, 1300).expect(201);
    expect((await report({ to: '2026-10-18' }).expect(200)).body).toMatchObject(
      { ...totals, cashInOpenShifts: 0, cashInClosedShifts: 500 },
    );
  });

  it('Admin CASH uses the Admin own shift and keeps discounted/rejected invoice, ledger and drawer amounts equal', async () => {
    await open('waiter', 50000).expect(201);
    const sale = await bill(10000);
    await expect(
      payments.settleCash(sale.table.id, sale.preview, actors.admin),
    ).rejects.toThrow('mở ca');
    expect(await receipts.countDocuments({ paymentMethod: 'CASH' })).toBe(0);
    const adminShift = (await open('admin', 50000).expect(201)).body
      .id as string;
    const orders = app.get<Model<Order>>(getModelToken(Order.name));
    await orders.updateOne(
      { _id: sale.order._id },
      {
        $set: {
          totalAmount: 8000,
          discountAmount: 2000,
          promotionCode: 'FIXTURE20',
        },
        $push: {
          items: {
            dishId: new Types.ObjectId(),
            dishName: 'Unavailable dish',
            quantity: 1,
            unitPrice: 9000,
            status: 'Rejected',
            rejectionReason: 'Sold out',
          },
        },
      },
    );
    const preview = await payments.getCashSettlementSummary(sale.table.id);
    const settled = await payments.settleCash(
      sale.table.id,
      preview,
      actors.admin,
    );
    const receipt = await receipts
      .findOne({ invoiceCode: settled.invoiceCode })
      .orFail();
    expect(String(receipt.cashShiftId)).toBe(adminShift);
    expect(String(receipt.settledByUserId)).toBe(actors.admin.id);
    const invoice = (
      await request(http())
        .get(`/admin/invoices/${settled.invoiceCode}`)
        .set('Authorization', auth())
        .expect(200)
    ).body;
    const day = new Date(+receipt.completedAt! + 7 * 3600000)
      .toISOString()
      .slice(0, 10);
    const revenue = (await report({ from: day, to: day }).expect(200)).body;
    const shift = await auditedCurrent('admin');
    expect([
      settled.amount,
      receipt.amount,
      invoice.totalAmount,
      revenue.transactions[0].amount,
      revenue.cashRevenue,
      shift?.cashSales,
    ]).toEqual(Array(6).fill(8000));
    expect(invoice).toMatchObject({
      subtotalAmount: 10000,
      discountAmount: 2000,
      orders: [
        {
          promotionCode: 'FIXTURE20',
          items: [
            { chargedAmount: 10000 },
            { chargedAmount: 0, status: 'Rejected' },
          ],
        },
      ],
    });
    expect(shift?.expectedCash).toBe(58000);
    expect((await auditedCurrent('waiter'))?.cashSales).toBe(0);
  });

  it('invalid merchant/status never settles and late IPN after CASH stays superseded without double revenue', async () => {
    await open().expect(201);
    const sale = await bill(12000);
    const checkout = await payments.createPaymentUrl(
      sale.session.id,
      sale.table.id,
      '127.0.0.1',
    );
    expect(
      (await payments.handleIpn(signed(checkout, { vnp_TmnCode: 'OTHER' })))
        .RspCode,
    ).toBe('97');
    expect(
      (
        await payments.handleIpn(
          signed(checkout, { vnp_TransactionStatus: '01' }),
        )
      ).RspCode,
    ).toBe('99');
    expect(
      (
        await payments.handleIpn({
          ...signed(checkout),
          vnp_SecureHash: 'invalid',
        })
      ).RspCode,
    ).toBe('97');
    expect(
      (await receipts.findOne({ txnRef: checkout.txnRef }).orFail()).status,
    ).toBe(PaymentIntentStatus.PENDING);
    const settlement = await payments.settleCash(
      sale.table.id,
      sale.preview,
      actors.waiter,
    );
    expect((await payments.handleIpn(signed(checkout))).RspCode).toBe('00');
    expect((await payments.handleIpn(signed(checkout))).RspCode).toBe('02');
    const cash = await receipts
      .findOne({ invoiceCode: settlement.invoiceCode })
      .orFail();
    const provider = await receipts
      .findOne({ txnRef: checkout.txnRef })
      .orFail();
    expect(provider).toMatchObject({
      status: PaymentIntentStatus.SUPERSEDED,
      lateProviderStatus: 'succeeded',
      reconciliationRequired: true,
    });
    const day = new Date(+cash.completedAt! + 7 * 3600000)
      .toISOString()
      .slice(0, 10);
    expect(
      (await report({ from: day, to: day }).expect(200)).body,
    ).toMatchObject({
      totalRevenue: 12000,
      cashRevenue: 12000,
      vnpayRevenue: 0,
      transactionCount: 1,
      cashInOpenShifts: 12000,
      unassignedHistoricalCash: 0,
    });
    expect((await auditedCurrent('waiter'))?.cashSales).toBe(12000);
  });

  it('sums successful receipts at Vietnam day boundaries, groups methods/staff, and excludes all non-settlements', async () => {
    const cash = await fixture();
    await fixture('vnpay', 250000, '2026-10-17T16:59:59.999Z');
    await fixture('CASH', 900000, '2026-10-16T16:59:59.999Z');
    await fixture('CASH', 900000, '2026-10-17T17:00:00.000Z');
    for (const status of [
      PaymentIntentStatus.PENDING,
      PaymentIntentStatus.FAILED,
      PaymentIntentStatus.SUPERSEDED,
      PaymentIntentStatus.PROVIDER_REJECTED,
    ])
      await fixture('vnpay', 999999, undefined, status);
    const unverified = await fixture('vnpay', 999999);
    await receipts.updateOne(
      { _id: unverified._id },
      { $set: { ipnConfirmed: false } },
    );
    await fixture('internal_zero', 0);
    const response = await report().expect(200);
    expect(response.body).toMatchObject({
      totalRevenue: 350000,
      cashRevenue: 100000,
      vnpayRevenue: 250000,
      transactionCount: 2,
      timezone: 'Asia/Ho_Chi_Minh',
      byDay: [
        { date: '2026-10-17', totalRevenue: 350000, transactionCount: 2 },
      ],
      cashByStaff: [
        { staffId: actors.waiter.id, staffName: 'waiter', revenue: 100000 },
      ],
    });
    expect(response.body.byPaymentMethod).toEqual(
      expect.arrayContaining([
        { paymentMethod: 'CASH', revenue: 100000, transactionCount: 1 },
        { paymentMethod: 'VNPAY', revenue: 250000, transactionCount: 1 },
      ]),
    );
    expect(response.body.transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invoiceCode: cash.invoiceCode,
          sessionId: String(cash.sessionId),
          orderIds: cash.coveredOrderIds.map(String),
          paymentMethod: 'CASH',
          cashShiftId: null,
          settledBy: actors.waiter.id,
          status: 'succeeded',
        }),
        expect.objectContaining({
          paymentMethod: 'VNPAY',
          providerTransaction: 'provider-123',
        }),
      ]),
    );
    expect(
      (await report({ paymentMethod: 'VNPAY' }).expect(200)).body,
    ).toMatchObject({
      totalRevenue: 250000,
      cashRevenue: 0,
      transactionCount: 1,
    });
    expect(
      (await report({ staffId: actors.waiter.id }).expect(200)).body
        .totalRevenue,
    ).toBe(100000);
    expect(
      (await report({ staffId: actors.other.id }).expect(200)).body
        .totalRevenue,
    ).toBe(0);
    await report({ from: '2026-02-30' }).expect(400);
    await report({ from: '2026-10-18' }).expect(400);
    await report({ from: '2026-10-17T00:00:00' }).expect(400);
    await report({ from: '2026-02-30T00:00:00+07:00' }).expect(400);
    // Existing invoice CAS gives legacy receipts a stable public code, with no
    // duplicate payment or changes to amount, paidAt, status or attribution.
    await receipts.collection.updateOne(
      { _id: cash._id },
      { $unset: { invoiceCode: '' } },
    );
    const count = await receipts.countDocuments();
    const legacy = await report({ paymentMethod: 'CASH' }).expect(200);
    const code = legacy.body.transactions[0].invoiceCode as string;
    expect(code).toMatch(/^INV-\d{8}-[A-HJ-NP-Z2-9]{8}$/);
    expect(
      (await report({ paymentMethod: 'CASH' }).expect(200)).body.transactions[0]
        .invoiceCode,
    ).toBe(code);
    expect(await receipts.countDocuments()).toBe(count);
  });

  it('paginates receipts without changing server totals', async () => {
    await Promise.all(Array.from({ length: 51 }, () => fixture('CASH', 100)));
    const response = await report({ page: 2 }).expect(200);
    expect(response.body).toMatchObject({
      totalRevenue: 5100,
      transactionCount: 51,
      pageSize: 50,
    });
    expect(response.body.transactions).toHaveLength(1);
  });

  it('attributes CASH to the collector/active shift, snapshots expected, preserves declared/verified counts, and keeps closed membership fixed', async () => {
    const sale = await bill();
    await request(http())
      .post(`/payments/tables/${sale.table.id}/cash-settlement`)
      .set('Authorization', auth('waiter'))
      .send({
        sessionId: sale.preview.sessionId,
        sessionVersion: sale.preview.sessionVersion,
        confirmationKey: sale.preview.confirmationKey,
      })
      .expect(409);
    const opened = await open().expect(201);
    const id = opened.body.id as string;
    await payments.settleCash(sale.table.id, sale.preview, actors.waiter);
    const receipt = await receipts.findOne({ paymentMethod: 'CASH' }).orFail();
    expect(String(receipt.settledByUserId)).toBe(actors.waiter.id);
    expect(String(receipt.cashShiftId)).toBe(id);
    const current = await request(http())
      .get('/cash-shifts/current')
      .set('Authorization', auth('waiter'))
      .expect(200);
    expect(current.body).toMatchObject({
      openingCash: 50000,
      version: 1,
    });
    await submit(id, 0, 4850000).expect(409); // Preview predates the sale.
    await request(http())
      .post(`/cash-shifts/${id}/submit`)
      .set('Authorization', auth('waiter'))
      .send({ version: 1, declaredCash: 4850000, expectedCash: 4850000 })
      .expect(400);
    const pending = await submit(id, 1, 4850000).expect(201);
    expect(pending.body).toMatchObject({
      status: 'PENDING_REVIEW',
      declaredCash: 4850000,
      declaredVariance: -200000,
    });
    await open().expect(409);
    const closed = await verify(id, 2, 4950000).expect(201);
    expect(closed.body).toMatchObject({
      status: 'CLOSED',
      expectedCash: 5050000,
      declaredCash: 4850000,
      declaredVariance: -200000,
      verifiedCash: 4950000,
      verifiedVariance: -100000,
      closedBy: actors.admin.id,
      transactionCount: 1,
    });
    expect(closed.body.transactions[0].invoiceCode).toBe(receipt.invoiceCode);
    const persisted = await shifts.findById(id).lean().orFail();
    await verify(id, 3, 5050000).expect(409);
    await submit(id, 3, 5050000).expect(409);
    await request(http())
      .patch(`/cash-shifts/${id}`)
      .set('Authorization', auth())
      .send({ declaredCash: 0 })
      .expect(404);
    await request(http())
      .delete(`/cash-shifts/${id}`)
      .set('Authorization', auth())
      .expect(404);
    const next = await bill(10000);
    await expect(
      payments.settleCash(next.table.id, next.preview, actors.waiter),
    ).rejects.toThrow('mở ca');
    const second = await open('waiter', 0).expect(201);
    await payments.settleCash(next.table.id, next.preview, actors.waiter);
    expect(
      String(
        (await receipts.findOne({ sessionId: next.session._id }).orFail())
          .cashShiftId,
      ),
    ).toBe(second.body.id);
    expect(await shifts.findById(id).lean().orFail()).toEqual(persisted);
    expect(await receipts.countDocuments({ cashShiftId: id })).toBe(1);
    // Immutable Mongoose field refuses reassignment to another shift.
    await receipts.updateOne(
      { _id: receipt._id },
      { $set: { cashShiftId: second.body.id } },
    );
    expect(
      String((await receipts.findById(receipt._id).orFail()).cashShiftId),
    ).toBe(id);
  });

  it('enforces one OPEN shift across concurrent requests, and duplicate CASH never increments sales twice', async () => {
    const results = await Promise.all([open(), open()]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const sale = await bill(8000);
    const outcomes = await Promise.allSettled([
      payments.settleCash(sale.table.id, sale.preview, actors.waiter),
      payments.settleCash(sale.table.id, sale.preview, actors.waiter),
    ]);
    expect(
      outcomes.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(await receipts.countDocuments({ paymentMethod: 'CASH' })).toBe(1);
    const current = await auditedCurrent('waiter');
    expect(current).toMatchObject({
      cashSales: 8000,
      expectedCash: 58000,
      version: 1,
      transactionCount: 1,
    });
  });

  it('submit winning while CASH is in flight rolls back the entire settlement', async () => {
    const opened = await open().expect(201);
    const sale = await bill(8000);
    const entered = latch(),
      release = latch();
    const original = shifts.findOneAndUpdate.bind(shifts);
    jest
      .spyOn(shifts, 'findOneAndUpdate')
      .mockImplementationOnce((...args: Parameters<typeof original>) => {
        const query = original(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          entered.resolve();
          await release.promise;
          return exec();
        };
        return query;
      });
    const attempt = payments
      .settleCash(sale.table.id, sale.preview, actors.waiter)
      .then(
        () => 'committed',
        () => 'rejected',
      );
    await entered.promise;
    try {
      await submit(opened.body.id, 0, 50000).expect(201);
      await verify(opened.body.id, 1, 50000).expect(201);
    } finally {
      release.resolve();
    }
    expect(await attempt).toBe('rejected');
    expect(await receipts.countDocuments({ paymentMethod: 'CASH' })).toBe(0);
    expect(
      (
        await app
          .get<Model<Order>>(getModelToken(Order.name))
          .findById(sale.order._id)
          .orFail()
      ).status,
    ).toBe(OrderStatus.SERVED);
    expect((await shifts.findById(opened.body.id).orFail()).expectedCash).toBe(
      50000,
    );
  });

  it('CASH winning forces a concurrent submit to reload before it can persist', async () => {
    const opened = await open().expect(201);
    const sale = await bill(8000);
    const entered = latch(),
      release = latch();
    const state = app.get(OrderStateMachineService);
    const transition = state.transitionManyToPaid.bind(state);
    jest
      .spyOn(state, 'transitionManyToPaid')
      .mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return transition(...args);
      });
    const attempt = payments.settleCash(
      sale.table.id,
      sale.preview,
      actors.waiter,
    );
    await entered.promise;
    try {
      await submit(opened.body.id, 0, 50000).expect(409);
    } finally {
      release.resolve();
    }
    await attempt;
    const result = await submit(opened.body.id, 1, 58000).expect(201);
    expect(result.body).toMatchObject({
      expectedCash: 58000,
      declaredVariance: 0,
      transactionCount: 1,
    });
  });

  it('duplicate verified VNPAY IPN counts once and never enters a cash drawer', async () => {
    await open().expect(201);
    const sale = await bill(12000);
    const checkout = await payments.createPaymentUrl(
      sale.session.id,
      sale.table.id,
      '127.0.0.1',
    );
    const params: Record<string, string> = {
      vnp_TxnRef: checkout.txnRef,
      vnp_Amount: '1200000',
      vnp_TmnCode: 'TESTCODE',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TransactionNo: '777001',
    };
    const data = Object.keys(params)
      .sort()
      .map(
        (key) =>
          `${key}=${encodeURIComponent(params[key]).replace(/%20/g, '+')}`,
      )
      .join('&');
    params.vnp_SecureHash = createHmac('sha512', process.env.VNP_HASH_SECRET!)
      .update(data)
      .digest('hex');
    const outcomes = await Promise.all([
      payments.handleIpn(params),
      payments.handleIpn(params),
    ]);
    expect(outcomes.map((result) => result.RspCode).sort()).toEqual([
      '00',
      '02',
    ]);
    const receipt = await receipts
      .findOne({ txnRef: checkout.txnRef })
      .orFail();
    const day = new Date(+receipt.completedAt! + 7 * 3600000)
      .toISOString()
      .slice(0, 10);
    expect((await report({ from: day, to: day })).body).toMatchObject({
      totalRevenue: 12000,
      vnpayRevenue: 12000,
      cashRevenue: 0,
      transactionCount: 1,
    });
    expect(receipt.cashShiftId).toBeUndefined();
    expect(await auditedCurrent('waiter')).toMatchObject({
      cashSales: 0,
      expectedCash: 50000,
      version: 0,
    });
  });

  it('restricts revenue/reconciliation to Admin and staff to their own drawer; only the owner submits and another Admin verifies', async () => {
    const opened = await open().expect(201);
    const id = opened.body.id as string;
    const sale = await bill();
    const customer = await app
      .get(SocketAuthService)
      .issueCustomer(sale.session.id, sale.table.id);
    for (const path of [
      '/admin/revenue',
      '/admin/revenue/staff',
      '/admin/cash-shifts',
      `/admin/cash-shifts/${id}`,
    ]) {
      await request(http()).get(path).expect(401);
      await request(http())
        .get(path)
        .set('x-customer-token', customer.customerToken)
        .expect(401);
      for (const name of ['waiter', 'other', 'kitchen'])
        await request(http())
          .get(path)
          .set('Authorization', auth(name))
          .expect(403);
      await request(http()).get(path).set('Authorization', auth()).expect(200);
    }
    await request(http())
      .get(`/cash-shifts/${id}`)
      .set('Authorization', auth('other'))
      .expect(403);
    await submit(id, 0, 50000, 'other').expect(403);
    await request(http())
      .get('/cash-shifts/current')
      .set('Authorization', auth('kitchen'))
      .expect(403);
    await open('kitchen').expect(403);
    for (const path of [
      '/cash-shifts/current',
      '/cash-shifts/mine',
      `/cash-shifts/${id}`,
    ]) {
      await request(http())
        .get(path)
        .set('x-customer-token', customer.customerToken)
        .expect(401);
      await request(http())
        .get(path)
        .set('Authorization', auth('kitchen'))
        .expect(403);
    }
    expect(
      (
        await request(http())
          .get('/cash-shifts/mine')
          .set('Authorization', auth('other'))
          .expect(200)
      ).body.total,
    ).toBe(0);
    await request(http())
      .post('/cash-shifts')
      .set('Authorization', auth('other'))
      .send({ openingCash: 0, staffId: actors.waiter.id })
      .expect(400);
    await submit(id, 0, 55000, 'admin').expect(403);
    await verify(id, 0, 55000).expect(409);
    await submit(id, 0, 55000).expect(201);
    await verify(id, 1, 55000, 'waiter').expect(403);
    expect((await verify(id, 1, 55000).expect(201)).body).toMatchObject({
      verifiedVariance: 5000,
      verifiedBy: actors.admin.id,
      staffId: actors.waiter.id,
    });
  });
});
