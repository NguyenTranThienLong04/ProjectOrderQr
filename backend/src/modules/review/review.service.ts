import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../order/order.schema';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { CreateReviewDto } from './dto/create-review.dto';
import { Review, ReviewDocument } from './review.schema';

@Injectable()
export class ReviewService {
  constructor(
    @InjectModel(Review.name)
    private readonly reviewModel: Model<ReviewDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
  ) {}

  async create(dto: CreateReviewDto) {
    const order = await this.assertReviewable(dto.orderId, dto.sessionId);
    if (!order.items.some((item) => item.dishId.toString() === dto.dishId))
      throw new NotFoundException('Món ăn không thuộc đơn hàng này');
    try {
      const review = await this.reviewModel.create({
        orderId: new Types.ObjectId(dto.orderId),
        dishId: new Types.ObjectId(dto.dishId),
        tableId: order.tableId,
        sessionId: new Types.ObjectId(dto.sessionId),
        rating: dto.rating,
        comment: dto.comment?.trim() || undefined,
      });
      return {
        reviewId: review.id,
        orderId: review.orderId.toString(),
        dishId: review.dishId.toString(),
        rating: review.rating,
        comment: review.comment,
      };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 11000
      )
        throw new ConflictException(
          'Món này đã được đánh giá cho đơn hàng này',
        );
      throw error;
    }
  }

  async getReviewableOrder(orderId: string, sessionId: string) {
    const order = await this.assertReviewable(orderId, sessionId);
    const reviews = await this.reviewModel
      .find({ orderId: order._id })
      .select('dishId')
      .lean()
      .exec();
    const reviewedDishIds = new Set(
      reviews.map((review) => review.dishId.toString()),
    );
    return {
      orderId: order.id,
      items: order.items.map((item) => ({
        dishId: item.dishId.toString(),
        dishName: item.dishName,
        reviewed: reviewedDishIds.has(item.dishId.toString()),
      })),
    };
  }

  private async assertReviewable(
    orderId: string,
    sessionId: string,
  ): Promise<OrderDocument> {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (order.sessionId.toString() !== sessionId)
      throw new ForbiddenException('Bạn không có quyền đánh giá đơn hàng này');
    if (order.status !== OrderStatus.PAID)
      throw new ForbiddenException(
        'Chỉ có thể đánh giá sau khi đơn đã thanh toán',
      );
    return order;
  }
}
