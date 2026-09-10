import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { OrderService } from './order.service';
import { OrderStateMachineService } from './order-state-machine.service';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';

/** Integration-style tests using lightweight in-memory mocks for models/services. */

describe('Order integration flows', () => {
  let orderService: OrderService;
  let stateMachine: OrderStateMachineService;

  // In-memory stores
  const tables: any[] = [];
  const dishes: any[] = [];
  const orders: any[] = [];

  // Mock models
  const tableModel = {
    findById: jest.fn((id: string) => ({
      exec: jest
        .fn()
        .mockResolvedValue(tables.find((t) => t._id.toString() === id)),
    })),
    find: jest.fn((query: any) => ({
      select: jest.fn(() => ({
        exec: jest
          .fn()
          .mockResolvedValue(
            tables.filter((table) =>
              query._id.$in.includes(table._id.toString()),
            ),
          ),
      })),
    })),
    updateMany: jest.fn(() => ({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    })),
  } as any;
  const sessionModel = {
    find: jest.fn(() => ({
      select: jest.fn(() => ({ exec: jest.fn().mockResolvedValue([]) })),
    })),
  } as any;
  const dishModel = {
    find: jest.fn((query: any) => ({
      exec: jest
        .fn()
        .mockResolvedValue(
          dishes.filter(
            (d) => query._id.$in.includes(d._id.toString()) && d.isAvailable,
          ),
        ),
    })),
  } as any;

  // Order model mock as constructor with save
  class MockOrderModel {
    constructor(public payload: any) {
      Object.assign(this, payload);
    }
    async save() {
      if (!this._id) this._id = new Types.ObjectId();
      // ensure each item has _id (do not override if already set)
      this.items = this.items.map((it: any) => ({
        ...it,
        _id: it._id ? it._id : new Types.ObjectId(),
      }));
      orders.push(this);
      return this;
    }
    get id() {
      return this._id?.toString();
    }
    static find(query: any) {
      const exec = async () =>
        orders.filter((o) => {
          const itemStatus = query['items.status'];
          if (itemStatus?.$in)
            return o.items.some((it: any) =>
              itemStatus.$in.includes(it.status),
            );
          if (itemStatus)
            return o.items.some((it: any) => it.status === itemStatus);
          return true;
        });
      return { exec, sort: () => ({ exec }) };
    }
    static findById(id: string) {
      return { exec: async () => orders.find((o) => o._id.toString() === id) };
    }
    static findOne(query: any) {
      const exec = async () =>
        orders.find(
          (o) =>
            o._id.toString() === query._id.toString() &&
            o.sessionId.toString() === query.sessionId.toString(),
        );
      return { exec, select: () => ({ exec }) };
    }
  }

  // SessionService mock
  const sessionService = {
    consumeCartForOrder: jest.fn(async (tableId: any) => {
      // find active session by tableId
      return {
        _id: new Types.ObjectId(),
        tableId: tables[0]._id,
        cart: [{ dishId: dishes[0]._id.toString(), quantity: 2, note: '' }],
      };
    }),
    getCart: jest.fn(),
  } as any;
  const promotionService = {
    reserveForOrder: jest.fn(
      async (_code: string | undefined, subtotalAmount: number) => ({
        discountAmount: 0,
        totalAmount: subtotalAmount,
      }),
    ),
    releaseReservation: jest.fn(),
  } as any;

  beforeEach(() => {
    // reset stores
    tables.length = 0;
    dishes.length = 0;
    orders.length = 0;
    // seed table and dish
    const seededTableId = new Types.ObjectId();
    tables.push({
      _id: seededTableId,
      id: seededTableId.toString(),
      tableCode: 'A01',
    });
    dishes.push({
      _id: new Types.ObjectId(),
      name: 'Test Dish',
      price: 10000,
      isAvailable: true,
    });

    // instantiate services with mocks
    // @ts-ignore
    orderService = new OrderService(
      MockOrderModel as any,
      tableModel,
      dishModel,
      sessionModel,
      sessionService,
      promotionService,
    );
    // @ts-ignore
    stateMachine = new OrderStateMachineService(
      Object.assign(MockOrderModel, {
        exists: jest.fn(async () => null),
      }) as any,
      tableModel,
    );
  });

  test('snapshots every cart line including English name, image, price, quantity and optional note', async () => {
    Object.assign(dishes[0], {
      name: 'Cơm chiên bò',
      nameEn: ' Beef fried rice ',
      imageUrl: ' /uploads/rice.jpg ',
      price: 50_000,
    });
    sessionService.consumeCartForOrder.mockResolvedValueOnce({
      _id: new Types.ObjectId(),
      cart: [
        { dishId: dishes[0]._id, quantity: 2, note: ' Không hành ' },
        { dishId: dishes[0]._id, quantity: 1 },
      ],
    });
    await orderService.createCustomerOrder({ tableId: tables[0].id });
    // A later catalog edit must never rewrite the placed order.
    Object.assign(dishes[0], {
      name: 'Tên mới',
      nameEn: 'New name',
      imageUrl: '/new.jpg',
      price: 99_000,
    });
    expect(orders[0].items).toHaveLength(2);
    expect(orders[0].items[0]).toMatchObject({
      dishName: 'Cơm chiên bò',
      nameEn: 'Beef fried rice',
      imageUrl: '/uploads/rice.jpg',
      unitPrice: 50_000,
      quantity: 2,
      note: 'Không hành',
      status: OrderStatus.PENDING,
    });
    expect(orders[0].items[1]).toMatchObject({
      quantity: 1,
      unitPrice: 50_000,
    });
    expect(orders[0].items[1].note).toBeUndefined();
    expect(orders[0].totalAmount).toBe(150_000);
  });

  test('creates an order from a legacy dish without English name or image', async () => {
    await orderService.createCustomerOrder({ tableId: tables[0].id });
    expect(orders[0].items[0]).toMatchObject({
      dishName: 'Test Dish',
      unitPrice: 10_000,
      quantity: 2,
    });
    expect(orders[0].items[0].nameEn).toBeUndefined();
    expect(orders[0].items[0].imageUrl).toBeUndefined();
  });

  test('Happy path: place order -> kitchen transitions -> waiter serves, statusHistory recorded', async () => {
    const createRes = await orderService.createCustomerOrder({
      tableId: tables[0]._id.toString(),
    });
    expect(createRes.status).toBe(OrderStatus.PENDING);
    // find created order
    const created = orders[0];
    expect(created).toBeDefined();
    const itemId = created.items[0]._id.toString();
    // Kitchen: Pending -> Preparing
    await stateMachine.transitionItem(
      created._id.toString(),
      itemId,
      OrderStatus.PREPARING,
      { id: new Types.ObjectId().toString(), role: UserRole.KITCHEN },
    );
    expect(created.items[0].status).toBe(OrderStatus.PREPARING);
    expect(created.items[0].statusHistory.length).toBeGreaterThan(1);

    // Kitchen: Preparing -> Ready
    await stateMachine.transitionItem(
      created._id.toString(),
      itemId,
      OrderStatus.READY,
      { id: new Types.ObjectId().toString(), role: UserRole.KITCHEN },
    );
    expect(created.items[0].status).toBe(OrderStatus.READY);

    // Waiter: Ready -> Served
    await stateMachine.transitionItem(
      created._id.toString(),
      itemId,
      OrderStatus.SERVED,
      { id: new Types.ObjectId().toString(), role: UserRole.WAITER },
    );
    expect(created.items[0].status).toBe(OrderStatus.SERVED);
    expect(created.status).toBe(OrderStatus.SERVED);

    // Verify statusHistory actors include CUSTOMER initial entry and USER entries for staff
    const actors = created.items[0].statusHistory.map(
      (h: any) => h.changedBy?.actorType,
    );
    expect(actors[0]).toBeDefined();
  });

  test('Negative flows: waiter cannot set Preparing; kitchen cannot jump Pending->Ready; customer cannot cancel after preparing', async () => {
    const createRes = await orderService.createCustomerOrder({
      tableId: tables[0]._id.toString(),
    });
    const created = orders[0];
    const itemId = created.items[0]._id.toString();

    // Waiter trying to set Preparing
    await expect(
      stateMachine.transitionItem(
        created._id.toString(),
        itemId,
        OrderStatus.PREPARING,
        { id: new Types.ObjectId().toString(), role: UserRole.WAITER },
      ),
    ).rejects.toThrow(ForbiddenException);

    // Kitchen trying to jump Pending -> Ready
    await expect(
      stateMachine.transitionItem(
        created._id.toString(),
        itemId,
        OrderStatus.READY,
        { id: new Types.ObjectId().toString(), role: UserRole.KITCHEN },
      ),
    ).rejects.toThrow(ForbiddenException);

    // Now set to Preparing by kitchen then ensure customer cancel blocked
    await stateMachine.transitionItem(
      created._id.toString(),
      itemId,
      OrderStatus.PREPARING,
      { id: new Types.ObjectId().toString(), role: UserRole.KITCHEN },
    );
    await expect(
      stateMachine.cancelCustomer(
        created._id.toString(),
        created.sessionId.toString
          ? created.sessionId.toString()
          : created.sessionId,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  test('snapshots separate notes for the same dish and exposes them to Kitchen', async () => {
    const ownerSessionId = new Types.ObjectId();
    sessionService.consumeCartForOrder.mockResolvedValueOnce({
      _id: ownerSessionId,
      id: ownerSessionId.toString(),
      tableId: tables[0]._id,
      cart: [
        { dishId: dishes[0]._id.toString(), quantity: 2, note: '  Không đá  ' },
        { dishId: dishes[0]._id.toString(), quantity: 1, note: 'Nhiều đá' },
      ],
    });

    await orderService.createCustomerOrder({
      tableId: tables[0]._id.toString(),
    });

    expect(orders[0].items).toEqual([
      expect.objectContaining({ quantity: 2, note: 'Không đá' }),
      expect.objectContaining({ quantity: 1, note: 'Nhiều đá' }),
    ]);
    await expect(orderService.listForKitchen()).resolves.toEqual([
      expect.objectContaining({
        items: [
          expect.objectContaining({ quantity: 2, note: 'Không đá' }),
          expect.objectContaining({ quantity: 1, note: 'Nhiều đá' }),
        ],
      }),
    ]);
  });

  test('uses the current merged Session label while preserving the Order source tableId', async () => {
    await orderService.createCustomerOrder({
      tableId: tables[0]._id.toString(),
    });
    const sourceTableId = tables[0]._id;
    const secondTableId = new Types.ObjectId();
    tables.push({
      _id: secondTableId,
      id: secondTableId.toString(),
      tableCode: 'A02',
    });
    sessionModel.find.mockReturnValueOnce({
      select: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue([
          {
            id: orders[0].sessionId.toString(),
            tableId: sourceTableId,
            tableIds: [sourceTableId, secondTableId],
          },
        ]),
      })),
    });

    const [kitchenOrder] = await orderService.listForKitchen();

    expect(kitchenOrder.tableId).toBe(sourceTableId.toString());
    expect(kitchenOrder.tableCode).toBe('A01');
    expect(kitchenOrder.tableDisplayName).toBe('A01 + A02');
  });

  test('payment status is readable only by the owning active session', async () => {
    await orderService.createCustomerOrder({
      tableId: tables[0]._id.toString(),
    });
    const created = orders[0];
    const ownerSessionId = created.sessionId.toString();
    const findOneSpy = jest.spyOn(MockOrderModel, 'findOne');
    await expect(
      orderService.getPaymentStatus(created._id.toString(), ownerSessionId),
    ).resolves.toMatchObject({
      orderId: created._id.toString(),
      status: OrderStatus.PENDING,
    });
    expect(findOneSpy).toHaveBeenCalledWith({
      _id: new Types.ObjectId(created._id.toString()),
      sessionId: new Types.ObjectId(ownerSessionId),
    });
    await expect(
      orderService.getPaymentStatus(
        created._id.toString(),
        new Types.ObjectId().toString(),
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
