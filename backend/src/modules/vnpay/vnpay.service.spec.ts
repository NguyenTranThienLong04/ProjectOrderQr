import { Types } from 'mongoose';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { SessionStatus } from '../../common/enums/session-status.enum';
import {
  PaymentIntentStatus,
  type PaymentIntentDocument,
} from './payment-intent.schema';
import { VnpayService } from './vnpay.service';

function query<T>(value: T) {
  const chain = {
    exec: jest.fn().mockResolvedValue(value),
    sort: jest.fn(),
    select: jest.fn(),
    session: jest.fn(),
  };
  chain.sort.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);
  chain.session.mockReturnValue(chain);
  return chain;
}

describe('VnpayService Session payment', () => {
  const sessionId = new Types.ObjectId();
  const tableId = new Types.ObjectId();
  const otherTableId = new Types.ObjectId();
  const configValues: Record<string, string> = {
    VNP_HASH_SECRET: 'test-secret',
    VNP_TMN_CODE: 'TESTCODE',
    VNP_RETURN_URL: 'http://localhost:3000/vnpay/return',
    VNP_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  };
  const config = { get: jest.fn((key: string) => configValues[key]) };
  let orders: any[];
  let intents: any[];
  let service: VnpayService;
  let stateMachine: { transitionManyToPaid: jest.Mock };
  let gateway: { emit: jest.Mock };
  let orderModel: Record<string, jest.Mock>;
  let tableModel: Record<string, jest.Mock>;
  let paymentIntentModel: any;

  const makeOrder = (
    totalAmount: number,
    status = OrderStatus.SERVED,
    options: { subtotal?: number; discount?: number; quantity?: number } = {},
  ) => {
    const _id = new Types.ObjectId();
    return {
      _id,
      id: _id.toString(),
      sessionId,
      tableId,
      status,
      subtotalAmount: options.subtotal ?? totalAmount,
      discountAmount: options.discount ?? 0,
      totalAmount,
      items: [
        {
          status:
            status === OrderStatus.SERVED || status === OrderStatus.PAID
              ? OrderStatus.SERVED
              : status,
          unitPrice: options.subtotal ?? totalAmount,
          quantity: options.quantity ?? 1,
          dishName: 'Món snapshot',
        },
      ],
      createdAt: new Date(),
    };
  };

  const signed = (intent: any, overrides: Record<string, string> = {}) => {
    const params: Record<string, string> = {
      vnp_TxnRef: intent.txnRef,
      vnp_Amount: String(intent.amount * 100),
      vnp_ResponseCode: '00',
      vnp_TransactionNo: '123456',
      ...overrides,
    };
    params.vnp_SecureHash = (
      service as unknown as {
        sign: (values: Record<string, string>) => string;
      }
    ).sign(params);
    return params;
  };

  beforeEach(() => {
    orders = [];
    intents = [];
    const session = {
      _id: sessionId,
      id: sessionId.toString(),
      tableId,
      tableIds: [tableId],
      status: SessionStatus.ACTIVE,
    };
    const table = {
      _id: tableId,
      id: tableId.toString(),
      tableCode: 'A01',
      currentSessionId: sessionId,
    };
    orderModel = {
      find: jest.fn((filter: Record<string, any>) => {
        let result = orders.filter(
          (order) => order.sessionId.toString() === filter.sessionId.toString(),
        );
        const includedIds = filter._id?.$in as Types.ObjectId[] | undefined;
        if (includedIds) {
          const allowed = new Set(includedIds.map((id) => id.toString()));
          result = result.filter((order) => allowed.has(order.id));
        }
        return query(result);
      }),
    };
    const sessionModel = {
      findOne: jest.fn((filter: Record<string, any>) =>
        query(
          filter._id.toString() === sessionId.toString() &&
            filter.$or.some((entry: Record<string, Types.ObjectId>) =>
              Object.values(entry).some(
                (id) => id.toString() === tableId.toString(),
              ),
            )
            ? session
            : null,
        ),
      ),
      findById: jest.fn(() => query(session)),
    };
    tableModel = {
      findOne: jest.fn((filter: Record<string, Types.ObjectId>) =>
        query(
          filter._id.toString() === tableId.toString() &&
            filter.currentSessionId.toString() === sessionId.toString()
            ? table
            : null,
        ),
      ),
    };

    paymentIntentModel = function PaymentIntentModel(
      data: Record<string, any>,
    ) {
      Object.assign(this, data, {
        _id: new Types.ObjectId(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      this.save = jest.fn(async () => {
        intents.push(this);
        return this;
      });
    };
    paymentIntentModel.findOne = jest.fn((filter: Record<string, any>) => {
      const found = intents.find((intent) => {
        if (filter.txnRef && intent.txnRef !== filter.txnRef) return false;
        if (filter._id && intent._id.toString() !== filter._id.toString())
          return false;
        if (
          filter.sessionId &&
          intent.sessionId.toString() !== filter.sessionId.toString()
        )
          return false;
        if (
          filter.tableId &&
          intent.tableId.toString() !== filter.tableId.toString()
        )
          return false;
        if (filter.status && intent.status !== filter.status) return false;
        return true;
      });
      return query(found ?? null);
    });
    paymentIntentModel.findById = jest.fn((id: Types.ObjectId) =>
      query(
        intents.find((intent) => intent._id.toString() === id.toString()) ??
          null,
      ),
    );
    paymentIntentModel.updateOne = jest.fn(
      (filter: Record<string, any>, update: Record<string, any>) => {
        const found = intents.find(
          (intent) =>
            intent._id.toString() === filter._id.toString() &&
            intent.status === filter.status,
        );
        if (found) Object.assign(found, update.$set, { updatedAt: new Date() });
        return query({ modifiedCount: found ? 1 : 0 });
      },
    );
    paymentIntentModel.updateMany = jest.fn(() =>
      query({ matchedCount: 0, modifiedCount: 0 }),
    );
    paymentIntentModel.findOneAndUpdate = jest.fn(
      (filter: Record<string, any>, update: Record<string, any>) => {
        const found = intents.find(
          (intent) =>
            intent._id.toString() === filter._id.toString() &&
            intent.status === filter.status,
        );
        if (found) Object.assign(found, update.$set, { updatedAt: new Date() });
        return query(found ?? null);
      },
    );
    const connection = {
      transaction: jest.fn(async (work: (session: object) => Promise<void>) =>
        work({}),
      ),
    };
    stateMachine = {
      transitionManyToPaid: jest.fn(
        async (coveredOrderIds: Types.ObjectId[]) => {
          const covered = new Set(coveredOrderIds.map((id) => id.toString()));
          const paid = orders.filter((order) => covered.has(order.id));
          paid.forEach((order) => {
            order.status = OrderStatus.PAID;
          });
          return paid;
        },
      ),
    };
    gateway = { emit: jest.fn() };
    service = new VnpayService(
      config as never,
      orderModel as never,
      sessionModel as never,
      tableModel as never,
      paymentIntentModel as never,
      connection as never,
      stateMachine as never,
      gateway as never,
      { renderSession: jest.fn() } as never,
    );
  });

  it('returns all snapshot lines without changing discounted Session billing', async () => {
    const order = makeOrder(110_000, OrderStatus.SERVED, {
      subtotal: 120_000,
      discount: 10_000,
    });
    order.items = [
      {
        dishName: 'Cơm chiên bò',
        nameEn: 'Beef fried rice',
        imageUrl: '/rice.jpg',
        unitPrice: 50_000,
        quantity: 2,
        note: 'Không hành',
        status: OrderStatus.SERVED,
      },
      {
        dishName: 'Trà đá',
        unitPrice: 20_000,
        quantity: 1,
        status: OrderStatus.SERVED,
      },
    ] as typeof order.items;
    orders.push(order);
    const summary = await service.getSessionPaymentSummary(
      sessionId.toString(),
      tableId.toString(),
    );
    expect(summary).toMatchObject({
      orderCount: 1,
      itemCount: 3,
      subtotalAmount: 120_000,
      discountAmount: 10_000,
      payableTotal: 110_000,
      canPay: true,
      fullyPaid: false,
    });
    expect(summary.orders[0]).toMatchObject({
      orderId: order.id,
      orderNumber: 1,
      status: OrderStatus.SERVED,
      items: [
        {
          dishName: 'Cơm chiên bò',
          nameEn: 'Beef fried rice',
          imageUrl: '/rice.jpg',
          unitPrice: 50_000,
          quantity: 2,
          note: 'Không hành',
        },
        { dishName: 'Trà đá', unitPrice: 20_000, quantity: 1 },
      ],
    });
    expect(summary.orders[0].items[1].imageUrl).toBeUndefined();
    expect(summary.orders[0].items[1].nameEn).toBeUndefined();
    expect(summary.orders[0].items[1].note).toBeUndefined();
    expect(summary.payableOrders).toEqual(summary.orders);
    expect(orderModel.find).toHaveBeenCalledTimes(1);
    const payment = await service.createPaymentUrl(
      sessionId.toString(),
      tableId.toString(),
      '::1',
    );
    expect(payment.amount).toBe(110_000);
    expect(payment.coveredOrderIds).toEqual([order.id]);
  });

  it.each(Object.values(OrderStatus))(
    'preserves %s and the legacy single item in progress',
    async (status) => {
      orders.push(makeOrder(50_000, status));
      const summary = await service.getSessionPaymentSummary(
        sessionId.toString(),
        tableId.toString(),
      );
      expect(summary.orders[0].status).toBe(status);
      expect(summary.orders[0].items).toEqual([
        { dishName: 'Món snapshot', unitPrice: 50_000, quantity: 1 },
      ]);
      expect(summary.canPay).toBe(status === OrderStatus.SERVED);
      expect(summary.payableTotal).toBe(
        status === OrderStatus.PAID || status === OrderStatus.CANCELLED
          ? 0
          : 50_000,
      );
    },
  );

  it('uses the official signing representation and normalizes local IPv6', () => {
    const internals = service as unknown as {
      sortedData: (values: Record<string, string>) => string;
      normalizeClientIp: (ip: string) => string;
    };
    expect(
      internals.sortedData({ vnp_OrderInfo: 'Thanh toan phien 123' }),
    ).toBe('vnp_OrderInfo=Thanh+toan+phien+123');
    expect(internals.normalizeClientIp('::1')).toBe('127.0.0.1');
  });

  it('A — creates one Session payment for one Served Order', async () => {
    const order = makeOrder(100_000);
    orders.push(order);
    const result = await service.createPaymentUrl(
      sessionId.toString(),
      tableId.toString(),
      '::1',
    );
    expect(new URL(result.paymentUrl).searchParams.get('vnp_Amount')).toBe(
      '10000000',
    );
    expect(result.coveredOrderIds).toEqual([order.id]);
    expect(intents).toHaveLength(1);
  });

  it('B/E — snapshots multiple Served Orders and sums discounted totalAmount only', async () => {
    const first = makeOrder(100_000);
    const second = makeOrder(200_000, OrderStatus.SERVED, {
      subtotal: 250_000,
      discount: 50_000,
    });
    const third = makeOrder(50_000);
    orders.push(first, second, third);
    const result = await service.createPaymentUrl(
      sessionId.toString(),
      tableId.toString(),
      '127.0.0.1',
    );
    expect(result.amount).toBe(350_000);
    expect(new URL(result.paymentUrl).searchParams.get('vnp_Amount')).toBe(
      '35000000',
    );
    expect(result.coveredOrderIds).toEqual([first.id, second.id, third.id]);
  });

  it('C — blocks the entire Session while one unpaid Order is not Served', async () => {
    orders.push(makeOrder(100_000), makeOrder(50_000, OrderStatus.READY));
    const summary = await service.getSessionPaymentSummary(
      sessionId.toString(),
      tableId.toString(),
    );
    expect(summary.canPay).toBe(false);
    await expect(
      service.createPaymentUrl(
        sessionId.toString(),
        tableId.toString(),
        '127.0.0.1',
      ),
    ).rejects.toThrow('toàn bộ món chưa thanh toán');
    expect(intents).toHaveLength(0);
  });

  it('D — excludes legacy Paid and Cancelled Orders from amount and coverage', async () => {
    const paid = makeOrder(90_000, OrderStatus.PAID);
    const cancelled = makeOrder(70_000, OrderStatus.CANCELLED);
    const servedB = makeOrder(110_000);
    const servedC = makeOrder(120_000);
    orders.push(paid, cancelled, servedB, servedC);
    const result = await service.createPaymentUrl(
      sessionId.toString(),
      tableId.toString(),
      '127.0.0.1',
    );
    expect(result.amount).toBe(230_000);
    expect(result.coveredOrderIds).toEqual([servedB.id, servedC.id]);
  });

  it('F — cancel/fail keeps Orders Served and allows a fresh retry intent', async () => {
    const order = makeOrder(100_000);
    orders.push(order);
    const first = await service.createPaymentUrl(
      sessionId.toString(),
      tableId.toString(),
      '127.0.0.1',
    );
    const firstIntent = intents[0];
    await expect(
      service.handleIpn(signed(firstIntent, { vnp_ResponseCode: '24' })),
    ).resolves.toEqual({ RspCode: '00', Message: 'Confirm Success' });
    expect(order.status).toBe(OrderStatus.SERVED);
    expect(firstIntent.status).toBe(PaymentIntentStatus.FAILED);
    expect(stateMachine.transitionManyToPaid).not.toHaveBeenCalled();

    const retry = await service.createPaymentUrl(
      sessionId.toString(),
      tableId.toString(),
      '127.0.0.1',
    );
    expect(retry.txnRef).not.toBe(first.txnRef);
    expect(intents).toHaveLength(2);
  });

  it('collapses repeated checkout clicks onto one unexpired pending intent', async () => {
    orders.push(makeOrder(100_000), makeOrder(250_000));
    const first = await service.createPaymentUrl(
      sessionId.toString(),
      tableId.toString(),
      '127.0.0.1',
    );
    const second = await service.createPaymentUrl(
      sessionId.toString(),
      tableId.toString(),
      '127.0.0.1',
    );
    expect(second).toEqual(first);
    expect(intents).toHaveLength(1);
  });

  it('G/I — duplicate IPN transitions and emits realtime side effects only once', async () => {
    orders.push(makeOrder(100_000), makeOrder(250_000));
    await service.createPaymentUrl(
      sessionId.toString(),
      tableId.toString(),
      '127.0.0.1',
    );
    const intent = intents[0];
    const callback = signed(intent);
    await expect(service.handleIpn(callback)).resolves.toEqual({
      RspCode: '00',
      Message: 'Confirm Success',
    });
    const emittedAfterFirst = gateway.emit.mock.calls.length;
    await expect(service.handleIpn(callback)).resolves.toEqual({
      RspCode: '02',
      Message: 'Order already confirmed',
    });
    expect(stateMachine.transitionManyToPaid).toHaveBeenCalledTimes(1);
    expect(gateway.emit).toHaveBeenCalledWith(
      expect.arrayContaining([`session:${sessionId.toString()}`]),
      'session:payment-updated',
      expect.objectContaining({
        txnRef: intent.txnRef,
        coveredOrderIds: expect.any(Array),
        amount: 350_000,
      }),
    );
    expect(gateway.emit).toHaveBeenCalledTimes(emittedAfterFirst);
  });

  it('H — an Order created after URL generation is never included by the old IPN', async () => {
    const orderA = makeOrder(100_000);
    const orderB = makeOrder(250_000);
    orders.push(orderA, orderB);
    await service.createPaymentUrl(
      sessionId.toString(),
      tableId.toString(),
      '127.0.0.1',
    );
    const intent = intents[0];
    const orderC = makeOrder(50_000);
    orders.push(orderC);

    await service.handleIpn(signed(intent));
    const transitionedIds =
      stateMachine.transitionManyToPaid.mock.calls[0][0].map(
        (id: Types.ObjectId) => id.toString(),
      );
    expect(transitionedIds).toEqual([orderA.id, orderB.id]);
    expect(orderA.status).toBe(OrderStatus.PAID);
    expect(orderB.status).toBe(OrderStatus.PAID);
    expect(orderC.status).toBe(OrderStatus.SERVED);
  });

  it('J — rejects another table/session ownership context', async () => {
    orders.push(makeOrder(100_000));
    await expect(
      service.createPaymentUrl(
        sessionId.toString(),
        otherTableId.toString(),
        '127.0.0.1',
      ),
    ).rejects.toThrow('Không tìm thấy phiên ăn thuộc bàn này');
  });

  it('rejects forged signatures and amount mismatch before state transition', async () => {
    orders.push(makeOrder(100_000));
    await service.createPaymentUrl(
      sessionId.toString(),
      tableId.toString(),
      '127.0.0.1',
    );
    const intent = intents[0] as PaymentIntentDocument;
    await expect(
      service.handleIpn({
        vnp_TxnRef: intent.txnRef,
        vnp_SecureHash: '0'.repeat(128),
      }),
    ).resolves.toEqual({ RspCode: '97', Message: 'Invalid signature' });
    await expect(
      service.handleIpn(signed(intent, { vnp_Amount: '99900' })),
    ).resolves.toEqual({ RspCode: '04', Message: 'Invalid amount' });
    expect(stateMachine.transitionManyToPaid).not.toHaveBeenCalled();
  });
});
