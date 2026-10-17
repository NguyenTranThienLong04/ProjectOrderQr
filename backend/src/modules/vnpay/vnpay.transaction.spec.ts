import {
  testMongoUri,
  clearTestCollections,
} from '../../../test/support/test-database';
import { ConflictException } from '@nestjs/common';
import { Connection, createConnection, Types } from 'mongoose';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { ActorType } from '../../common/enums/actor-type.enum';
import { Order, OrderSchema } from '../order/order.schema';
import { OrderStateMachineService } from '../order/order-state-machine.service';
import { Session, SessionSchema } from '../session/session.schema';
import { Table, TableSchema } from '../table/table.schema';
import {
  PaymentIntent,
  PaymentIntentSchema,
  PaymentIntentStatus,
  UNRESOLVED_PAYMENT_FILTER,
} from './payment-intent.schema';
import { VnpayService } from './vnpay.service';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reconcileProviderRejections,
  type ProviderRejectionEvidence,
} from '../../../scripts/reconcile-provider-rejections';

// Database lifecycle is owned by the shared integration harness.

describe('Payment correctness (isolated replica set)', () => {
  const connections: Connection[] = [];
  const backupDirectories: string[] = [];
  let first: ReturnType<typeof instance>;
  let second: ReturnType<typeof instance>;
  let sessionId: Types.ObjectId;
  let tableId: Types.ObjectId;
  const configValues: Record<string, string> = {
    VNP_HASH_SECRET: 'isolated-test-secret',
    VNP_TMN_CODE: 'TESTCODE',
    VNP_RETURN_URL: 'http://localhost/vnpay/return',
    VNP_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  };
  const gateway = { emit: jest.fn() };

  function instance(connection: Connection) {
    const orders = connection.model(Order.name, OrderSchema);
    const tables = connection.model(Table.name, TableSchema);
    const sessions = connection.model(Session.name, SessionSchema);
    const intents = connection.model(PaymentIntent.name, PaymentIntentSchema);
    const state = new OrderStateMachineService(orders, tables);
    const config = { get: jest.fn((key: string) => configValues[key]) };
    const service = new VnpayService(
      config as never,
      orders,
      sessions,
      tables,
      intents,
      connection,
      state,
      gateway as never,
      {} as never,
    );
    return {
      orders,
      tables,
      sessions,
      intents,
      state,
      service,
      connection,
      config,
    };
  }

  beforeAll(async () => {
    const uri = testMongoUri();
    const connection = createConnection(uri);
    connections.push(connection);
    await connection.asPromise();
    first = instance(connection);
    const other = createConnection(uri);
    connections.push(other);
    await other.asPromise();
    second = instance(other);
    await Promise.all(
      connections.flatMap((conn) =>
        Object.values(conn.models).map((model) => model.init()),
      ),
    );
    await first.service.onModuleInit();
    await second.service.onModuleInit();
  }, 45000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await Promise.all(connections.map((connection) => connection.close()));
  }, 15000);

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    await clearTestCollections(connections[0]);
    sessionId = new Types.ObjectId();
    tableId = new Types.ObjectId();
    await first.sessions.create({
      _id: sessionId,
      tableId,
      tableIds: [tableId],
    });
    await first.tables.create({
      _id: tableId,
      tableCode: 'T1',
      qrCodeUrl: 'test-only',
      currentSessionId: sessionId,
    });
  });

  afterEach(async () => {
    for (const directory of backupDirectories.splice(0)) {
      for (const name of await readdir(directory)) await unlink(join(directory, name));
      await rmdir(directory);
    }
  });

  function seed(amount = 10000, status = OrderStatus.SERVED) {
    return first.orders.create({
      sessionId,
      tableId,
      status,
      totalAmount: amount,
      subtotalAmount: 10000,
      discountAmount: 10000 - amount,
      items: [
        {
          dishId: new Types.ObjectId(),
          dishName: 'Rice',
          unitPrice: 10000,
          quantity: 1,
          status,
        },
      ],
    });
  }

  const checkout = (instance = first) =>
    instance.service.createPaymentUrl(
      sessionId.toString(),
      tableId.toString(),
      '::1',
    );
  const signed = (
    intent: { txnRef: string; amount: number },
    overrides: Record<string, string> = {},
  ) => {
    const params: Record<string, string> = {
      vnp_TxnRef: intent.txnRef,
      vnp_Amount: String(intent.amount * 100),
      vnp_TmnCode: 'TESTCODE',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TransactionNo: '123456',
      ...overrides,
    };
    params.vnp_SecureHash = (first.service as any).sign(params);
    return params;
  };

  async function rejectedCheckoutFixture() {
    const order = await seed();
    const payment = await checkout();
    const createdAt = new Date(Date.now() - 2 * 3600000);
    const expiresAt = new Date(createdAt.getTime() + 15 * 60000);
    const paymentUrl = (first.service as any).providerPaymentUrl(
      payment.txnRef, sessionId.toString(), payment.amount, '127.0.0.1', createdAt, expiresAt,
    );
    await first.intents.collection.updateOne({ txnRef: payment.txnRef }, {
      $set: { createdAt, expiresAt, paymentUrl },
    });
    const createDate = new URL(paymentUrl).searchParams.get('vnp_CreateDate')!;
    const evidence: ProviderRejectionEvidence = {
      source: 'operator-verified-vnpay-sandbox-portal',
      confirmedAt: new Date().toISOString(),
      operatorNote: 'Isolated fixture: operator verified gateway 71 and no matching portal transaction.',
      tmnCode: 'TESTCODE', merchantWebsite: 'example.com',
      smartOrderWebsite: 'https://app.example.com',
      returnUrl: configValues.VNP_RETURN_URL,
      portalUrl: 'https://sandbox.vnpayment.vn/merchantv2/',
      searchDate: `${createDate.slice(0, 4)}-${createDate.slice(4, 6)}-${createDate.slice(6, 8)}`,
      gatewayCode: '71',
      payments: [{
        txnRef: payment.txnRef, sessionId: String(sessionId), amount: payment.amount,
        coveredOrderIds: [order.id], createDate, portalResult: 'not_found',
      }],
    };
    const directory = await mkdtemp(join(tmpdir(), 'vnpay-reconciliation-test-'));
    backupDirectories.push(directory);
    const options = {
      evidence, tmnCode: 'TESTCODE', hashSecret: configValues.VNP_HASH_SECRET,
      backupDirectory: directory,
    };
    const run = (apply = true) => reconcileProviderRejections(
      connections[0].getClient(), connections[0].db!, { ...options, apply },
    );
    return { order, payment, evidence, run };
  }

  test('operator reconciliation of code 71 releases an expired checkout without an IPN; history and unique indexes remain', async () => {
    // The fixture uses HTTPS just like the production-only reconciliation helper.
    const originalReturn = configValues.VNP_RETURN_URL;
    configValues.VNP_RETURN_URL = 'https://backend.example.com/vnpay/return';
    try {
      const { order, payment, run } = await rejectedCheckoutFixture();
      const paid = await seed(5000, OrderStatus.PAID);
      const previous = await first.intents.create({
        txnRef: 'previous-success', coverageKey: 'previous-success', sessionId, tableId,
        coveredOrderIds: [paid._id], amount: 5000, status: PaymentIntentStatus.SUCCEEDED,
        ipnConfirmed: true, paymentUrl: 'history', expiresAt: new Date(), transactionNo: '987',
      });
      const preserved = await first.intents.findById(previous._id).lean();
      const originalOrder = await first.orders.findById(order._id).lean();
      const indexes = await first.intents.collection.listIndexes().toArray();
      await expect(checkout()).rejects.toThrow(ConflictException);
      expect(await run(false)).toMatchObject({ mode: 'dry-run', documentsToUpdate: 1 });
      expect((await first.intents.findOne({ txnRef: payment.txnRef }))!.status).toBe('pending');
      expect(await run()).toMatchObject({ documentsToUpdate: 1, ipnConfirmedWritten: false, ordersWritten: 0, indexChanges: 0 });
      expect(await first.intents.findOne({ txnRef: payment.txnRef }).lean()).toMatchObject({
        status: 'provider_rejected', ipnConfirmed: false, resolutionSource: 'reconciliation',
        providerCode: '71', resolutionReason: 'terminal_not_approved', resolvedAt: expect.any(Date),
      });
      expect(await first.intents.findById(previous._id).lean()).toEqual(preserved);
      expect(await first.orders.findById(order._id).lean()).toEqual(originalOrder);
      expect(await first.intents.collection.listIndexes().toArray()).toEqual(indexes);
      expect(await first.service.getPaymentStatus(payment.txnRef, String(sessionId), String(tableId)))
        .toMatchObject({ status: 'failed' });
      const [a, b] = await Promise.all([checkout(), checkout(second)]);
      expect(a.txnRef).toBe(b.txnRef);
      expect(a.txnRef).not.toBe(payment.txnRef);
      expect(await first.intents.countDocuments(UNRESOLVED_PAYMENT_FILTER)).toBe(1);
      const fresh = (await first.intents.findOne({ txnRef: a.txnRef }).lean())!;
      const { _id, invoiceCode, ...duplicate } = fresh;
      await expect(first.intents.collection.insertOne({ ...duplicate, txnRef: 'duplicate-session', coverageKey: 'other-key', coveredOrderIds: [new Types.ObjectId()] }))
        .rejects.toMatchObject({ code: 11000, keyPattern: { sessionId: 1 } });
      await expect(first.intents.collection.insertOne({ ...duplicate, txnRef: 'duplicate-order', coverageKey: 'other-key', sessionId: new Types.ObjectId() }))
        .rejects.toMatchObject({ code: 11000, keyPattern: { coveredOrderIds: 1 } });
      expect(await run()).toMatchObject({ documentsToUpdate: 0 });
      // Contradictory late receipts cannot mark Orders Paid or overwrite reconciliation.
      const beforeLateReceipt = await first.orders.findById(order._id).lean();
      expect(await first.service.handleIpn(signed(payment))).toMatchObject({ RspCode: '99' });
      expect(await first.orders.findById(order._id).lean()).toEqual(beforeLateReceipt);
      expect(await first.intents.countDocuments({})).toBe(3);
    } finally { configValues.VNP_RETURN_URL = originalReturn; }
  });

  test('gateway error alone, incomplete portal evidence, mismatched amounts and succeeded targets cannot be reconciled', async () => {
    const originalReturn = configValues.VNP_RETURN_URL;
    configValues.VNP_RETURN_URL = 'https://backend.example.com/vnpay/return';
    try {
      const { payment, evidence, run } = await rejectedCheckoutFixture();
      const note = evidence.operatorNote;
      evidence.operatorNote = '';
      await expect(run()).rejects.toThrow('evidence');
      evidence.operatorNote = note;
      evidence.payments[0].amount += 1;
      await expect(run()).rejects.toThrow('match');
      evidence.payments[0].amount -= 1;
      await first.intents.collection.updateOne({ txnRef: payment.txnRef }, {
        $set: { status: 'failed', providerCode: '71', resolutionSource: 'reconciliation' },
      });
      expect(await first.intents.countDocuments(UNRESOLVED_PAYMENT_FILTER)).toBe(1);
      await expect(checkout()).rejects.toThrow(ConflictException);
      await expect(run()).rejects.toThrow('conflicting evidence');
      await first.intents.collection.updateOne({ txnRef: payment.txnRef }, {
        $set: { status: 'succeeded', ipnConfirmed: true },
      });
      await expect(run()).rejects.toThrow('conflicting evidence');
      expect((await first.intents.findOne({ txnRef: payment.txnRef }))!.status).toBe('succeeded');
    } finally { configValues.VNP_RETURN_URL = originalReturn; }
  });

  test('concurrent snapshots A and A+B converge; overlap stays blocked even after session reassignment', async () => {
    const orderA = await seed();
    let ready!: () => void;
    let release!: () => void;
    const hasRead = new Promise<void>((done) => {
      ready = done;
    });
    const proceed = new Promise<void>((done) => {
      release = done;
    });
    const internals = first.service as any;
    const load = internals.loadSessionBilling.bind(internals);
    jest
      .spyOn(internals, 'loadSessionBilling')
      .mockImplementationOnce(async (...args) => {
        const snapshot = await load(...args);
        ready();
        await proceed;
        return snapshot;
      });
    const staleCheckout = checkout();
    await hasRead;
    const orderB = await seed(5000);
    const winner = await checkout(second);
    release();
    expect((await staleCheckout).txnRef).toBe(winner.txnRef);
    expect(await first.intents.countDocuments(UNRESOLVED_PAYMENT_FILTER)).toBe(
      1,
    );
    expect(winner.coveredOrderIds.sort()).toEqual(
      [orderA.id, orderB.id].sort(),
    );
    await seed(2000);
    await expect(checkout()).rejects.toThrow(ConflictException);
    expect(await first.intents.countDocuments({})).toBe(1);

    // Moving ownership cannot bypass the per-Order unique reservation.
    const otherSessionId = new Types.ObjectId();
    await first.sessions.create({
      _id: otherSessionId,
      tableId,
      tableIds: [tableId],
    });
    await first.tables.updateOne(
      { _id: tableId },
      { $set: { currentSessionId: otherSessionId } },
    );
    await first.orders.updateMany(
      { sessionId },
      { $set: { sessionId: otherSessionId } },
    );
    await expect(
      second.service.createPaymentUrl(
        otherSessionId.toString(),
        tableId.toString(),
        '::1',
      ),
    ).rejects.toThrow(ConflictException);
    expect(await first.intents.countDocuments({})).toBe(1);
  });

  test('IPN rollback returns retryable error; duplicates commit/pay/emit once and invalid inputs keep their codes', async () => {
    await seed();
    await seed(5000);
    const intent = await checkout();
    const callback = signed(intent);
    await expect(
      first.service.handleIpn({ ...callback, vnp_SecureHash: '0'.repeat(128) }),
    ).resolves.toMatchObject({ RspCode: '97' });
    await expect(
      first.service.handleIpn(signed(intent, { vnp_Amount: '1' })),
    ).resolves.toMatchObject({ RspCode: '04' });
    await expect(
      first.service.handleIpn(signed(intent, { vnp_TxnRef: 'unknown' })),
    ).resolves.toMatchObject({ RspCode: '01' });
    jest.spyOn(first.intents, 'findOne').mockImplementationOnce(
      () =>
        ({
          session() {
            return this;
          },
          exec: async () => {
            throw new Error('temporary read failure');
          },
        }) as never,
    );
    await expect(first.service.handleIpn(callback)).resolves.toMatchObject({
      RspCode: '99',
    });
    jest.restoreAllMocks();

    // Throw AFTER both Order updates and the intent update executed in the transaction.
    const update = first.intents.findOneAndUpdate.bind(first.intents);
    jest
      .spyOn(first.intents, 'findOneAndUpdate')
      .mockImplementationOnce((...args: any[]) => {
        const query = (update as any)(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          await exec();
          throw new Error('temporary write failure');
        };
        return query;
      });
    await expect(first.service.handleIpn(callback)).resolves.toMatchObject({
      RspCode: '99',
    });
    expect(
      await first.orders.countDocuments({ status: OrderStatus.PAID }),
    ).toBe(0);
    expect(
      (await first.intents.findOne({ txnRef: intent.txnRef }))!.status,
    ).toBe(PaymentIntentStatus.PENDING);
    for (const order of await first.orders.find()) {
      expect(order.statusHistory).toHaveLength(0);
      expect(order.__v).toBe(1);
    }
    expect(gateway.emit).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    const replies = await Promise.all([
      first.service.handleIpn(callback),
      second.service.handleIpn(callback),
    ]);
    expect(replies.map((reply) => reply.RspCode).sort()).toEqual(['00', '02']);
    for (const order of await first.orders.find()) {
      expect(order.status).toBe(OrderStatus.PAID);
      expect(order.__v).toBe(2);
      expect(order.statusHistory).toHaveLength(1);
      expect(order.toObject().statusHistory[0]).toMatchObject({
        fromStatus: OrderStatus.SERVED,
        toStatus: OrderStatus.PAID,
        source: 'vnpay_webhook',
        transactionNo: '123456',
        amount: 15000,
        changedBy: { actorType: ActorType.SYSTEM },
      });
    }
    const emitted = gateway.emit.mock.calls.length;
    await expect(first.service.handleIpn(callback)).resolves.toMatchObject({
      RspCode: '02',
    });
    await expect(
      first.service.handleIpn(signed(intent, { vnp_Amount: '1' })),
    ).resolves.toMatchObject({ RspCode: '04' });
    expect(gateway.emit).toHaveBeenCalledTimes(emitted);
    expect(
      gateway.emit.mock.calls.filter(
        ([, event]) => event === 'session:payment-updated',
      ),
    ).toHaveLength(1);
  });

  test('expiry/Return retain reservations; late success settles legacy local failure; only confirmed provider failure releases', async () => {
    await seed();
    const intent = await checkout();
    await first.service.handleReturn(
      signed(intent, { vnp_ResponseCode: '24' }),
    );
    expect(
      (await first.intents.findOne({ txnRef: intent.txnRef }))!.status,
    ).toBe(PaymentIntentStatus.PENDING);
    await first.intents.updateOne(
      { txnRef: intent.txnRef },
      { $set: { expiresAt: new Date(0) } },
    );
    await expect(checkout()).rejects.toThrow(ConflictException);
    // Simulate a record expired by the previous application version (no ipnConfirmed).
    await first.intents.updateOne(
      { txnRef: intent.txnRef },
      {
        $set: { status: PaymentIntentStatus.FAILED, responseCode: 'expired' },
        $unset: { ipnConfirmed: 1 },
      },
    );
    await expect(checkout()).rejects.toThrow(ConflictException);
    await expect(
      first.service.getPaymentStatus(
        intent.txnRef,
        sessionId.toString(),
        tableId.toString(),
      ),
    ).resolves.toMatchObject({ status: PaymentIntentStatus.PENDING });
    await expect(
      first.service.handleIpn(signed(intent)),
    ).resolves.toMatchObject({ RspCode: '00' });
    expect(
      await first.orders.countDocuments({ status: OrderStatus.PAID }),
    ).toBe(1);
    await seed(5000);
    const next = await checkout();
    await expect(
      first.service.handleIpn(
        signed(next, { vnp_ResponseCode: '99', vnp_TransactionStatus: '01' }),
      ),
    ).resolves.toMatchObject({ RspCode: '99' });
    expect(await first.intents.countDocuments(UNRESOLVED_PAYMENT_FILTER)).toBe(
      1,
    );
    const failure = signed(next, {
      vnp_ResponseCode: '24',
      vnp_TransactionStatus: '02',
      vnp_TransactionNo: '0',
    });
    await expect(first.service.handleIpn(failure)).resolves.toMatchObject({
      RspCode: '00',
    });
    await expect(first.service.handleIpn(failure)).resolves.toMatchObject({
      RspCode: '02',
    });
    expect(await first.intents.countDocuments(UNRESOLVED_PAYMENT_FILTER)).toBe(
      0,
    );
    const retry = await checkout();
    expect(retry.txnRef).not.toBe(next.txnRef);
    expect(
      await first.orders.countDocuments({ status: OrderStatus.SERVED }),
    ).toBe(1);
  });

  test('zero checkout settles atomically via server amounts/state machine, no VNPAY config and no public Paid bypass', async () => {
    const order = await seed(0, OrderStatus.READY);
    await expect(checkout()).rejects.toThrow();
    await first.orders.updateOne(
      { _id: order._id },
      {
        $set: {
          status: OrderStatus.SERVED,
          'items.0.status': OrderStatus.SERVED,
        },
      },
    );
    await expect(
      first.service.createPaymentUrl(
        sessionId.toString(),
        new Types.ObjectId().toString(),
        '::1',
      ),
    ).rejects.toThrow();
    const write = first.intents.findOneAndUpdate.bind(first.intents);
    jest
      .spyOn(first.intents, 'findOneAndUpdate')
      .mockImplementationOnce((...args: any[]) => {
        const query = (write as any)(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          await exec();
          throw new Error('zero settlement failure');
        };
        return query;
      });
    await expect(checkout()).rejects.toThrow('zero settlement failure');
    expect(await first.intents.countDocuments({})).toBe(0);
    expect((await first.orders.findById(order.id))!.status).toBe(
      OrderStatus.SERVED,
    );
    expect((await first.orders.findById(order.id))!.statusHistory).toHaveLength(
      0,
    );
    expect(gateway.emit).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    // Zero settlement must work even when no external provider is configured.
    first.config.get.mockReturnValue(undefined as never);
    second.config.get.mockReturnValue(undefined as never);
    const [a, b] = await Promise.all([checkout(), checkout(second)]);
    expect(a.txnRef).toBe(b.txnRef);
    expect(a.amount).toBe(0);
    expect(new URL(a.paymentUrl).pathname).toBe('/menu');
    expect(first.config.get).not.toHaveBeenCalled();
    expect(second.config.get).not.toHaveBeenCalled();
    const receipt = (await first.intents.findOne({ txnRef: a.txnRef }))!;
    expect(receipt).toMatchObject({
      status: PaymentIntentStatus.SUCCEEDED,
      paymentMethod: 'internal_zero',
      amount: 0,
      ipnConfirmed: false,
    });
    expect(receipt.invoiceCode).toMatch(/^INV-/);
    const paid = (await first.orders.findById(order.id))!;
    expect(paid.status).toBe(OrderStatus.PAID);
    expect(paid.__v).toBe(2);
    expect(paid.statusHistory).toHaveLength(1);
    expect(paid.toObject().statusHistory[0]).toMatchObject({
      fromStatus: OrderStatus.SERVED,
      toStatus: OrderStatus.PAID,
      amount: 0,
      source: 'internal_zero',
      changedBy: { actorType: ActorType.SYSTEM },
    });
    expect((await checkout()).txnRef).toBe(a.txnRef);
    expect(
      gateway.emit.mock.calls.filter(
        ([, event]) => event === 'session:payment-updated',
      ),
    ).toHaveLength(1);
    const nonzero = await seed(100);
    await expect(
      first.connection.transaction((mongoSession) =>
        first.state.transitionManyToPaid(
          [nonzero._id],
          sessionId,
          { triggeredBy: 'internal_zero', amount: 0 },
          mongoSession,
        ),
      ),
    ).rejects.toThrow('Số tiền không khớp');
    expect((await first.orders.findById(nonzero.id))!.status).toBe(
      OrderStatus.SERVED,
    );
  });
});
