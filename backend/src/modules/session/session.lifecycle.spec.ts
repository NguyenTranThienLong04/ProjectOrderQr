import {
  testMongoUri,
  clearTestCollections,
} from '../../../test/support/test-database';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Connection, createConnection, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'node:crypto';
import { SocketAuthService } from '../../gateway/socket-auth.service';
import { SessionController } from './session.controller';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { SessionStatus } from '../../common/enums/session-status.enum';
import { TableStatus } from '../../common/enums/table-status.enum';
import { Dish, DishDocument, DishSchema } from '../dish/dish.schema';
import { InvoiceLookupService } from '../invoice/invoice-lookup.service';
import { Order, OrderDocument, OrderSchema } from '../order/order.schema';
import { OrderService } from '../order/order.service';
import { OrderStateMachineService } from '../order/order-state-machine.service';
import {
  Promotion,
  PromotionDocument,
  PromotionSchema,
} from '../promotion/promotion.schema';
import { PromotionService } from '../promotion/promotion.service';
import { Table, TableDocument, TableSchema } from '../table/table.schema';
import { TableService } from '../table/table.service';
import {
  PaymentIntent,
  PaymentIntentDocument,
  PaymentIntentSchema,
  PaymentIntentStatus,
} from '../vnpay/payment-intent.schema';
import { VnpayService } from '../vnpay/vnpay.service';
import { Session, SessionDocument, SessionSchema } from './session.schema';
import { SessionService } from './session.service';

// Database lifecycle is owned by the shared integration harness.

