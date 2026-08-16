import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';
import { Promotion, PromotionDocument } from './promotion.schema';
import { PromotionType } from './promotion-type.enum';

export interface AppliedPromotion {
  promotionId?: Types.ObjectId;
  code?: string;
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
}

@Injectable()
export class PromotionService {
  constructor(
    @InjectModel(Promotion.name)
    private readonly promotionModel: Model<PromotionDocument>,
  ) {}

  async create(dto: CreatePromotionDto) {
    this.assertDateRange(dto.startDate, dto.endDate);
    this.assertValue(dto.type, dto.value);
    try {
      return await this.promotionModel.create({
        ...dto,
        code: dto.code.trim().toUpperCase(),
        startDate: this.normalizeBoundary(dto.startDate, false),
        endDate: this.normalizeBoundary(dto.endDate, true),
      });
    } catch (error) {
      if (this.isDuplicateKey(error))
        throw new ConflictException('Mã giảm giá đã tồn tại');
      throw error;
    }
  }

  findAll() {
    return this.promotionModel.find().sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string) {
    const promotion = await this.promotionModel.findById(id).exec();
    if (!promotion) throw new NotFoundException('Không tìm thấy mã giảm giá');
    return promotion;
  }

  async update(id: string, dto: UpdatePromotionDto) {
    const current = await this.findOne(id);
    this.assertDateRange(
      dto.startDate ?? current.startDate,
      dto.endDate ?? current.endDate,
    );
    this.assertValue(dto.type ?? current.type, dto.value ?? current.value);
    if (dto.usageLimit !== undefined && dto.usageLimit < current.usedCount) {
      throw new BadRequestException(
        `Giới hạn lượt dùng không được nhỏ hơn số lượt đã dùng (${current.usedCount})`,
      );
    }
    try {
      const updates = {
        ...(dto.code !== undefined
          ? { code: dto.code.trim().toUpperCase() }
          : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.value !== undefined ? { value: dto.value } : {}),
        ...(dto.minOrderAmount !== undefined
          ? { minOrderAmount: dto.minOrderAmount }
          : {}),
        ...(dto.startDate !== undefined
          ? { startDate: this.normalizeBoundary(dto.startDate, false) }
          : {}),
        ...(dto.endDate !== undefined
          ? { endDate: this.normalizeBoundary(dto.endDate, true) }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.usageLimit !== undefined ? { usageLimit: dto.usageLimit } : {}),
      };
      const promotion = await this.promotionModel
        .findByIdAndUpdate(
          id,
          { $set: updates },
          { new: true, runValidators: true },
        )
        .exec();
      if (!promotion) throw new NotFoundException('Không tìm thấy mã giảm giá');
      return promotion;
    } catch (error) {
      if (this.isDuplicateKey(error))
        throw new ConflictException('Mã giảm giá đã tồn tại');
      throw error;
    }
  }

  async remove(id: string) {
    const promotion = await this.promotionModel.findByIdAndDelete(id).exec();
    if (!promotion) throw new NotFoundException('Không tìm thấy mã giảm giá');
  }

  async preview(
    code: string,
    subtotalAmount: number,
    now = new Date(),
  ): Promise<AppliedPromotion> {
    if (!code?.trim())
      throw new BadRequestException('Vui lòng nhập mã giảm giá');
    const promotion = await this.promotionModel
      .findOne({ code: code.trim().toUpperCase() })
      .exec();
    if (!promotion) throw new NotFoundException('Mã giảm giá không tồn tại');
    this.assertEligible(promotion, subtotalAmount, now);
    return this.calculate(promotion, subtotalAmount);
  }

  async reserveForOrder(
    code: string | undefined,
    subtotalAmount: number,
    now = new Date(),
  ): Promise<AppliedPromotion> {
    if (!code?.trim())
      return { subtotalAmount, discountAmount: 0, totalAmount: subtotalAmount };
    const promotion = await this.promotionModel
      .findOne({ code: code.trim().toUpperCase() })
      .exec();
    if (!promotion) throw new NotFoundException('Mã giảm giá không tồn tại');
    this.assertEligible(promotion, subtotalAmount, now);
    // The conditional $inc is the single atomic claim: concurrent requests can never exceed usageLimit.
    const reserved = await this.promotionModel
      .findOneAndUpdate(
        { _id: promotion._id, $expr: { $lt: ['$usedCount', '$usageLimit'] } },
        { $inc: { usedCount: 1 } },
        { new: true },
      )
      .exec();
    if (!reserved)
      throw new ConflictException('Mã giảm giá đã hết lượt sử dụng');
    return {
      ...this.calculate(reserved, subtotalAmount),
      promotionId: reserved._id,
    };
  }

  async releaseReservation(promotionId?: Types.ObjectId) {
    if (promotionId)
      await this.promotionModel
        .updateOne(
          { _id: promotionId, usedCount: { $gt: 0 } },
          { $inc: { usedCount: -1 } },
        )
        .exec();
  }

  private assertEligible(
    promotion: PromotionDocument,
    subtotalAmount: number,
    now: Date,
  ) {
    if (!promotion.isActive)
      throw new BadRequestException('Mã giảm giá đang tạm ngừng');
    if (now < promotion.startDate)
      throw new BadRequestException('Mã giảm giá chưa đến ngày áp dụng');
    if (now > promotion.endDate)
      throw new BadRequestException('Mã giảm giá đã hết hạn');
    if (subtotalAmount < promotion.minOrderAmount)
      throw new BadRequestException(
        `Đơn hàng chưa đạt giá trị tối thiểu ${promotion.minOrderAmount}`,
      );
    if (promotion.usedCount >= promotion.usageLimit)
      throw new ConflictException('Mã giảm giá đã hết lượt sử dụng');
  }

  private calculate(
    promotion: PromotionDocument,
    subtotalAmount: number,
  ): AppliedPromotion {
    const discountAmount =
      promotion.type === PromotionType.PERCENTAGE
        ? Math.round((subtotalAmount * promotion.value) / 100)
        : Math.min(promotion.value, subtotalAmount);
    return {
      code: promotion.code,
      subtotalAmount,
      discountAmount,
      totalAmount: Math.max(0, subtotalAmount - discountAmount),
    };
  }

  private assertDateRange(startDate: string | Date, endDate: string | Date) {
    if (new Date(startDate) > new Date(endDate))
      throw new BadRequestException(
        'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu',
      );
  }

  private assertValue(type: PromotionType, value: number) {
    if (type === PromotionType.PERCENTAGE && value > 100)
      throw new BadRequestException(
        'Giá trị giảm phần trăm không được vượt quá 100',
      );
    if (type === PromotionType.FIXED_AMOUNT && !Number.isSafeInteger(value))
      throw new BadRequestException(
        'Giá trị giảm cố định phải là số nguyên VND',
      );
  }

  private normalizeBoundary(value: string, endOfDay: boolean): Date {
    const date = new Date(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      date.setUTCHours(
        endOfDay ? 23 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 999 : 0,
      );
    }
    return date;
  }

  private isDuplicateKey(error: unknown): error is { code: number } {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 11000
    );
  }
}
