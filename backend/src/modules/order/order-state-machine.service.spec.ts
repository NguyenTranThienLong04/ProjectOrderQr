import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { OrderStateMachineService } from './order-state-machine.service';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';

describe('OrderStateMachineService', () => {
  let service: OrderStateMachineService;
  let mockModel: any;

  beforeEach(() => {
    mockModel = {
      findById: jest.fn(),
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(null),
    };
    service = new OrderStateMachineService(mockModel, {
      updateMany: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      })),
    } as any);
  });

  test('Kitchen can transition Pending -> Preparing -> Ready', async () => {
    const itemId = 'item1';
    const order: any = {
      _id: 'o1',
      tableId: 't1',
      status: OrderStatus.PENDING,
      statusHistory: [],
      items: [{ _id: itemId, status: OrderStatus.PENDING, statusHistory: [] }],
      save: jest.fn().mockResolvedValue(true),
    };
    mockModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(order),
    });

    // Pending -> Preparing
    const res1 = await service.transitionItem(
      'o1',
      itemId,
      OrderStatus.PREPARING,
      { id: '507f1f77bcf86cd799439011', role: UserRole.KITCHEN },
    );
    expect(order.items[0].status).toBe(OrderStatus.PREPARING);
    expect(order.save).toHaveBeenCalled();

    // Preparing -> Ready
    const res2 = await service.transitionItem('o1', itemId, OrderStatus.READY, {
      id: '507f1f77bcf86cd799439011',
      role: UserRole.KITCHEN,
    });
    expect(order.items[0].status).toBe(OrderStatus.READY);
  });

  test('Waiter can transition Ready -> Served', async () => {
    const itemId = 'item2';
    const order: any = {
      _id: 'o2',
      tableId: 't1',
      status: OrderStatus.PENDING,
      statusHistory: [],
      items: [{ _id: itemId, status: OrderStatus.READY, statusHistory: [] }],
      save: jest.fn().mockResolvedValue(true),
    };
    mockModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(order),
    });

    const res = await service.transitionItem('o2', itemId, OrderStatus.SERVED, {
      id: '507f1f77bcf86cd799439011',
      role: UserRole.WAITER,
    });
    expect(order.items[0].status).toBe(OrderStatus.SERVED);
    expect(order.status).toBe(OrderStatus.SERVED);
  });

  test('keeps Order Pending when one of multiple items is still Ready', async () => {
    const servedItemId = 'served-item';
    const order: any = {
      _id: 'multi-order-pending',
      sessionId: new Types.ObjectId(),
      tableId: 't1',
      status: OrderStatus.PENDING,
      statusHistory: [],
      items: [
        { _id: servedItemId, status: OrderStatus.READY, statusHistory: [] },
        { _id: 'ready-item', status: OrderStatus.READY, statusHistory: [] },
      ],
      save: jest.fn().mockResolvedValue(true),
    };
    mockModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(order),
    });

    await service.transitionItem(order._id, servedItemId, OrderStatus.SERVED, {
      id: '507f1f77bcf86cd799439011',
      role: UserRole.WAITER,
    });

    expect(order.items.map((item: any) => item.status)).toEqual([
      OrderStatus.SERVED,
      OrderStatus.READY,
    ]);
    expect(order.status).toBe(OrderStatus.PENDING);
  });

  test('aggregates a multi-item Order to Served on the final Ready -> Served transition', async () => {
    const finalItemId = 'final-item';
    const order: any = {
      _id: 'multi-order-served',
      sessionId: new Types.ObjectId(),
      tableId: 't1',
      status: OrderStatus.PENDING,
      statusHistory: [],
      items: [
        {
          _id: 'already-served',
          status: OrderStatus.SERVED,
          statusHistory: [],
        },
        { _id: finalItemId, status: OrderStatus.READY, statusHistory: [] },
      ],
      save: jest.fn().mockResolvedValue(true),
    };
    mockModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(order),
    });

    await service.transitionItem(order._id, finalItemId, OrderStatus.SERVED, {
      id: '507f1f77bcf86cd799439011',
      role: UserRole.WAITER,
    });

    expect(
      order.items.every((item: any) => item.status === OrderStatus.SERVED),
    ).toBe(true);
    expect(order.status).toBe(OrderStatus.SERVED);
    expect(order.statusHistory).toEqual([
      expect.objectContaining({
        fromStatus: OrderStatus.PENDING,
        toStatus: OrderStatus.SERVED,
      }),
    ]);
  });

  test('Forbidden: Waiter cannot set Preparing', async () => {
    const itemId = 'item3';
    const order: any = {
      _id: 'o3',
      items: [{ _id: itemId, status: OrderStatus.PENDING, statusHistory: [] }],
      save: jest.fn(),
    };
    mockModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(order),
    });
    await expect(
      service.transitionItem('o3', itemId, OrderStatus.PREPARING, {
        id: '507f1f77bcf86cd799439011',
        role: UserRole.WAITER,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  test('Forbidden: Kitchen cannot jump Pending -> Ready', async () => {
    const itemId = 'item4';
    const order: any = {
      _id: 'o4',
      items: [{ _id: itemId, status: OrderStatus.PENDING, statusHistory: [] }],
      save: jest.fn(),
    };
    mockModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(order),
    });
    await expect(
      service.transitionItem('o4', itemId, OrderStatus.READY, {
        id: '507f1f77bcf86cd799439011',
        role: UserRole.KITCHEN,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  test('Customer can cancel when Pending via cancelCustomer', async () => {
    const order: any = {
      _id: 'o5',
      status: OrderStatus.PENDING,
      statusHistory: [],
      items: [],
      save: jest.fn().mockResolvedValue(true),
    };
    mockModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(order),
    });
    const res = await service.cancelCustomer('o5', '507f1f77bcf86cd799439011');
    expect(order.status).toBe(OrderStatus.CANCELLED);
  });

  test('Admin can cancel any order via cancelByAdmin', async () => {
    const order: any = {
      _id: 'o6',
      status: OrderStatus.READY,
      statusHistory: [],
      save: jest.fn().mockResolvedValue(true),
    };
    mockModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(order),
    });
    const res = await service.cancelByAdmin('o6', {
      id: '507f1f77bcf86cd799439011',
      role: UserRole.ADMIN,
    });
    expect(order.status).toBe(OrderStatus.CANCELLED);
  });

  test('cancelCustomer throws if order not pending', async () => {
    const order: any = { _id: 'o7', status: OrderStatus.READY };
    mockModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(order),
    });
    await expect(
      service.cancelCustomer('o7', '507f1f77bcf86cd799439011'),
    ).rejects.toThrow(ForbiddenException);
  });

  test('transitionItem throws NotFound when order or item missing', async () => {
    mockModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });
    await expect(
      service.transitionItem('no', 'no', OrderStatus.PREPARING, {
        id: '507f1f77bcf86cd799439011',
        role: UserRole.KITCHEN,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  test('atomically transitions every covered Served Order through the central state machine', async () => {
    const sessionId = new Types.ObjectId();
    const orderIds = [new Types.ObjectId(), new Types.ObjectId()];
    const covered = orderIds.map((id) => ({
      _id: id,
      id: id.toString(),
      sessionId,
      status: OrderStatus.SERVED,
      items: [{ status: OrderStatus.SERVED }],
    }));
    const findChain = () => {
      const chain: any = {
        session: jest.fn(),
        sort: jest.fn(),
        exec: jest.fn().mockResolvedValue(covered),
      };
      chain.session.mockReturnValue(chain);
      chain.sort.mockReturnValue(chain);
      return chain;
    };
    const updateChain: any = {
      session: jest.fn(),
      exec: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
    };
    updateChain.session.mockReturnValue(updateChain);
    const bulkModel = {
      find: jest.fn(() => findChain()),
      updateMany: jest.fn(() => updateChain),
    };
    const bulkService = new OrderStateMachineService(
      bulkModel as any,
      {} as any,
    );
    const result = await bulkService.transitionManyToPaid(
      orderIds,
      sessionId,
      {
        triggeredBy: 'vnpay_webhook',
        transactionNo: 'VNP123',
        amount: 350_000,
      },
      {} as any,
    );

    expect(result).toBe(covered);
    expect(bulkModel.updateMany).toHaveBeenCalledWith(
      {
        _id: { $in: orderIds },
        sessionId,
        status: OrderStatus.SERVED,
      },
      expect.objectContaining({
        $set: expect.objectContaining({ status: OrderStatus.PAID }),
        $push: {
          statusHistory: expect.objectContaining({
            fromStatus: OrderStatus.SERVED,
            toStatus: OrderStatus.PAID,
            transactionNo: 'VNP123',
          }),
        },
      }),
    );
  });

  test('refuses a covered snapshot containing a non-Served Order before any write', async () => {
    const sessionId = new Types.ObjectId();
    const orderIds = [new Types.ObjectId(), new Types.ObjectId()];
    const chain: any = {
      session: jest.fn(),
      exec: jest.fn().mockResolvedValue([
        {
          status: OrderStatus.SERVED,
          items: [{ status: OrderStatus.SERVED }],
        },
        {
          status: OrderStatus.READY,
          items: [{ status: OrderStatus.READY }],
        },
      ]),
    };
    chain.session.mockReturnValue(chain);
    const bulkModel = {
      find: jest.fn(() => chain),
      updateMany: jest.fn(),
    };
    const bulkService = new OrderStateMachineService(
      bulkModel as any,
      {} as any,
    );

    await expect(
      bulkService.transitionManyToPaid(
        orderIds,
        sessionId,
        { triggeredBy: 'vnpay_webhook', amount: 100_000 },
        {} as any,
      ),
    ).rejects.toThrow('Tất cả đơn trong snapshot phải ở trạng thái Served');
    expect(bulkModel.updateMany).not.toHaveBeenCalled();
  });
});
