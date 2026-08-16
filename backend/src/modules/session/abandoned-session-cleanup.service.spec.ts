import { Types } from 'mongoose';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { SessionStatus } from '../../common/enums/session-status.enum';
import { TableStatus } from '../../common/enums/table-status.enum';
import { AbandonedSessionCleanupService } from './abandoned-session-cleanup.service';

const queryResult = <T>(value: T) => {
  const query = {
    select: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn(),
    session: jest.fn(),
    exec: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  query.session.mockReturnValue(query);
  return query;
};

describe('AbandonedSessionCleanupService', () => {
  const sessionId = new Types.ObjectId();
  const tableId = new Types.ObjectId();
  const now = new Date('2026-08-15T10:10:00.000Z');
  const staleAt = new Date('2026-08-15T09:59:59.000Z');
  let candidateSessions: Array<{ _id: Types.ObjectId }>;
  let recheckedSession: Record<string, unknown> | null;
  let hasOrder: Record<string, unknown> | null;
  let sessionModel: {
    find: jest.Mock;
    findOne: jest.Mock;
    updateOne: jest.Mock;
  };
  let tableModel: { updateMany: jest.Mock };
  let orderModel: { exists: jest.Mock };
  let gateway: { emit: jest.Mock };
  let service: AbandonedSessionCleanupService;

  beforeEach(() => {
    candidateSessions = [{ _id: sessionId }];
    recheckedSession = {
      _id: sessionId,
      tableId,
      tableIds: [tableId],
      status: SessionStatus.ACTIVE,
      version: 1,
      cart: [{ dishId: new Types.ObjectId(), quantity: 2 }],
      lastActivityAt: staleAt,
    };
    hasOrder = null;
    sessionModel = {
      find: jest.fn(() => queryResult(candidateSessions)),
      findOne: jest.fn(() => queryResult(recheckedSession)),
      updateOne: jest.fn(() => queryResult({ modifiedCount: 1 })),
    };
    tableModel = {
      updateMany: jest.fn(() => queryResult({ modifiedCount: 1 })),
    };
    orderModel = {
      exists: jest.fn(() => queryResult(hasOrder)),
    };
    gateway = { emit: jest.fn() };
    const mongoSession = {
      withTransaction: jest.fn(async (work: () => Promise<void>) => work()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    service = new AbandonedSessionCleanupService(
      sessionModel as never,
      tableModel as never,
      orderModel as never,
      {
        startSession: jest.fn().mockResolvedValue(mongoSession),
      } as never,
      { get: jest.fn().mockReturnValue('10') } as never,
      gateway as never,
    );
  });

  it('expires a stale zero-Order Session even when its shared cart has items', async () => {
    await expect(service.cleanupAbandonedSessions(now)).resolves.toBe(1);

    expect(sessionModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: sessionId,
        status: SessionStatus.ACTIVE,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: SessionStatus.EXPIRED,
          endedAt: now,
          cart: [],
        }),
      }),
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(tableModel.updateMany).toHaveBeenCalledWith(
      { currentSessionId: sessionId },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: TableStatus.AVAILABLE,
          currentSessionId: null,
        }),
      }),
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(gateway.emit).toHaveBeenCalledWith(
      `session:${sessionId.toString()}`,
      'session:expired',
      { sessionId: sessionId.toString() },
    );
    expect(gateway.emit).toHaveBeenCalledWith(
      ['waiter', 'admin'],
      'tables:updated',
    );
  });

  it('does nothing when activity became fresh between candidate scan and transaction', async () => {
    recheckedSession = null;

    await expect(service.cleanupAbandonedSessions(now)).resolves.toBe(0);

    expect(orderModel.exists).not.toHaveBeenCalled();
    expect(sessionModel.updateOne).not.toHaveBeenCalled();
    expect(tableModel.updateMany).not.toHaveBeenCalled();
    expect(gateway.emit).not.toHaveBeenCalled();
  });

  it.each([
    OrderStatus.PENDING,
    OrderStatus.PREPARING,
    OrderStatus.READY,
    OrderStatus.SERVED,
    OrderStatus.PAID,
    OrderStatus.CANCELLED,
  ])('never expires a Session that has an Order in %s', async (status) => {
    hasOrder = { _id: new Types.ObjectId(), status };

    await expect(service.cleanupAbandonedSessions(now)).resolves.toBe(0);

    expect(orderModel.exists).toHaveBeenCalledWith({ sessionId });
    expect(sessionModel.updateOne).not.toHaveBeenCalled();
    expect(tableModel.updateMany).not.toHaveBeenCalled();
  });

  it('skips fresh Sessions before opening a transaction', async () => {
    candidateSessions = [];

    await expect(service.cleanupAbandonedSessions(now)).resolves.toBe(0);

    expect(sessionModel.findOne).not.toHaveBeenCalled();
    expect(gateway.emit).not.toHaveBeenCalled();
  });

  it('rejects an invalid timeout instead of silently choosing a dangerous value', () => {
    expect(
      () =>
        new AbandonedSessionCleanupService(
          sessionModel as never,
          tableModel as never,
          orderModel as never,
          {} as never,
          { get: jest.fn().mockReturnValue('0') } as never,
          gateway as never,
        ),
    ).toThrow('EMPTY_SESSION_TIMEOUT_MINUTES phải là số dương');
  });
});
