import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { UserRole } from '../../common/enums/user-role.enum';
import { CashShiftService } from './cash-shift.service';

describe('Cash shift review rules', () => {
  const staffId = new Types.ObjectId();
  const adminId = new Types.ObjectId();
  const waiter = { id: String(staffId), role: UserRole.WAITER };
  const admin = { id: String(adminId), role: UserRole.ADMIN };
  const session = {};
  function fixture(status = 'OPEN', matched = 1) {
    const shift = {
      _id: new Types.ObjectId(),
      staffId,
      status,
      openingCash: 50000,
      expectedCash: 58000,
      version: 3,
    };
    const query = <T>(value: T) => ({
      session: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(value),
    });
    const shifts = {
      findById: jest.fn(() => query(shift)),
      updateOne: jest.fn(() => query({ modifiedCount: matched })),
    };
    const receipts = { aggregate: jest.fn(() => query([{ amount: 8000 }])) };
    const users = { findById: jest.fn(() => query({ fullName: 'Admin' })) };
    const connection = {
      transaction: jest.fn(async (work: (value: object) => Promise<void>) =>
        work(session),
      ),
    };
    const service = new CashShiftService(
      shifts as unknown as ConstructorParameters<typeof CashShiftService>[0],
      receipts as unknown as ConstructorParameters<typeof CashShiftService>[1],
      users as unknown as ConstructorParameters<typeof CashShiftService>[2],
      connection as unknown as ConstructorParameters<
        typeof CashShiftService
      >[3],
    );
    jest
      .spyOn(service, 'detail')
      .mockResolvedValue({} as Awaited<ReturnType<CashShiftService['detail']>>);
    return { service, shifts, receipts, shift };
  }

  it('snapshots successful CASH on submission and stores declaration separately from verification', async () => {
    const { service, shifts, receipts, shift } = fixture();
    await service.submit(
      String(shift._id),
      { version: 3, declaredCash: 57000 },
      waiter,
    );
    expect(receipts.aggregate).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          $match: {
            cashShiftId: shift._id,
            paymentMethod: 'CASH',
            status: 'succeeded',
          },
        },
      ]),
    );
    const update = shifts.updateOne.mock.calls as unknown as [
      object,
      { $set?: Record<string, unknown> },
      object,
    ][];
    expect(update[1][1].$set).toMatchObject({
      status: 'PENDING_REVIEW',
      expectedCash: 58000,
      declaredCash: 57000,
      declaredVariance: -1000,
      declaredBy: waiter.id,
    });
    expect(update[1][1].$set).not.toHaveProperty('verifiedCash');
    expect(update[1][1].$set).not.toHaveProperty('closedAt');
  });

  it('refuses a stale submit before calculating or writing a new snapshot', async () => {
    const { service, shifts, receipts, shift } = fixture('OPEN', 0);
    await expect(
      service.submit(
        String(shift._id),
        { version: 2, declaredCash: 0 },
        waiter,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(receipts.aggregate).not.toHaveBeenCalled();
    expect(shifts.updateOne).toHaveBeenCalledTimes(1);
  });

  it('prevents an Admin from declaring another collector cash', async () => {
    const { service, shifts, shift } = fixture();
    await expect(
      service.submit(String(shift._id), { version: 3, declaredCash: 0 }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(shifts.updateOne).not.toHaveBeenCalled();
  });

  it('forbids waiter verification even when the service is called without the HTTP guard', async () => {
    const { service, shifts, shift } = fixture('PENDING_REVIEW');
    await expect(
      service.verify(
        String(shift._id),
        { version: 3, verifiedCash: 0 },
        waiter,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(shifts.findById).not.toHaveBeenCalled();
  });

  it('verifies against the stored expected snapshot without recomputing receipts or overwriting the declaration', async () => {
    const { service, shifts, receipts, shift } = fixture('PENDING_REVIEW');
    await service.verify(
      String(shift._id),
      { version: 3, verifiedCash: 56000 },
      admin,
    );
    expect(receipts.aggregate).not.toHaveBeenCalled();
    expect(shifts.updateOne).toHaveBeenCalledWith(
      { _id: shift._id, status: 'PENDING_REVIEW', version: 3 },
      {
        $inc: { version: 1 },
        $set: expect.objectContaining({
          status: 'CLOSED',
          verifiedCash: 56000,
          verifiedVariance: -2000,
          verifiedBy: admin.id,
        }),
      },
      { session },
    );
    const update = shifts.updateOne.mock.calls as unknown as [
      object,
      { $set: Record<string, unknown> },
    ][];
    expect(update[0][1].$set).not.toHaveProperty('declaredCash');
    expect(update[0][1].$set).not.toHaveProperty('expectedCash');
  });

  it('rejects verification when its CAS loses', async () => {
    const { service, shift } = fixture('PENDING_REVIEW', 0);
    await expect(
      service.verify(String(shift._id), { version: 2, verifiedCash: 0 }, admin),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(service.detail).not.toHaveBeenCalled();
  });
});
