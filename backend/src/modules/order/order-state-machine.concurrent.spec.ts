import {
  testMongoUri,
  clearTestCollections,
} from '../../../test/support/test-database';
import { ForbiddenException } from '@nestjs/common';
import { Connection, createConnection, Types } from 'mongoose';
import { ActorType } from '../../common/enums/actor-type.enum';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { Session, SessionSchema } from '../session/session.schema';
import { Table, TableSchema } from '../table/table.schema';
import { Order, OrderSchema } from './order.schema';
import { OrderService } from './order.service';
import { OrderStateMachineService } from './order-state-machine.service';

// Database lifecycle is owned by the shared integration harness.

describe('Order state invariants (isolated MongoDB)', () => {
  const connections: Connection[] = [];
  let first: ReturnType<typeof instance>;
  let second: ReturnType<typeof instance>;
  const kitchen = {
    id: new Types.ObjectId().toString(),
    role: UserRole.KITCHEN,
  };
  const waiter = { id: new Types.ObjectId().toString(), role: UserRole.WAITER };
  const admin = { id: new Types.ObjectId().toString(), role: UserRole.ADMIN };
  const payment = { triggeredBy: 'vnpay_webhook' as const, amount: 10000 };

  function instance(connection: Connection) {
    const orders = connection.model(Order.name, OrderSchema);
    const tables = connection.model(Table.name, TableSchema);
    const sessions = connection.model(Session.name, SessionSchema);
    return {
      orders,
      state: new OrderStateMachineService(orders, tables),
      queries: new OrderService(
        orders,
        tables,
        {} as never,
        sessions,
        {} as never,
        {} as never,
        {} as never,
      ),
    };
  }

  beforeAll(async () => {
    const uri = testMongoUri();
    const connection = createConnection(uri);
    connections.push(connection);
    await connection.asPromise();
    const other = createConnection(uri);
    connections.push(other);
    await other.asPromise();
    first = instance(connection);
    second = instance(other);
    await Promise.all(
      connections.flatMap((conn) =>
        Object.values(conn.models).map((model) => model.init()),
      ),
    );
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await Promise.all(connections.map((connection) => connection.close()));
  }, 15000);

  beforeEach(async () => {
    jest.restoreAllMocks();
    await clearTestCollections(connections[0]);
  });

  function seed(status: OrderStatus, items: OrderStatus[]) {
    return first.orders.create({
      sessionId: new Types.ObjectId(),
      tableId: new Types.ObjectId(),
      status,
      items: items.map((itemStatus) => ({
        dishId: new Types.ObjectId(),
        dishName: 'Rice',
        unitPrice: 10000,
        quantity: 1,
        status: itemStatus,
      })),
    });
  }

  // Force both independent instances to read the same version before either
  // can write. Subsequent reads run normally, exercising the real CAS retry.
  function synchronizeFirstReads() {
    let readCount = 0;
    let release!: () => void;
    const barrier = new Promise<void>((done) => {
      release = done;
    });
    for (const model of [first.orders, second.orders]) {
      const find = model.findOne.bind(model);
      jest.spyOn(model, 'findOne').mockImplementationOnce((...args: any[]) => {
        const query = (find as any)(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          const snapshot = await exec();
          if (++readCount === 2) release();
          await barrier;
          return snapshot;
        };
        return query;
      });
    }
  }

  test('Paid/Cancelled reject all staff item writes, cancellation and payment without history changes', async () => {
    for (const status of [OrderStatus.CANCELLED, OrderStatus.PAID]) {
      const order = await seed(status, [
        OrderStatus.PENDING,
        OrderStatus.READY,
      ]);
      const before = order.toObject();
      for (const actor of [kitchen, waiter, admin]) {
        await expect(
          first.state.transitionItem(
            order.id,
            order.items[0]._id.toString(),
            OrderStatus.PREPARING,
            actor,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          first.state.transitionItem(
            order.id,
            order.items[1]._id.toString(),
            OrderStatus.SERVED,
            actor,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      await expect(
        first.state.cancelCustomer(order.id, order.sessionId.toString()),
      ).rejects.toThrow();
      await expect(
        first.state.cancelByAdmin(order.id, admin),
      ).rejects.toThrow();
      await expect(
        first.state.transition(order.id, OrderStatus.PAID, payment),
      ).rejects.toThrow();
      expect((await first.orders.findById(order.id))!.toObject()).toEqual(
        before,
      );
    }
    const inconsistent = await seed(OrderStatus.SERVED, [OrderStatus.READY]);
    await expect(
      first.state.transition(inconsistent.id, OrderStatus.PAID, payment),
    ).rejects.toThrow();
    expect(
      (await first.orders.findById(inconsistent.id))!.statusHistory,
    ).toHaveLength(0);
  });

  test('active kitchen/waiter queries exclude cancelled, paid and already served orders', async () => {
    const expected: string[] = [];
    for (const status of Object.values(OrderStatus)) {
      const order = await seed(status, [
        OrderStatus.PENDING,
        OrderStatus.PREPARING,
        OrderStatus.READY,
      ]);
      if (
        [
          OrderStatus.PENDING,
          OrderStatus.PREPARING,
          OrderStatus.READY,
        ].includes(status)
      )
        expected.push(order.id);
    }
    const kitchenOrders = await first.queries.listForKitchen();
    const waiterOrders = await first.queries.listForWaiter();
    expect(kitchenOrders.map((order) => order.orderId).sort()).toEqual(
      expected.sort(),
    );
    expect(waiterOrders.map((order) => order.orderId).sort()).toEqual(
      expected.sort(),
    );
    expect(kitchenOrders.every((order) => order.items.length === 2)).toBe(true);
    expect(waiterOrders.every((order) => order.items.length === 1)).toBe(true);
  });

  test('roles including admin obey forward edges; accepted transitions preserve audit contract', async () => {
    const invalid: [OrderStatus, OrderStatus, typeof admin][] = [
      [OrderStatus.PENDING, OrderStatus.READY, admin],
      [OrderStatus.PENDING, OrderStatus.SERVED, admin],
      [OrderStatus.PENDING, OrderStatus.CANCELLED, admin],
      [OrderStatus.PENDING, OrderStatus.PAID, admin],
      [OrderStatus.PREPARING, OrderStatus.PREPARING, admin],
      [OrderStatus.READY, OrderStatus.PENDING, admin],
      [OrderStatus.SERVED, OrderStatus.CANCELLED, admin],
      [OrderStatus.PENDING, OrderStatus.PREPARING, waiter],
      [OrderStatus.READY, OrderStatus.SERVED, kitchen],
    ];
    for (const [from, to, actor] of invalid) {
      const order = await seed(OrderStatus.PENDING, [from]);
      await expect(
        first.state.transitionItem(
          order.id,
          order.items[0]._id.toString(),
          to,
          actor,
        ),
      ).rejects.toThrow();
      expect((await first.orders.findById(order.id))!.toObject()).toEqual(
        order.toObject(),
      );
    }
    const order = await seed(OrderStatus.PENDING, [OrderStatus.PENDING]);
    for (const sessionId of [undefined, '', new Types.ObjectId().toString()]) {
      await expect(
        first.state.cancelCustomer(order.id, sessionId as string),
      ).rejects.toThrow();
    }
    const startedAt = Date.now();
    const edges: [OrderStatus, OrderStatus, typeof admin][] = [
      [OrderStatus.PENDING, OrderStatus.PREPARING, kitchen],
      [OrderStatus.PREPARING, OrderStatus.READY, admin],
      [OrderStatus.READY, OrderStatus.SERVED, waiter],
    ];
    for (const [, to, actor] of edges) {
      await first.state.transitionItem(
        order.id,
        order.items[0]._id.toString(),
        to,
        actor,
      );
    }
    const served = (await first.orders.findById(order.id))!;
    expect(served.status).toBe(OrderStatus.SERVED);
    expect(served.items[0].statusHistory).toHaveLength(3);
    edges.forEach(([fromStatus, toStatus, actor], index) => {
      const entry = served.items[0].statusHistory[index];
      expect(entry).toMatchObject({
        fromStatus,
        toStatus,
        changedBy: {
          actorType: ActorType.USER,
          userId: new Types.ObjectId(actor.id),
          role: actor.role,
        },
      });
      expect(entry.changedAt.getTime()).toBeGreaterThanOrEqual(startedAt);
      expect(entry.changedAt.getTime()).toBeLessThanOrEqual(Date.now());
    });
    expect(served.statusHistory).toHaveLength(1);
    expect(served.statusHistory[0]).toMatchObject({
      fromStatus: OrderStatus.PENDING,
      toStatus: OrderStatus.SERVED,
      changedAt: served.items[0].statusHistory[2].changedAt,
      changedBy: { role: UserRole.WAITER },
    });
    await expect(first.state.cancelByAdmin(order.id, waiter)).rejects.toThrow(
      ForbiddenException,
    );
    const cancelled = await first.state.cancelByAdmin(order.id, admin);
    expect(cancelled.statusHistory[1]).toMatchObject({
      fromStatus: OrderStatus.SERVED,
      toStatus: OrderStatus.CANCELLED,
      changedBy: {
        actorType: ActorType.USER,
        userId: new Types.ObjectId(admin.id),
        role: UserRole.ADMIN,
      },
    });
  });

  test('concurrent final items, duplicate requests and customer cancellation serialize without lost state/history', async () => {
    const order = await seed(OrderStatus.PENDING, [
      OrderStatus.READY,
      OrderStatus.READY,
    ]);
    const firstWrites = jest.spyOn(first.orders, 'findOneAndUpdate');
    const secondWrites = jest.spyOn(second.orders, 'findOneAndUpdate');
    synchronizeFirstReads();
    await Promise.all([
      first.state.transitionItem(
        order.id,
        order.items[0]._id.toString(),
        OrderStatus.SERVED,
        waiter,
      ),
      second.state.transitionItem(
        order.id,
        order.items[1]._id.toString(),
        OrderStatus.SERVED,
        admin,
      ),
    ]);
    expect(firstWrites.mock.calls.length + secondWrites.mock.calls.length).toBe(
      3,
    );
    const served = (await first.orders.findById(order.id))!;
    expect(served.status).toBe(OrderStatus.SERVED);
    expect(served.__v).toBe(2);
    for (const [index, actor] of [waiter, admin].entries()) {
      expect(served.items[index].status).toBe(OrderStatus.SERVED);
      expect(served.items[index].statusHistory).toHaveLength(1);
      expect(served.items[index].statusHistory[0]).toMatchObject({
        fromStatus: OrderStatus.READY,
        toStatus: OrderStatus.SERVED,
        changedBy: {
          actorType: ActorType.USER,
          userId: new Types.ObjectId(actor.id),
          role: actor.role,
        },
      });
    }
    expect(served.statusHistory).toHaveLength(1);
    const finalItemHistory = served.items.find((item) =>
      item.statusHistory[0].changedBy.userId!.equals(
        served.statusHistory[0].changedBy.userId!,
      ),
    )!.statusHistory[0];
    expect(served.statusHistory[0]).toMatchObject({
      fromStatus: OrderStatus.PENDING,
      toStatus: OrderStatus.SERVED,
      changedAt: finalItemHistory.changedAt,
      changedBy: {
        actorType: ActorType.USER,
        userId: finalItemHistory.changedBy.userId,
        role: finalItemHistory.changedBy.role,
      },
    });

    const duplicate = await seed(OrderStatus.PENDING, [OrderStatus.READY]);
    synchronizeFirstReads();
    const duplicateResults = await Promise.allSettled(
      [first, second].map((instance) =>
        instance.state.transitionItem(
          duplicate.id,
          duplicate.items[0]._id.toString(),
          OrderStatus.SERVED,
          waiter,
        ),
      ),
    );
    expect(
      duplicateResults.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const single = (await first.orders.findById(duplicate.id))!;
    expect(single.__v).toBe(1);
    expect(single.items[0].statusHistory).toHaveLength(1);
    expect(single.statusHistory).toHaveLength(1);

    const pending = await seed(OrderStatus.PENDING, [OrderStatus.PENDING]);
    synchronizeFirstReads();
    const cancelResults = await Promise.allSettled([
      first.state.cancelCustomer(pending.id, pending.sessionId.toString()),
      second.state.transitionItem(
        pending.id,
        pending.items[0]._id.toString(),
        OrderStatus.PREPARING,
        kitchen,
      ),
    ]);
    expect(
      cancelResults.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const current = (await first.orders.findById(pending.id))!;
    expect(current.__v).toBe(1);
    if (current.status === OrderStatus.CANCELLED) {
      expect(current.items[0].status).toBe(OrderStatus.PENDING);
      expect(current.items[0].statusHistory).toHaveLength(0);
      expect(current.statusHistory).toHaveLength(1);
      expect(current.statusHistory[0]).toMatchObject({
        fromStatus: OrderStatus.PENDING,
        toStatus: OrderStatus.CANCELLED,
        changedBy: {
          actorType: ActorType.CUSTOMER,
          sessionId: pending.sessionId,
        },
      });
    } else {
      expect(current.status).toBe(OrderStatus.PENDING);
      expect(current.items[0].status).toBe(OrderStatus.PREPARING);
      expect(current.items[0].statusHistory).toHaveLength(1);
      expect(current.statusHistory).toHaveLength(0);
    }

    // Payment wins after admin read: the stale cancellation must never undo Paid.
    const payable = await seed(OrderStatus.SERVED, [OrderStatus.SERVED]);
    jest.restoreAllMocks();
    const find = first.orders.findOne.bind(first.orders);
    jest
      .spyOn(first.orders, 'findOne')
      .mockImplementationOnce((...args: any[]) => {
        const query = (find as any)(...args);
        const exec = query.exec.bind(query);
        query.exec = async () => {
          const snapshot = await exec();
          await second.state.transition(payable.id, OrderStatus.PAID, payment);
          return snapshot;
        };
        return query;
      });
    await expect(first.state.cancelByAdmin(payable.id, admin)).rejects.toThrow(
      ForbiddenException,
    );
    const paid = (await first.orders.findById(payable.id))!;
    expect(paid.status).toBe(OrderStatus.PAID);
    expect(paid.statusHistory).toHaveLength(1);
    expect(paid.statusHistory[0]).toMatchObject({
      fromStatus: OrderStatus.SERVED,
      toStatus: OrderStatus.PAID,
      changedBy: { actorType: ActorType.SYSTEM },
      source: payment.triggeredBy,
    });
  });
});
