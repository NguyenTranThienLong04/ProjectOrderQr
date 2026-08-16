import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { SessionStatus } from '../../common/enums/session-status.enum';
import { TableStatus } from '../../common/enums/table-status.enum';
import { SessionService } from './session.service';

describe('SessionService active-session resume', () => {
  const tableId = new Types.ObjectId();
  const sessionId = new Types.ObjectId();
  const dishId = new Types.ObjectId();
  const session = {
    _id: sessionId,
    id: sessionId.toString(),
    tableId,
    tableIds: [tableId],
    status: SessionStatus.ACTIVE,
    version: 2,
    cart: [
      {
        _id: new Types.ObjectId(),
        dishId,
        dishName: 'Phở',
        unitPrice: 40000,
        quantity: 2,
      },
    ],
  };
  const currentOrder = {
    id: new Types.ObjectId().toString(),
    status: OrderStatus.SERVED,
    subtotalAmount: 80000,
    discountAmount: 8000,
    totalAmount: 72000,
    promotionCode: 'SAVE10',
  };
  let tableModel: any;
  let sessionModel: any;
  let dishModel: any;
  let orderModel: any;
  let service: SessionService;

  beforeEach(() => {
    tableModel = {
      findById: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue({
          _id: tableId,
          id: tableId.toString(),
          status: TableStatus.WAITING_PAYMENT,
          currentSessionId: sessionId,
          groupedWithTableIds: [],
        }),
      })),
    };
    sessionModel = {
      findOneAndUpdate: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue(session),
      })),
      findOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(session) })),
    };
    dishModel = {
      find: jest.fn(() => ({
        exec: jest
          .fn()
          .mockResolvedValue([{ id: dishId.toString(), price: 45000 }]),
      })),
    };
    orderModel = {
      findOne: jest.fn(() => ({
        sort: jest.fn(() => ({
          select: jest.fn(() => ({
            exec: jest.fn().mockResolvedValue(currentOrder),
          })),
        })),
      })),
    };
    service = new SessionService(
      sessionModel,
      tableModel,
      dishModel,
      orderModel,
      {} as never,
    );
  });

  it('restores the same active session and Served order while the table waits for payment', async () => {
    await expect(
      service.getOrCreateActiveSession(tableId.toString()),
    ).resolves.toMatchObject({
      sessionId: sessionId.toString(),
      currentOrder: {
        orderId: currentOrder.id,
        status: OrderStatus.SERVED,
        totalAmount: 72000,
      },
    });
    await expect(
      service.getOrCreateActiveSession(tableId.toString()),
    ).resolves.toMatchObject({ sessionId: sessionId.toString() });
    expect(sessionModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(
      sessionModel.findOneAndUpdate.mock.calls[0][1].$set.lastActivityAt,
    ).toBeInstanceOf(Date);
  });

  it('does not create a duplicate session when waiting_payment has no restorable active session', async () => {
    tableModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        _id: tableId,
        id: tableId.toString(),
        status: TableStatus.WAITING_PAYMENT,
        currentSessionId: null,
        groupedWithTableIds: [],
      }),
    });
    await expect(
      service.getOrCreateActiveSession(tableId.toString()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('calculates promotion preview subtotal from the active server cart and live Dish prices', async () => {
    await expect(
      service.getActiveCartSubtotal(tableId.toString()),
    ).resolves.toBe(90000);
    expect(dishModel.find).toHaveBeenCalledWith({
      _id: { $in: [dishId.toString()] },
      isAvailable: true,
    });
  });
});

describe('SessionService cart item notes', () => {
  const tableId = new Types.ObjectId();
  const sessionId = new Types.ObjectId();
  const dishId = new Types.ObjectId();
  const cartItemId = new Types.ObjectId();
  let sessionModel: any;
  let dishModel: any;
  let service: SessionService;

  const cartSession = (note?: string) => ({
    _id: sessionId,
    id: sessionId.toString(),
    tableId,
    tableIds: [tableId],
    status: SessionStatus.ACTIVE,
    version: 3,
    cart: [
      {
        _id: cartItemId,
        dishId,
        dishName: 'Coca-Cola',
        unitPrice: 20000,
        quantity: 1,
        note,
        addedAt: new Date(),
      },
    ],
  });

  beforeEach(() => {
    sessionModel = { findOneAndUpdate: jest.fn() };
    dishModel = {
      findOne: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue({ name: 'Coca-Cola', price: 20000 }),
      })),
    };
    service = new SessionService(
      sessionModel,
      {} as never,
      dishModel,
      {} as never,
      {} as never,
    );
  });

  it('trims the note and uses dishId plus note as the atomic add identity', async () => {
    sessionModel.findOneAndUpdate
      .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(null) })
      .mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue(cartSession('Không đá')),
      });

    const result = await service.addToCart(
      sessionId.toString(),
      dishId.toString(),
      1,
      '  Không đá  ',
    );

    expect(
      sessionModel.findOneAndUpdate.mock.calls[0][0].cart.$elemMatch,
    ).toMatchObject({
      dishId,
      note: 'Không đá',
    });
    expect(
      sessionModel.findOneAndUpdate.mock.calls[1][0].cart.$not.$elemMatch,
    ).toMatchObject({
      dishId,
      note: 'Không đá',
    });
    expect(sessionModel.findOneAndUpdate.mock.calls[1][1].$push.cart.note).toBe(
      'Không đá',
    );
    expect(
      sessionModel.findOneAndUpdate.mock.calls[1][1].$set.lastActivityAt,
    ).toBeInstanceOf(Date);
    expect(result.cart[0]).toMatchObject({
      cartItemId: cartItemId.toString(),
      dishId: dishId.toString(),
      note: 'Không đá',
    });
  });

  it('normalizes a whitespace-only optional note to the no-note identity', async () => {
    sessionModel.findOneAndUpdate
      .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(null) })
      .mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue(cartSession()),
      });

    await service.addToCart(sessionId.toString(), dishId.toString(), 1, '   ');

    const identity =
      sessionModel.findOneAndUpdate.mock.calls[0][0].cart.$elemMatch;
    expect(identity.dishId).toEqual(dishId);
    expect(identity.$or).toBeDefined();
    expect(
      sessionModel.findOneAndUpdate.mock.calls[1][1].$push.cart.note,
    ).toBeUndefined();
  });

  it('rejects an item note longer than 250 characters before writing', async () => {
    await expect(
      service.addToCart(
        sessionId.toString(),
        dishId.toString(),
        1,
        'a'.repeat(251),
      ),
    ).rejects.toThrow('Ghi chú món không được vượt quá 250 ký tự');
    expect(dishModel.findOne).not.toHaveBeenCalled();
    expect(sessionModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('targets quantity updates and removal by cartItemId, not dishId alone', async () => {
    sessionModel.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(cartSession('Không đá')),
    });

    await service.updateCartQuantity(
      sessionId.toString(),
      dishId.toString(),
      2,
      cartItemId.toString(),
    );
    await service.removeFromCart(
      sessionId.toString(),
      dishId.toString(),
      cartItemId.toString(),
    );

    for (const call of sessionModel.findOneAndUpdate.mock.calls) {
      expect(call[0].cart.$elemMatch).toMatchObject({
        _id: cartItemId,
        dishId,
      });
    }
    expect(
      sessionModel.findOneAndUpdate.mock.calls[1][1].$pull.cart,
    ).toMatchObject({
      _id: cartItemId,
      dishId,
    });
    for (const call of sessionModel.findOneAndUpdate.mock.calls) {
      expect(call[1].$set.lastActivityAt).toBeInstanceOf(Date);
    }
  });
});
