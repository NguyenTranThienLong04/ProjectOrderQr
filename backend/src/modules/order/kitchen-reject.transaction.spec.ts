import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Connection, createConnection, Types } from 'mongoose';
import { createHmac } from 'node:crypto';
import {
  clearTestCollections,
  testMongoUri,
} from '../../../test/support/test-database';
import {
  OrderStatus,
  REJECTED_ITEM_STATUS,
  type OrderItemStatus,
} from '../../common/enums/order-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { Order, OrderSchema } from './order.schema';
import { OrderStateMachineService } from './order-state-machine.service';
import { OrderService } from './order.service';
import { OrderController } from './order.controller';
import { InvoiceService } from './invoice.service';
import { InvoiceLookupService } from '../invoice/invoice-lookup.service';
import { Table, TableSchema } from '../table/table.schema';
import { Session, SessionSchema } from '../session/session.schema';
import { SessionService } from '../session/session.service';
import { Dish, DishSchema } from '../dish/dish.schema';
import { Promotion, PromotionSchema } from '../promotion/promotion.schema';
import { PromotionService } from '../promotion/promotion.service';
import { PromotionType } from '../promotion/promotion-type.enum';
import {
  PaymentIntent,
  PaymentIntentSchema,
  PaymentIntentStatus,
} from '../vnpay/payment-intent.schema';
import { VnpayService } from '../vnpay/vnpay.service';
import { CashShift, CashShiftSchema } from '../finance/cash-shift.schema';
import { AdminService } from '../admin/admin.service';

