import { ConflictException } from '@nestjs/common';
import { validate } from 'class-validator';
import { PromotionService } from './promotion.service';
import { PromotionType } from './promotion-type.enum';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';

describe('PromotionService', () => {
  const now = new Date('2026-08-13T12:00:00.000Z');
  const promotion: any = {
    _id: 'promotion-1',
    code: 'SAVE10',
    type: PromotionType.PERCENTAGE,
    value: 10,
    minOrderAmount: 10000,
    startDate: new Date('2026-08-01'),
    endDate: new Date('2026-08-31'),
    isActive: true,
    usageLimit: 1,
    usedCount: 0,
  };
  let model: any;
  let service: PromotionService;

  beforeEach(() => {
    Object.assign(promotion, {
      type: PromotionType.PERCENTAGE,
      value: 10,
      minOrderAmount: 10000,
      startDate: new Date('2026-08-01'),
      endDate: new Date('2026-08-31'),
      isActive: true,
      usageLimit: 1,
      usedCount: 0,
    });
    model = {
      create: jest.fn(async (payload) => payload),
      findById: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue(promotion),
      })),
      findByIdAndUpdate: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue(promotion),
      })),
      findOne: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue(promotion),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue({ ...promotion, usedCount: 1 }),
      })),
      updateOne: jest.fn(() => ({ exec: jest.fn() })),
    };
    service = new PromotionService(model);
  });

  it('rounds percentage discounts and snapshots the final total', async () => {
    await expect(
      service.reserveForOrder('save10', 12345, now),
    ).resolves.toMatchObject({
      code: 'SAVE10',
      subtotalAmount: 12345,
      discountAmount: 1235,
      totalAmount: 11110,
    });
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: promotion._id, $expr: { $lt: ['$usedCount', '$usageLimit'] } },
      { $inc: { usedCount: 1 } },
      { new: true },
    );
  });

  it('caps a fixed discount at the subtotal', async () => {
    promotion.type = PromotionType.FIXED_AMOUNT;
    promotion.value = 20000;
    await expect(service.preview('SAVE10', 12345, now)).resolves.toMatchObject({
      discountAmount: 12345,
      totalAmount: 0,
    });
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects inactive, expired, future, and minimum-order promotions clearly', async () => {
    promotion.isActive = false;
    await expect(service.preview('SAVE10', 20000, now)).rejects.toThrow(
      'tạm ngừng',
    );
    promotion.isActive = true;
    promotion.endDate = new Date('2026-08-12');
    await expect(service.preview('SAVE10', 20000, now)).rejects.toThrow(
      'hết hạn',
    );
    promotion.endDate = new Date('2026-08-31');
    promotion.startDate = new Date('2026-08-14');
    await expect(service.preview('SAVE10', 20000, now)).rejects.toThrow(
      'chưa đến ngày',
    );
    promotion.startDate = new Date('2026-08-01');
    await expect(service.preview('SAVE10', 9999, now)).rejects.toThrow(
      'giá trị tối thiểu',
    );
    promotion.usedCount = promotion.usageLimit;
    await expect(service.preview('SAVE10', 20000, now)).rejects.toThrow(
      'hết lượt sử dụng',
    );
  });

  it('returns a clear error when the promotion code does not exist', async () => {
    model.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    await expect(service.preview('MISSING', 20000, now)).rejects.toThrow(
      'không tồn tại',
    );
  });

  it('returns a conflict when the atomic usage claim loses the race', async () => {
    model.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });
    await expect(
      service.reserveForOrder('SAVE10', 20000, now),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('updates every editable field without writing usedCount', async () => {
    promotion.usedCount = 3;
    const update: UpdatePromotionDto = {
      code: ' fixed50 ',
      type: PromotionType.FIXED_AMOUNT,
      value: 50000,
      minOrderAmount: 200000,
      startDate: '2026-08-14',
      endDate: '2026-08-20',
      isActive: false,
      usageLimit: 10,
    };

    await service.update('promotion-1', update);

    const updateDocument = model.findByIdAndUpdate.mock.calls[0][1];
    expect(updateDocument.$set).toMatchObject({
      code: 'FIXED50',
      type: update.type,
      value: update.value,
      minOrderAmount: update.minOrderAmount,
      isActive: false,
      usageLimit: update.usageLimit,
    });
    expect(updateDocument.$set.startDate).toEqual(
      new Date('2026-08-14T00:00:00.000Z'),
    );
    expect(updateDocument.$set.endDate).toEqual(
      new Date('2026-08-20T23:59:59.999Z'),
    );
    expect(updateDocument.$set).not.toHaveProperty('usedCount');
    expect(promotion.usedCount).toBe(3);
  });

  it('rejects invalid update dates, percentage values, fixed decimals, and limits below usedCount', async () => {
    promotion.usedCount = 3;
    await expect(
      service.update('promotion-1', {
        startDate: '2026-08-20',
        endDate: '2026-08-19',
      }),
    ).rejects.toThrow('Ngày kết thúc');
    await expect(
      service.update('promotion-1', {
        type: PromotionType.PERCENTAGE,
        value: 101,
      }),
    ).rejects.toThrow('100');
    await expect(
      service.update('promotion-1', {
        type: PromotionType.FIXED_AMOUNT,
        value: 10.5,
      }),
    ).rejects.toThrow('số nguyên VND');
    await expect(
      service.update('promotion-1', { usageLimit: 2 }),
    ).rejects.toThrow('số lượt đã dùng');
  });

  it('returns a clear duplicate-code conflict on update', async () => {
    model.findByIdAndUpdate.mockReturnValue({
      exec: jest.fn().mockRejectedValue({ code: 11000 }),
    });
    await expect(
      service.update('promotion-1', { code: 'DUPLICATE' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('uses the same DTO constraints for create and update fields', async () => {
    const invalidCreate = Object.assign(new CreatePromotionDto(), {
      code: '',
      type: 'unknown',
      value: -1,
      minOrderAmount: -1,
      startDate: 'not-a-date',
      endDate: 'not-a-date',
      isActive: 'yes',
      usageLimit: 0,
    });
    const invalidUpdate = Object.assign(
      new UpdatePromotionDto(),
      invalidCreate,
    );
    expect((await validate(invalidCreate)).length).toBeGreaterThanOrEqual(7);
    expect((await validate(invalidUpdate)).length).toBeGreaterThanOrEqual(7);
  });

  it('keeps a date-only promotion valid through the full end date', async () => {
    await service.create({
      code: 'TODAY',
      type: PromotionType.PERCENTAGE,
      value: 10,
      minOrderAmount: 0,
      startDate: '2026-08-13',
      endDate: '2026-08-13',
      usageLimit: 5,
    });
    expect(model.create.mock.calls[0][0].endDate).toEqual(
      new Date('2026-08-13T23:59:59.999Z'),
    );
  });
});