describe('Session/table lifecycle (isolated replica set)', () => {
  const connections: Connection[] = [];
  let first: ReturnType<typeof instance>;
  let second: ReturnType<typeof instance>;
  const gateway = { emit: jest.fn() };
  const configValues: Record<string, string> = {
    VNP_HASH_SECRET: 'isolated-lifecycle-secret',
    VNP_TMN_CODE: 'TESTCODE',
    VNP_RETURN_URL: 'http://localhost/vnpay/return',
    VNP_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  };

  function instance(connection: Connection) {
    const orders = connection.model<OrderDocument>(Order.name, OrderSchema);
    const tables = connection.model<TableDocument>(Table.name, TableSchema);
    const sessions = connection.model<SessionDocument>(
      Session.name,
      SessionSchema,
    );
    const dishes = connection.model<DishDocument>(Dish.name, DishSchema);
    const promotions = connection.model<PromotionDocument>(
      Promotion.name,
      PromotionSchema,
    );
    const intents = connection.model<PaymentIntentDocument>(
      PaymentIntent.name,
      PaymentIntentSchema,
    );
    const config = { get: (key: string) => configValues[key] };
    const service = new SessionService(
      sessions,
      tables,
      dishes,
      orders,
      connection,
      intents,
    );
    const tableService = new TableService(
      tables,
      sessions,
      orders,
      config as never,
      {} as never,
      intents,
    );
    const orderService = new OrderService(
      orders,
      tables,
      dishes,
      sessions,
      service,
      new PromotionService(promotions),
      {} as never,
    );
    const state = new OrderStateMachineService(orders, tables);
    const invoice = new InvoiceLookupService(
      intents,
      orders,
      sessions,
      tables,
      {
        renderDetail: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      } as never,
    );
    const payment = new VnpayService(
      config as never,
      orders,
      sessions,
      tables,
      intents,
      connection,
      state,
      gateway as never,
      invoice,
      {} as never,
    );
    return {
      orders,
      tables,
      sessions,
      dishes,
      intents,
      service,
      tableService,
      orderService,
      state,
      payment,
      invoice,
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
  }, 45000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await Promise.all(connections.map((connection) => connection.close()));
  }, 15000);

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    await clearTestCollections(connections[0]);
  });

  async function table(code: string) {
    return first.tables.create({ tableCode: code, qrCodeUrl: 'test-only' });
  }
  async function active(code: string) {
    const physical = await table(code);
    const session = await first.sessions.create({
      tableId: physical._id,
      tableIds: [physical._id],
    });
    await first.tables.updateOne(
      { _id: physical._id },
      { $set: { currentSessionId: session._id, status: TableStatus.OCCUPIED } },
    );
    return { table: physical, session };
  }

  describe('signed QR entry with persisted BSON ownership', () => {
    const secret = 'qr-regression-test-only-signing-secret';
    const jwt = new JwtService();
    function customerEntry() {
      const auth = new SocketAuthService(
        jwt,
        new ConfigService({ JWT_ACCESS_SECRET: secret }),
        first.sessions,
        first.tables,
        {} as never,
      );
      return {
        auth,
        controller: new SessionController(first.service, gateway as never, auth),
      };
    }

    it('exchanges QR without cached credentials, then resumes and authenticates the customer', async () => {
      const physical = await table('QR-A');
      const { auth, controller } = customerEntry();
      const qr = await auth.issueTableEntry(physical.id);
      const grant = await controller.getActive({ tableId: physical.id }, qr);
      expect(grant).toMatchObject({ tableId: physical.id, customerToken: expect.any(String) });
      expect(await controller.getActive({ tableId: physical.id }, undefined, grant.customerToken))
        .toMatchObject({ sessionId: grant.sessionId });
      expect(await auth.authenticate({ customerToken: grant.customerToken }))
        .toMatchObject({ kind: 'customer', sessionId: grant.sessionId, tableId: physical.id });
      expect(await first.sessions.countDocuments()).toBe(1);
    });

    it('accepts matching existing ownership but rejects changed ownership and closed sessions', async () => {
      const owner = await active('QR-A');
      const { auth, controller } = customerEntry();
      const qr = await auth.issueTableEntry(owner.table.id);
      const grant = await controller.getActive({ tableId: owner.table.id }, qr);
      const identity = await auth.verifyCustomer(grant.customerToken);
      expect(grant.sessionId).toBe(owner.session.id);
      await first.sessions.updateOne({ _id: owner.session._id }, { $set: { tableIds: [] } });
      await expect(auth.authorizeCustomer(identity)).rejects.toMatchObject({ status: 401 });
      await first.sessions.updateOne({ _id: owner.session._id }, { $set: { tableIds: [owner.table._id] } });
      await first.tables.updateOne({ _id: owner.table._id }, { $set: { currentSessionId: new Types.ObjectId() } });
      await expect(auth.authorizeCustomer(identity)).rejects.toMatchObject({ status: 401 });
      await first.tables.updateOne({ _id: owner.table._id }, { $set: { currentSessionId: owner.session._id } });
      await first.sessions.updateOne({ _id: owner.session._id }, { $set: { status: SessionStatus.CLOSED } });
      await expect(auth.authorizeCustomer(identity)).rejects.toMatchObject({ status: 401 });
      await expect(controller.getActive({ tableId: owner.table.id, sessionId: grant.sessionId }, qr))
        .rejects.toMatchObject({ status: 404 });
      expect(await first.sessions.countDocuments()).toBe(1);
    });

    it('rejects missing, invalid, expired and cross-table credentials before creating a session', async () => {
      const a = await table('QR-A');
      const b = await table('QR-B');
      const { auth, controller } = customerEntry();
      const qr = await auth.issueTableEntry(a.id);
      const expired = jwt.sign({ tableId: a.id }, {
        secret: createHmac('sha256', secret).update('customer-socket-capability-v1').digest('hex'),
        algorithm: 'HS256', audience: 'table-entry', expiresIn: -1,
      });
      for (const token of [undefined, 'invalid', expired]) {
        await expect(controller.getActive({ tableId: a.id }, token)).rejects.toMatchObject({ status: 401 });
      }
      await expect(controller.getActive({ tableId: b.id }, qr)).rejects.toMatchObject({ status: 401 });
      expect(await first.sessions.countDocuments()).toBe(0);
      const grant = await controller.getActive({ tableId: a.id }, qr);
      await expect(controller.getActive({ tableId: b.id }, undefined, grant.customerToken))
        .rejects.toMatchObject({ status: 401 });
    });
  });
  function order(
    owner: Awaited<ReturnType<typeof active>>,
    amount = 10000,
    status = OrderStatus.SERVED,
  ) {
    return first.orders.create({
      sessionId: owner.session._id,
      tableId: owner.table._id,
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
  function signed(intent: { txnRef: string; amount: number }) {
    const params: Record<string, string> = {
      vnp_TxnRef: intent.txnRef,
      vnp_Amount: String(intent.amount * 100),
      vnp_TmnCode: 'TESTCODE',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_TransactionNo: '123456',
    };
    params.vnp_SecureHash = (first.payment as any).sign(params);
    return params;
  }
  function gate() {
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((done) => {
      entered = done;
    });
    const proceed = new Promise<void>((done) => {
      release = done;
    });
    return {
      ready,
      release,
      async pause() {
        entered();
        await proceed;
      },
    };
  }
  // Hold an actual MongoDB snapshot, not a mock snapshot, before competing writes.
  function pauseRead(model: any, method: string) {
    const barrier = gate();
    const original = model[method].bind(model);
    jest.spyOn(model, method).mockImplementationOnce((...args: any[]) => {
      const query = original(...args);
      const execute = query.exec.bind(query);
      query.exec = async () => {
        const result = await execute();
        await barrier.pause();
        return result;
      };
      return query;
    });
    return barrier;
  }
  async function consistentOwnership() {
    const sessions = await first.sessions.find();
    const tables = await first.tables.find();
    for (const session of sessions) {
      const owned = tables
        .filter((table) => table.currentSessionId?.equals(session._id))
        .map((table) => table.id)
        .sort();
      expect(owned).toEqual(
        session.status === SessionStatus.ACTIVE
          ? session.tableIds.map(String).sort()
          : [],
      );
    }
    for (const table of tables) {
      if (table.currentSessionId)
        expect(
          sessions.some(
            (session) =>
              session.status === SessionStatus.ACTIVE &&
              session._id.equals(table.currentSessionId!),
          ),
        ).toBe(true);
      else expect(table.status).toBe(TableStatus.AVAILABLE);
    }
  }

  test('failed move rolls back both claims; concurrent moves cannot claim the same destination', async () => {
    const a = await active('A');
    const b = await active('B');
    const destination = await table('DEST');
    await first.tables.updateOne(
      { _id: a.table._id },
      { $set: { status: TableStatus.WAITING_PAYMENT } },
    );
    jest.spyOn(first.sessions, 'updateOne').mockImplementationOnce(
      () =>
        ({
          exec: async () => {
            throw new Error('injected after table writes');
          },
        }) as never,
    );
    await expect(
      first.service.moveSessionToTable(a.session.id, destination.id),
    ).rejects.toThrow('injected');
    expect(
      (await second.tables.findById(a.table._id))!.currentSessionId,
    ).toEqual(a.session._id);
    expect(
      (await second.tables.findById(destination._id))!.currentSessionId,
    ).toBeNull();
    await consistentOwnership();

    const barrier = pauseRead(first.sessions, 'findOne');
    const loser = first.service
      .moveSessionToTable(b.session.id, destination.id)
      .catch((error) => error);
    await barrier.ready;
    await second.service.moveSessionToTable(a.session.id, destination.id);
    barrier.release();
    expect(await loser).toBeInstanceOf(ConflictException);
    expect((await first.tables.findById(destination._id))!.status).toBe(
      TableStatus.WAITING_PAYMENT,
    );
    expect(
      (await first.tables.findById(b.table._id))!.currentSessionId,
    ).toEqual(b.session._id);
    await consistentOwnership();
  });

  test('close competes with real create-order/payment and never commits partial release', async () => {
    const a = await active('CREATE');
    const dish = await first.dishes.create({
      name: 'Rice',
      price: 10000,
      categoryId: new Types.ObjectId(),
    });
    const barrier = pauseRead(first.sessions, 'findById');
    const staleClose = first.tableService
      .clear(a.table.id)
      .catch((error) => error);
    await barrier.ready;
    const cart = await second.service.addToCart(a.session.id, dish.id, 1);
    await second.orderService.createCustomerOrder({
      tableId: a.table.id,
      sessionId: a.session.id,
      cartVersion: cart.version,
      idempotencyKey: 'lifecycle-create',
    });
    barrier.release();
    expect(await staleClose).toBeInstanceOf(ConflictException);
    expect(
      await first.orders.countDocuments({ sessionId: a.session._id }),
    ).toBe(1);
    expect((await first.sessions.findById(a.session._id))!.status).toBe(
      SessionStatus.ACTIVE,
    );

    const b = await active('PAY');
    const paidOrder = await order(b);
    const intent = await first.payment.createPaymentUrl(
      b.session.id,
      b.table.id,
      '::1',
    );
    const paymentBarrier = gate();
    const settle = first.state.transitionManyToPaid.bind(first.state);
    jest
      .spyOn(first.state, 'transitionManyToPaid')
      .mockImplementationOnce(async (...args) => {
        const result = await settle(...args);
        await paymentBarrier.pause();
        return result;
      });
    const payment = first.payment.handleIpn(signed(intent));
    await paymentBarrier.ready;
    await expect(second.tableService.clear(b.table.id)).rejects.toThrow(
      ConflictException,
    );
    expect((await second.orders.findById(paidOrder._id))!.status).toBe(
      OrderStatus.SERVED,
    );
    paymentBarrier.release();
    expect(await payment).toMatchObject({ RspCode: '00' });
    jest.spyOn(first.tables, 'updateMany').mockImplementationOnce(
      () =>
        ({
          exec: async () => {
            throw new Error('injected after session close');
          },
        }) as never,
    );
    await expect(first.tableService.clear(b.table.id)).rejects.toThrow(
      'injected',
    );
    expect((await second.sessions.findById(b.session._id))!.status).toBe(
      SessionStatus.ACTIVE,
    );
    await second.tableService.clear(b.table.id);
    expect((await first.sessions.findById(b.session._id))!.status).toBe(
      SessionStatus.CLOSED,
    );

    const c = await active('UNRESOLVED');
    const cancelled = await order(c);
    await first.payment.createPaymentUrl(c.session.id, c.table.id, '::1');
    // Reproduce a legacy cancelled Order with an unresolved provider checkout.
    await first.orders.updateOne(
      { _id: cancelled._id },
      { $set: { status: OrderStatus.CANCELLED } },
    );
    await expect(first.tableService.clear(c.table.id)).rejects.toThrow(
      ConflictException,
    );
    await consistentOwnership();
  });

  test('payment history blocks merge/unmerge; receipts survive move/close and legacy session reassignment', async () => {
    const a = await active('ORIGINAL');
    const b = await active('OTHER');
    const original = await order(a);
    // Merge starts on a snapshot with no checkout. A concurrent checkout wins.
    const barrier = pauseRead(first.orders, 'find');
    const merge = first.service
      .mergeTables(a.table.id, b.table.id)
      .catch((error) => error);
    await barrier.ready;
    const checkout = await second.payment.createPaymentUrl(
      a.session.id,
      a.table.id,
      '::1',
    );
    barrier.release();
    expect(await merge).toBeInstanceOf(ConflictException);
    const intent = (await first.intents.findOne({ txnRef: checkout.txnRef }))!;
    await expect(
      first.service.mergeTables(a.table.id, b.table.id),
    ).rejects.toThrow(ConflictException);
    await first.intents.updateOne(
      { _id: intent._id },
      { $set: { status: PaymentIntentStatus.FAILED, ipnConfirmed: true } },
    );
    await expect(
      first.service.mergeTables(a.table.id, b.table.id),
    ).rejects.toThrow(ConflictException);
    const retry = await first.payment.createPaymentUrl(
      a.session.id,
      a.table.id,
      '::1',
    );
    expect(await first.payment.handleIpn(signed(retry))).toMatchObject({
      RspCode: '00',
    });
    await expect(
      first.service.mergeTables(a.table.id, b.table.id),
    ).rejects.toThrow(ConflictException);
    const receipt = (await first.intents.findOne({ txnRef: retry.txnRef }))!;
    const before = await first.invoice.detail(receipt);
    const orderBefore = (await first.orders.findById(original._id))!;
    const destination = await table('MOVED');
    await first.service.moveSessionToTable(a.session.id, destination.id);
    await first.tableService.clear(destination.id);
    expect(await first.invoice.lookup(receipt.invoiceCode!)).toEqual(before);
    await expect(
      first.payment.getPaymentStatus(receipt.txnRef, a.session.id, a.table.id),
    ).resolves.toMatchObject({
      status: PaymentIntentStatus.SUCCEEDED,
      coveredOrderIds: [original.id],
    });
    expect((await first.orders.findById(original._id))!.statusHistory).toEqual(
      orderBefore.statusHistory,
    );
    expect((await first.intents.findById(receipt._id))!.toObject()).toEqual(
      receipt.toObject(),
    );

    // Existing historical records may already have a reassigned sessionId.
    await first.orders.updateOne(
      { _id: original._id },
      { $set: { sessionId: b.session._id } },
    );
    expect(await first.invoice.lookup(receipt.invoiceCode!)).toEqual(before);
    await expect(
      first.invoice.legacyFile(original.id, a.session.id),
    ).resolves.toHaveProperty('pdf');
    await expect(
      first.invoice.legacyFile(original.id, b.session.id),
    ).rejects.toThrow(ForbiddenException);

    const c = await active('ZERO');
    const d = await active('ROOT');
    await order(c, 0);
    await first.service.mergeTables(c.table.id, d.table.id);
    await first.payment.createPaymentUrl(d.session.id, d.table.id, '::1');
    await expect(first.service.unmergeSession(c.session.id)).rejects.toThrow(
      ConflictException,
    );
    await consistentOwnership();
  });

  test('merge/move/clear and group claims serialize; unmerge restores moved orders and nested ownership', async () => {
    const a = await active('A');
    const b = await active('B');
    const destination = await table('DEST');
    let barrier = pauseRead(first.orders, 'find');
    const staleMerge = first.service
      .mergeTables(a.table.id, b.table.id)
      .catch((error) => error);
    await barrier.ready;
    await second.service.moveSessionToTable(a.session.id, destination.id);
    barrier.release();
    expect(await staleMerge).toBeInstanceOf(ConflictException);
    barrier = pauseRead(first.sessions, 'findById');
    const staleClear = first.tableService
      .clear(destination.id)
      .catch((error) => error);
    await barrier.ready;
    await second.service.mergeTables(destination.id, b.table.id);
    barrier.release();
    expect(await staleClear).toBeInstanceOf(ConflictException);
    await first.service.unmergeSession(a.session.id);
    await consistentOwnership();

    const e = await table('GROUP1');
    const f = await table('GROUP2');
    await first.service.mergeTables(e.id, f.id);
    barrier = pauseRead(first.tables, 'findById');
    const staleOpen = first.service
      .getOrCreateActiveSession(e.id)
      .catch((error) => error);
    await barrier.ready;
    const opened = await second.service.getOrCreateActiveSession(f.id);
    barrier.release();
    expect(await staleOpen).toBeInstanceOf(ConflictException);
    expect((await first.service.getOrCreateActiveSession(e.id)).sessionId).toBe(
      opened.sessionId,
    );
    expect(
      await first.sessions.countDocuments({
        tableIds: e._id,
        status: SessionStatus.ACTIVE,
      }),
    ).toBe(1);

    // Order.tableId is intentionally the old physical table, not the moved one.
    const sourceOrder = await order(a);
    const history = sourceOrder.toObject().statusHistory;
    await first.service.mergeTables(destination.id, b.table.id);
    const outer = await active('OUTER');
    await first.service.mergeTables(b.table.id, outer.table.id);
    expect(
      (await first.sessions.findById(a.session._id))!.mergedIntoSessionId,
    ).toEqual(outer.session._id);
    await first.service.unmergeSession(b.session.id);
    expect(
      (await first.sessions.findById(a.session._id))!.mergedIntoSessionId,
    ).toEqual(b.session._id);
    await first.service.unmergeSession(a.session.id);
    const restored = (await first.orders.findById(sourceOrder._id))!;
    expect(restored.sessionId).toEqual(a.session._id);
    expect(restored.tableId).toEqual(a.table._id);
    expect(restored.toObject().statusHistory).toEqual(history);
    await consistentOwnership();
  });
});