describe('Kitchen rejection (isolated replica set)', () => {
  const connections: Connection[] = [];
  const kitchen = {
    id: new Types.ObjectId().toString(),
    role: UserRole.KITCHEN,
  };
  const waiter = { id: new Types.ObjectId().toString(), role: UserRole.WAITER };
  const gateway = { emit: jest.fn(), endCustomerSession: jest.fn() };
  const configValues: Record<string, string> = {
    VNP_HASH_SECRET: 'reject-test-secret',
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
    const promotions = connection.model(Promotion.name, PromotionSchema);
    const state = new OrderStateMachineService(orders, tables);
    const promo = new PromotionService(promotions);
    const sessionService = new SessionService(
      sessions,
      tables,
      dishes,
      orders,
      connection,
      intents,
    );
    const invoice = new InvoiceLookupService(
      intents,
      orders,
      sessions,
      tables,
      new InvoiceService(),
    );
    const queries = new OrderService(
      orders,
      tables,
      dishes,
      sessions,
      sessionService,
      promo,
      new InvoiceService(),
    );
    const payments = new VnpayService(
      { get: (key: string) => configValues[key] } as never,
      orders,
      sessions,
      tables,
      intents,
      connection,
      state,
      gateway as never,
      invoice,
      connection.model(CashShift.name, CashShiftSchema),
    );
    return {
      orders,
      tables,
      sessions,
      intents,
      promotions,
      dishes,
      promo,
      state,
      invoice,
      queries,
      payments,
    };
  }
  let first: ReturnType<typeof instance>;
  let second: ReturnType<typeof instance>;
  let sessionId: Types.ObjectId;
  let tableId: Types.ObjectId;
  beforeAll(async () => {
    connections.push(
      await createConnection(testMongoUri()).asPromise(),
      await createConnection(testMongoUri()).asPromise(),
    );
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
      tableCode: 'REJECT1',
      qrCodeUrl: 'fixture',
      currentSessionId: sessionId,
      status: 'occupied',
    });
  });
  const seed = (
    statuses: OrderItemStatus[] = [OrderStatus.PENDING, OrderStatus.SERVED],
    status = OrderStatus.PENDING,
  ) =>
    first.orders.create({
      sessionId,
      tableId,
      status,
      subtotalAmount: statuses.length * 10000,
      totalAmount: statuses.length * 10000,
      items: statuses.map((itemStatus) => ({
        dishId: new Types.ObjectId(),
        dishName: 'Rice',
        quantity: 1,
        unitPrice: 10000,
        status: itemStatus,
      })),
    });
  const reject = (
    order: Awaited<ReturnType<typeof seed>>,
    actor = kitchen,
    reason = 'Hết nguyên liệu',
  ) =>
    first.state.transitionItem(
      order.id,
      String(order.items[0]._id),
      REJECTED_ITEM_STATUS,
      actor,
      reason,
    );

  it('commits reason/actor/time/history and reprices mixed Served + Rejected before emitting; customer/waiter queries agree', async () => {
    const order = await seed();
    const emitOrderUpdated = jest.fn(async (payload: { id: string }) => {
      const persisted = await second.orders.findById(payload.id).orFail();
      expect(persisted.totalAmount).toBe(10000);
      expect(persisted.items[0].status).toBe(REJECTED_ITEM_STATUS);
    });
    const controller = new OrderController(
      first.queries,
      { emitOrderUpdated, emit: jest.fn() } as never,
      first.state,
      first.invoice,
    );
    const result = await controller.transition(
      order.id,
      String(order.items[0]._id),
      { status: REJECTED_ITEM_STATUS, rejectionReason: '  Hết nguyên liệu  ' },
      { user: kitchen },
    );
    expect(result.status).toBe(OrderStatus.SERVED);
    expect(result.items[0]).toMatchObject({
      status: REJECTED_ITEM_STATUS,
      rejectionReason: 'Hết nguyên liệu',
      rejectedBy: new Types.ObjectId(kitchen.id),
      unitPrice: 10000,
    });
    expect(result.items[0].rejectedAt).toBeInstanceOf(Date);
    expect(result.items[0].statusHistory).toHaveLength(1);
    expect(result.items[0].statusHistory[0]).toMatchObject({
      fromStatus: OrderStatus.PENDING,
      toStatus: REJECTED_ITEM_STATUS,
      note: 'Hết nguyên liệu',
      changedBy: { role: UserRole.KITCHEN },
    });
    expect(result.statusHistory[0].toStatus).toBe(OrderStatus.SERVED);
    expect(emitOrderUpdated).toHaveBeenCalledTimes(1);
    const summary = await first.payments.getSessionPaymentSummary(
      String(sessionId),
      String(tableId),
    );
    expect(summary).toMatchObject({
      payableTotal: 10000,
      subtotalAmount: 10000,
      canPay: true,
    });
    expect(summary.orders[0].items[0]).toMatchObject({
      status: REJECTED_ITEM_STATUS,
      rejectionReason: 'Hết nguyên liệu',
    });
    expect((await first.queries.listForWaiter())[0].items[0]).toMatchObject({
      status: REJECTED_ITEM_STATUS,
      rejectionReason: 'Hết nguyên liệu',
    });
    expect(await first.queries.listForKitchen()).toEqual([]);
    await expect(
      controller.transition(
        order.id,
        String(order.items[0]._id),
        { status: REJECTED_ITEM_STATUS, rejectionReason: 'again' },
        { user: kitchen },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(emitOrderUpdated).toHaveBeenCalledTimes(1);
  });

  it('rejects other roles, blank/oversize reasons and non-Pending/terminal states without writes', async () => {
    const order = await seed();
    for (const role of [UserRole.ADMIN, UserRole.WAITER])
      await expect(reject(order, { ...kitchen, role })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    for (const reason of ['   ', 'x'.repeat(251)])
      await expect(reject(order, kitchen, reason)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    for (const status of [
      OrderStatus.PREPARING,
      OrderStatus.READY,
      OrderStatus.SERVED,
      REJECTED_ITEM_STATUS,
    ]) {
      const invalid = await seed([status]);
      await expect(reject(invalid)).rejects.toBeInstanceOf(ForbiddenException);
    }
    for (const status of [OrderStatus.PAID, OrderStatus.CANCELLED]) {
      const invalid = await seed([OrderStatus.PENDING], status);
      await expect(reject(invalid)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(
      (await first.orders.findById(order._id).orFail()).toObject(),
    ).toEqual(order.toObject());
  });

  it('all rejected cancels at zero and permits table clearing; remaining Ready can still become Served', async () => {
    const mixed = await seed([OrderStatus.PENDING, OrderStatus.READY]);
    const rejected = await reject(mixed);
    expect(rejected.status).toBe(OrderStatus.PENDING);
    const served = await first.state.transitionItem(
      mixed.id,
      String(mixed.items[1]._id),
      OrderStatus.SERVED,
      waiter,
    );
    expect(served.status).toBe(OrderStatus.SERVED);
    await first.orders.deleteOne({ _id: mixed._id });
    const all = await seed([OrderStatus.PENDING]);
    expect(await reject(all)).toMatchObject({
      status: OrderStatus.CANCELLED,
      totalAmount: 0,
      subtotalAmount: 0,
      discountAmount: 0,
    });
    expect(
      (await first.queries.listPaymentSummariesForWaiter())[0],
    ).toMatchObject({ canClear: true, isPaid: false });
    expect(await first.tables.findById(tableId)).toMatchObject({
      status: 'waiting_payment',
    });
    expect(
      await first.payments.getSessionPaymentSummary(
        String(sessionId),
        String(tableId),
      ),
    ).toMatchObject({ payableTotal: 0, canPay: false });
    // A cancelled round may retain Ready snapshots; it must not offer Serve.
    await seed(
      [REJECTED_ITEM_STATUS, OrderStatus.READY],
      OrderStatus.CANCELLED,
    );
    expect(
      (await first.queries.listForWaiter())
        .flatMap((order) => order.items)
        .every((item) => item.status === REJECTED_ITEM_STATUS),
    ).toBe(true);
  });

  it('concurrent Reject versus Preparing has one winner from the same version', async () => {
    const order = await seed();
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const model of [first.orders, second.orders]) {
      const find = model.findOne.bind(model);
      jest.spyOn(model, 'findOne').mockImplementationOnce(() => {
        const query = find({ _id: order._id });
        const exec = query.exec.bind(query);
        query.exec = async () => {
          const snapshot = await exec();
          if (++reads === 2) release();
          await barrier;
          return snapshot;
        };
        return query;
      });
    }
    const outcomes = await Promise.allSettled([
      reject(order),
      second.state.transitionItem(
        order.id,
        String(order.items[0]._id),
        OrderStatus.PREPARING,
        kitchen,
      ),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    const persisted = await first.orders.findById(order._id).orFail();
    expect(persisted.items[0].statusHistory).toHaveLength(1);
    expect(persisted.totalAmount).toBe(
      persisted.items[0].status === REJECTED_ITEM_STATUS ? 10000 : 20000,
    );
    expect(persisted.items[0].statusHistory[0].toStatus).toBe(
      persisted.items[0].status,
    );
  });

  it.each([PaymentIntentStatus.PENDING, PaymentIntentStatus.FAILED])(
    'blocks unresolved %s checkout for this session without altering payment history',
    async (status) => {
      const order = await seed();
      const intent = await first.intents.create({
        txnRef: 'old',
        coverageKey: 'old',
        sessionId,
        tableId,
        coveredOrderIds: [new Types.ObjectId()],
        amount: 12345,
        paymentUrl: 'https://example.test',
        expiresAt: new Date(),
        status,
        ipnConfirmed: false,
      });
      await expect(reject(order)).rejects.toBeInstanceOf(ConflictException);
      expect(
        (await first.orders.findById(order._id).orFail()).toObject(),
      ).toEqual(order.toObject());
      expect(
        (await first.intents.findById(intent._id).orFail()).toObject(),
      ).toEqual(intent.toObject());
    },
  );

  it.each(['VNPAY', 'CASH'])(
    '%s settles only remaining charge and invoice retains rejected item at zero',
    async (method) => {
      const order = await seed();
      await reject(order);
      let invoiceCode: string;
      if (method === 'CASH') {
        await connections[0].model(CashShift.name).create({ staffId: waiter.id, staffName: 'Waiter', openingCash: 0 });
        const preview = await first.payments.getCashSettlementSummary(
          String(tableId),
        );
        expect(preview.payableTotal).toBe(10000);
        const receipt = await first.payments.settleCash(
          String(tableId),
          preview,
          waiter,
        );
        expect(receipt.amount).toBe(10000);
        invoiceCode = receipt.invoiceCode;
      } else {
        const checkout = await first.payments.createPaymentUrl(
          String(sessionId),
          String(tableId),
          '127.0.0.1',
        );
        expect(checkout.amount).toBe(10000);
        expect(
          new URL(checkout.paymentUrl).searchParams.get('vnp_Amount'),
        ).toBe('1000000');
        const params: Record<string, string> = {
          vnp_TxnRef: checkout.txnRef,
          vnp_Amount: '1000000',
          vnp_TmnCode: 'TESTCODE',
          vnp_ResponseCode: '00',
          vnp_TransactionStatus: '00',
          vnp_TransactionNo: '123456',
        };
        params.vnp_SecureHash = createHmac(
          'sha512',
          configValues.VNP_HASH_SECRET,
        )
          .update(
            Object.keys(params)
              .sort()
              .map((key) => `${key}=${encodeURIComponent(params[key])}`)
              .join('&'),
          )
          .digest('hex');
        expect((await first.payments.handleIpn(params)).RspCode).toBe('00');
        invoiceCode = (
          await first.intents.findOne({ txnRef: checkout.txnRef }).orFail()
        ).invoiceCode!;
      }
      expect((await first.orders.findById(order._id).orFail()).status).toBe(
        OrderStatus.PAID,
      );
      const invoice = await first.invoice.lookup(invoiceCode);
      expect(invoice).toMatchObject({
        totalAmount: 10000,
        subtotalAmount: 10000,
      });
      expect(invoice.orders[0].items[0]).toMatchObject({
        unitPrice: 10000,
        chargedAmount: 0,
        status: REJECTED_ITEM_STATUS,
        rejectionReason: 'Hết nguyên liệu',
      });
      const topDishes = await new AdminService(
        first.orders,
        first.tables,
        first.dishes,
        {} as never,
      ).getTopDishes();
      expect(topDishes).toHaveLength(1);
      expect(topDishes[0]).toMatchObject({ totalQuantity: 1, revenue: 10000 });
      await expect(reject(order)).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it.each([
    [PromotionType.PERCENTAGE, 15, 0, 1500],
    [PromotionType.PERCENTAGE, 12.345, 0, 1235],
    [PromotionType.FIXED_AMOUNT, 15000, 0, 10000],
    [PromotionType.PERCENTAGE, 15, 15000, 0],
  ])(
    'recalculates %s from accepted rule, respecting minimum/clamp and preserving usage',
    async (type, value, minOrderAmount, discount) => {
      const promotion = await first.promotions.create({
        code: 'REJECT',
        type,
        value,
        minOrderAmount,
        startDate: new Date(Date.now() - 10000),
        endDate: new Date(Date.now() + 100000),
        usageLimit: 10,
      });
      const applied = await first.promo.reserveForOrder('REJECT', 20000);
      const order = await seed();
      await first.orders.updateOne(
        { _id: order._id },
        {
          $set: {
            promotionCode: applied.code,
            promotionSnapshot: applied.snapshot,
            discountAmount: applied.discountAmount,
            totalAmount: applied.totalAmount,
          },
        },
      );
      await first.promotions.updateOne(
        { _id: promotion._id },
        { $set: { value: 1, isActive: false } },
      );
      expect(await reject(order)).toMatchObject({
        subtotalAmount: 10000,
        discountAmount: discount,
        totalAmount: 10000 - discount,
      });
      expect(
        (await first.promotions.findById(promotion._id).orFail()).usedCount,
      ).toBe(1);
    },
  );

  it('blocks legacy discounted orders without rule snapshot rather than guessing', async () => {
    const order = await seed();
    await first.orders.updateOne(
      { _id: order._id },
      {
        $set: {
          promotionCode: 'OLD',
          discountAmount: 1000,
          totalAmount: 19000,
        },
      },
    );
    await expect(reject(order)).rejects.toBeInstanceOf(ConflictException);
  });
});
