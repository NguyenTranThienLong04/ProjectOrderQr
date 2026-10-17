import { createHmac } from 'node:crypto';
import { Connection, createConnection, Types } from 'mongoose';
import { ForbiddenException } from '@nestjs/common';
import {
  clearTestCollections,
  testMongoUri,
} from '../../../test/support/test-database';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { SessionStatus } from '../../common/enums/session-status.enum';
import { TableStatus } from '../../common/enums/table-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { Order, OrderSchema } from '../order/order.schema';
import { OrderStateMachineService } from '../order/order-state-machine.service';
import { OrderService } from '../order/order.service';
import { InvoiceService } from '../order/invoice.service';
import { InvoiceLookupService } from '../invoice/invoice-lookup.service';
import { Session, SessionSchema } from '../session/session.schema';
import { SessionService } from '../session/session.service';
import { Table, TableSchema } from '../table/table.schema';
import { TableService } from '../table/table.service';
import { Dish, DishSchema } from '../dish/dish.schema';
import {
  PaymentIntent,
  PaymentIntentSchema,
  PaymentIntentStatus,
  UNRESOLVED_PAYMENT_FILTER,
} from './payment-intent.schema';
import { VnpayService } from './vnpay.service';

describe('Cash settlement lifecycle (isolated replica set)', () => {
  const connections: Connection[] = [];
  const gateway = { emit: jest.fn(), endCustomerSession: jest.fn() };
  const actor = { id: new Types.ObjectId().toString(), role: UserRole.WAITER };
  const configValues: Record<string, string> = {
    VNP_HASH_SECRET: 'cash-test-secret',
    VNP_TMN_CODE: 'TESTCODE',
    VNP_RETURN_URL: 'http://localhost/vnpay/return',
    VNP_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  };
  function instance(connection: Connection) {
    const orders = connection.model(Order.name, OrderSchema);
    const tables = connection.model(Table.name, TableSchema);
    const sessions = connection.model(Session.name, SessionSchema);
    const intents = connection.model(PaymentIntent.name, PaymentIntentSchema);
    const dishes = connection.model(Dish.name, DishSchema);
    const state = new OrderStateMachineService(orders, tables);
    const config = { get: (key: string) => configValues[key] };
    const sessionService = new SessionService(
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
    const invoice = new InvoiceLookupService(
      intents,
      orders,
      sessions,
      tables,
      new InvoiceService(),
    );
    const payments = new VnpayService(
      config as never,
      orders,
      sessions,
      tables,
      intents,
      connection,
      state,
      gateway as never,
      invoice,
    );
    const orderService = new OrderService(
      orders,
      tables,
      dishes,
      sessions,
      sessionService,
      {
        reserveForOrder: (_code: unknown, subtotal: number) =>
          Promise.resolve({
            discountAmount: 0,
            totalAmount: subtotal,
          }),
      } as never,
      new InvoiceService(),
    );
    return {
      orders,
      tables,
      sessions,
      intents,
      dishes,
      state,
      payments,
      sessionService,
      tableService,
      invoice,
      orderService,
    };
  }
  let first: ReturnType<typeof instance>;
  let second: ReturnType<typeof instance>;
  let sessionId: Types.ObjectId;
  let tableId: Types.ObjectId;
  let orderId: Types.ObjectId;
  let confirmationKey: string;
  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const connection = await createConnection(testMongoUri()).asPromise();
      connections.push(connection);
    }
    first = instance(connections[0]);
    second = instance(connections[1]);
    await Promise.all(
      connections.flatMap((connection) =>
        Object.values(connection.models).map((model) => model.init()),
      ),
    );
  });
  afterAll(async () => {
    await Promise.all(connections.map((connection) => connection.close()));
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    await clearTestCollections(connections[0]);
    tableId = new Types.ObjectId();
    sessionId = new Types.ObjectId();
    await first.sessions.create({
      _id: sessionId,
      tableId,
      tableIds: [tableId],
    });
    await first.tables.create({
      _id: tableId,
      tableCode: 'CASH1',
      qrCodeUrl: 'fixture',
      currentSessionId: sessionId,
      status: TableStatus.WAITING_PAYMENT,
    });
    const order = await first.orders.create({
      sessionId,
      tableId,
      status: OrderStatus.SERVED,
      subtotalAmount: 10000,
      discountAmount: 2000,
      totalAmount: 8000,
      items: [
        {
          dishId: new Types.ObjectId(),
          dishName: 'Rice',
          unitPrice: 10000,
          quantity: 1,
          status: OrderStatus.SERVED,
        },
      ],
    });
    orderId = order._id;
    confirmationKey = (
      await first.payments.getCashSettlementSummary(String(tableId))
    ).confirmationKey;
  });
  const expected = () => ({
    sessionId: String(sessionId),
    sessionVersion: 0,
    confirmationKey,
  });
  const cash = (app = first) =>
    app.payments.settleCash(String(tableId), expected(), actor);
  const checkout = () =>
    first.payments.createPaymentUrl(
      String(sessionId),
      String(tableId),
      '127.0.0.1',
    );
  function signed(intent: { txnRef: string; amount: number }, failure = false) {
    const params: Record<string, string> = {
      vnp_TxnRef: intent.txnRef,
      vnp_Amount: String(intent.amount * 100),
      vnp_TmnCode: 'TESTCODE',
      vnp_ResponseCode: failure ? '24' : '00',
      vnp_TransactionStatus: failure ? '02' : '00',
      vnp_TransactionNo: '987654',
    };
    const data = Object.keys(params)
      .sort()
      .map(
        (key) =>
          `${key}=${encodeURIComponent(params[key]).replace(/%20/g, '+')}`,
      )
      .join('&');
    params.vnp_SecureHash = createHmac('sha512', configValues.VNP_HASH_SECRET)
      .update(data)
      .digest('hex');
    return params;
  }
  function latch() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('atomically pays Served orders through the state machine, audits CASH, closes all owned tables and produces a receipt/PDF', async () => {
    const sibling = await first.tables.create({
      tableCode: 'CASH2',
      qrCodeUrl: 'fixture',
      currentSessionId: sessionId,
      status: TableStatus.WAITING_PAYMENT,
    });
    await first.sessions.updateOne(
      { _id: sessionId },
      { $push: { tableIds: sibling._id } },
    );
    const receipt = await cash();
    expect(receipt).toMatchObject({ amount: 8000, paymentMethod: 'CASH' });
    const order = await first.orders.findById(orderId).orFail();
    expect(order.status).toBe(OrderStatus.PAID);
    expect(order.paymentMethod).toBe('CASH');
    expect(order.paidAt).toBeInstanceOf(Date);
    expect(order.statusHistory).toHaveLength(1);
    expect(order.statusHistory[0]).toMatchObject({
      fromStatus: OrderStatus.SERVED,
      toStatus: OrderStatus.PAID,
      source: 'cash_settlement',
      amount: 8000,
      changedBy: { userId: new Types.ObjectId(actor.id), role: actor.role },
    });
    expect(await first.sessions.findById(sessionId)).toMatchObject({
      status: SessionStatus.CLOSED,
    });
    expect((await first.sessions.findById(sessionId))?.endedAt).toBeInstanceOf(
      Date,
    );
    expect(await first.tables.find({})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: TableStatus.AVAILABLE,
          currentSessionId: null,
        }),
        expect.objectContaining({
          status: TableStatus.AVAILABLE,
          currentSessionId: null,
        }),
      ]),
    );
    expect(
      await first.tables.countDocuments({ currentSessionId: sessionId }),
    ).toBe(0);
    const intent = await first.intents
      .findOne({ paymentMethod: 'CASH' })
      .orFail();
    expect(intent.ipnConfirmed).toBe(false);
    expect(String(intent.settledByUserId)).toBe(actor.id);
    expect(intent.settledByRole).toBe(actor.role);
    const detail = await first.invoice.lookup(receipt.invoiceCode!);
    expect(detail).toMatchObject({
      totalAmount: 8000,
      discountAmount: 2000,
      paymentMethod: 'CASH',
      paymentStatus: 'succeeded',
    });
    expect(
      (await first.invoice.file(detail)).pdf.subarray(0, 4).toString(),
    ).toBe('%PDF');
    expect(gateway.endCustomerSession).toHaveBeenCalledWith(String(sessionId));
  });

  it.each([PaymentIntentStatus.PENDING, PaymentIntentStatus.FAILED])(
    'resolves %s VNPAY terminally without faking provider fields/IPN, preserving history and old invoice identity',
    async (status) => {
      const payment = await checkout();
      await first.intents.updateOne(
        { txnRef: payment.txnRef },
        {
          $set: {
            status,
            responseCode: '24',
            transactionNo: 'legacy-browser-value',
          },
        },
      );
      const original = await first.intents
        .findOne({ txnRef: payment.txnRef })
        .orFail();
      const receipt = await cash();
      const superseded = await first.intents.findById(original._id).orFail();
      expect(superseded).toMatchObject({
        txnRef: original.txnRef,
        amount: original.amount,
        createdAt: original.createdAt,
        invoiceCode: original.invoiceCode,
        responseCode: '24',
        transactionNo: 'legacy-browser-value',
        ipnConfirmed: false,
        status: PaymentIntentStatus.SUPERSEDED,
        resolutionSource: 'cash_settlement',
      });
      expect(superseded.resolvedAt).toBeInstanceOf(Date);
      expect(
        await first.intents.countDocuments(UNRESOLVED_PAYMENT_FILTER),
      ).toBe(0);
      expect(await first.invoice.lookup(original.invoiceCode!)).toMatchObject({
        paymentStatus: 'superseded',
        replacementInvoiceCode: receipt.invoiceCode,
        paidAt: null,
      });
      await expect(
        first.payments.generateSessionInvoiceFile(
          payment.txnRef,
          String(sessionId),
          String(tableId),
        ),
      ).rejects.toThrow();
    },
  );

  it('rescanning creates a new session; new summary/status/invoice cannot expose the prior checkout', async () => {
    const payment = await checkout();
    await cash();
    const next = await first.sessionService.getOrCreateActiveSession(
      String(tableId),
    );
    expect(next.sessionId).not.toBe(String(sessionId));
    expect(
      (await first.sessionService.getOrCreateActiveSession(String(tableId)))
        .sessionId,
    ).toBe(next.sessionId);
    expect(
      await first.payments.getSessionPaymentSummary(
        next.sessionId,
        String(tableId),
      ),
    ).toMatchObject({ orders: [], payableTotal: 0 });
    await expect(
      first.payments.getPaymentStatus(
        payment.txnRef,
        next.sessionId,
        String(tableId),
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      first.payments.generateSessionInvoiceFile(
        payment.txnRef,
        next.sessionId,
        String(tableId),
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      first.payments.createPaymentUrl(
        next.sessionId,
        String(tableId),
        '127.0.0.1',
      ),
    ).rejects.toThrow();
    await expect(
      first.sessionService.getCart(String(sessionId)),
    ).rejects.toThrow();
  });

  it('rejects direct clear and Admin status update/delete while unpaid, unresolved or cart-bearing', async () => {
    await expect(first.tableService.clear(String(tableId))).rejects.toThrow();
    await expect(
      first.tableService.update(String(tableId), {
        status: TableStatus.AVAILABLE,
      }),
    ).rejects.toThrow();
    await expect(first.tableService.remove(String(tableId))).rejects.toThrow();
    await checkout();
    // Simulate legacy data with terminal Orders but an unresolved checkout.
    await first.orders.updateOne(
      { _id: orderId },
      { $set: { status: OrderStatus.PAID } },
    );
    await expect(first.tableService.clear(String(tableId))).rejects.toThrow(
      /Checkout/,
    );
    await first.sessions.updateOne(
      { _id: sessionId },
      {
        $push: {
          cart: {
            dishId: new Types.ObjectId(),
            dishName: 'Rice',
            unitPrice: 1000,
            quantity: 1,
          },
        },
      },
    );
    await expect(first.tableService.clear(String(tableId))).rejects.toThrow(
      /giỏ hàng/,
    );
    expect(await first.sessions.findById(sessionId)).toMatchObject({
      status: SessionStatus.ACTIVE,
    });
  });

  it.each([OrderStatus.PAID, OrderStatus.CANCELLED, OrderStatus.PENDING])(
    'refuses cash for %s and rejects non-staff without writes',
    async (status) => {
      await expect(
        first.payments.settleCash(String(tableId), expected(), {
          ...actor,
          role: UserRole.KITCHEN,
        }),
      ).rejects.toThrow(ForbiddenException);
      await first.orders.updateOne({ _id: orderId }, { $set: { status } });
      await expect(cash()).rejects.toThrow();
      expect(
        await first.intents.countDocuments({ paymentMethod: 'CASH' }),
      ).toBe(0);
      expect((await first.sessions.findById(sessionId))?.status).toBe(
        SessionStatus.ACTIVE,
      );
    },
  );

  it('two staff confirmations commit exactly one receipt and one payment history entry', async () => {
    await checkout();
    const outcomes = await Promise.allSettled([cash(first), cash(second)]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(await first.intents.countDocuments({ paymentMethod: 'CASH' })).toBe(
      1,
    );
    expect((await first.orders.findById(orderId))?.statusHistory).toHaveLength(
      1,
    );
  });

  it('concurrent direct clear cannot bypass or duplicate cash settlement', async () => {
    await checkout();
    const outcomes = await Promise.allSettled([
      cash(),
      second.tableService.clear(String(tableId)),
    ]);
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1].status).toBe('rejected');
    expect(await first.intents.countDocuments({ paymentMethod: 'CASH' })).toBe(
      1,
    );
    expect((await first.orders.findById(orderId))?.statusHistory).toHaveLength(
      1,
    );
    expect((await first.tables.findById(tableId))?.currentSessionId).toBeNull();
  });

  it('rejects a changed bill after preview even when cancellation leaves Session.version unchanged', async () => {
    const extra = await first.orders.create({
      sessionId,
      tableId,
      status: OrderStatus.SERVED,
      totalAmount: 1000,
      items: [
        {
          dishId: new Types.ObjectId(),
          dishName: 'Tea',
          unitPrice: 1000,
          quantity: 1,
          status: OrderStatus.SERVED,
        },
      ],
    });
    const preview = await first.payments.getCashSettlementSummary(
      String(tableId),
    );
    await second.state.cancelByAdmin(extra.id, {
      ...actor,
      role: UserRole.ADMIN,
    });
    await expect(
      first.payments.settleCash(String(tableId), preview, actor),
    ).rejects.toThrow();
    expect(await first.intents.countDocuments({ paymentMethod: 'CASH' })).toBe(
      0,
    );
    expect((await first.orders.findById(orderId))?.status).toBe(
      OrderStatus.SERVED,
    );
  });

  it('VNPAY commits while cash is in flight: cash aborts completely', async () => {
    const payment = await checkout();
    const entered = latch();
    const release = latch();
    const transition = first.state.transitionManyToPaid.bind(first.state);
    jest
      .spyOn(first.state, 'transitionManyToPaid')
      .mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return transition(...args);
      });
    const attempt = cash().then(
      () => 'committed',
      () => 'rejected',
    );
    await entered.promise;
    try {
      expect((await second.payments.handleIpn(signed(payment))).RspCode).toBe(
        '00',
      );
    } finally {
      release.resolve();
    }
    expect(await attempt).toBe('rejected');
    expect(await first.intents.countDocuments({ paymentMethod: 'CASH' })).toBe(
      0,
    );
    expect((await first.orders.findById(orderId))?.paymentMethod).toBe('VNPAY');
    expect((await first.sessions.findById(sessionId))?.status).toBe(
      SessionStatus.ACTIVE,
    );
    await expect(cash()).rejects.toThrow(/VNPAY/);
  });

  it('cash wins a concurrent IPN: late charge is recorded for review without another settlement, and retries are idempotent', async () => {
    const payment = await checkout();
    const claimed = latch();
    const release = latch();
    const ipnEntered = latch();
    const cashTransition = first.state.transitionManyToPaid.bind(first.state);
    jest
      .spyOn(first.state, 'transitionManyToPaid')
      .mockImplementationOnce(async (...args) => {
        const result = await cashTransition(...args);
        claimed.resolve();
        await release.promise;
        return result;
      });
    const ipnTransition = second.state.transitionManyToPaid.bind(second.state);
    jest
      .spyOn(second.state, 'transitionManyToPaid')
      .mockImplementation(async (...args) => {
        ipnEntered.resolve();
        return ipnTransition(...args);
      });
    const attempt = cash();
    await claimed.promise;
    const ipn = second.payments.handleIpn(signed(payment));
    await ipnEntered.promise;
    release.resolve();
    await attempt;
    expect((await ipn).RspCode).toBe('00');
    expect((await second.payments.handleIpn(signed(payment))).RspCode).toBe(
      '02',
    );
    expect(
      await first.intents.findOne({ txnRef: payment.txnRef }),
    ).toMatchObject({
      status: 'superseded',
      ipnConfirmed: true,
      lateProviderStatus: 'succeeded',
      reconciliationRequired: true,
    });
    expect((await first.orders.findById(orderId))?.statusHistory).toHaveLength(
      1,
    );
    expect(await first.intents.countDocuments({ status: 'succeeded' })).toBe(1);
  });

  it('verified late failure after cash remains superseded without a reconciliation charge', async () => {
    const payment = await checkout();
    // Legacy pending records may predate the explicit ipnConfirmed field.
    await first.intents.collection.updateOne(
      { txnRef: payment.txnRef },
      { $unset: { ipnConfirmed: '' } },
    );
    await cash();
    expect(
      (await first.payments.handleIpn(signed(payment, true))).RspCode,
    ).toBe('00');
    expect(
      await first.intents.findOne({ txnRef: payment.txnRef }),
    ).toMatchObject({
      status: 'superseded',
      lateProviderStatus: 'failed',
      reconciliationRequired: false,
    });
    expect((await first.orders.findById(orderId))?.statusHistory).toHaveLength(
      1,
    );
  });

  it('cart/create-order wins after preview: stale cash confirmation cannot consume the newer bill', async () => {
    const preview = await first.payments.getCashSettlementSummary(
      String(tableId),
    );
    const dish = await first.dishes.create({
      name: 'Tea',
      price: 1000,
      categoryId: new Types.ObjectId(),
      isAvailable: true,
    });
    await first.sessionService.addToCart(String(sessionId), dish.id, 1);
    const session = await first.sessions.findById(sessionId).orFail();
    const results = await Promise.allSettled([
      first.payments.settleCash(String(tableId), preview, actor),
      second.orderService.createCustomerOrder({
        tableId: String(tableId),
        sessionId: String(sessionId),
        cartVersion: session.version,
        idempotencyKey: `cash-race-${String(sessionId)}`,
      }),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(
      await first.orders.countDocuments({
        sessionId,
        status: OrderStatus.PAID,
      }),
    ).toBe(0);
    expect((await first.sessions.findById(sessionId))?.status).toBe(
      SessionStatus.ACTIVE,
    );
  });

  it.each(['move', 'merge'] as const)(
    'cash versus %s has one lifecycle winner with consistent ownership',
    async (operation) => {
      const target = await first.tables.create({
        tableCode: 'TARGET',
        qrCodeUrl: 'fixture',
      });
      const outcomes = await Promise.allSettled([
        cash(),
        operation === 'move'
          ? second.sessionService.moveSessionToTable(
              String(sessionId),
              target.id,
            )
          : second.sessionService.mergeTables(target.id, String(tableId)),
      ]);
      const session = await first.sessions.findById(sessionId).orFail();
      if (outcomes[0].status === 'fulfilled') {
        expect(session.status).toBe(SessionStatus.CLOSED);
        expect(
          await first.tables.countDocuments({ currentSessionId: sessionId }),
        ).toBe(0);
      } else {
        expect(outcomes[1].status).toBe('fulfilled');
        expect(session.status).toBe(SessionStatus.ACTIVE);
        expect(
          await first.intents.countDocuments({ paymentMethod: 'CASH' }),
        ).toBe(0);
      }
    },
  );

  it('a failure releasing tables rolls back Orders, receipt, supersession and session close', async () => {
    const payment = await checkout();
    jest.spyOn(first.tables, 'updateMany').mockReturnValueOnce({
      exec: () => Promise.reject(new Error('simulated table failure')),
    } as never);
    await expect(cash()).rejects.toThrow('simulated table failure');
    expect((await first.orders.findById(orderId))?.status).toBe(
      OrderStatus.SERVED,
    );
    expect((await first.sessions.findById(sessionId))?.status).toBe(
      SessionStatus.ACTIVE,
    );
    expect(
      (await first.intents.findOne({ txnRef: payment.txnRef }))?.status,
    ).toBe(PaymentIntentStatus.PENDING);
    expect(await first.intents.countDocuments({ paymentMethod: 'CASH' })).toBe(
      0,
    );
  });
});
