import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument } from '../order/order.schema';
import { Table, TableDocument } from '../table/table.schema';
import { Dish, DishDocument } from '../dish/dish.schema';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { TableStatus } from '../../common/enums/table-status.enum';
import { Review, ReviewDocument } from '../review/review.schema';

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    @InjectModel(Table.name) private tableModel: Model<TableDocument>,
    @InjectModel(Dish.name) private dishModel: Model<DishDocument>,
    @InjectModel(Review.name) private reviewModel: Model<ReviewDocument>,
  ) {}

  /**
   * Revenue aggregation using MongoDB aggregation pipeline.
   * Using $match/$group/$sort at DB level avoids fetching all orders into
   * application memory (prevents OOM) and leverages MongoDB's optimized
   * C++ aggregation engine. Doing the grouping in NestJS would be slower
   * and memory-inefficient for large datasets.
   */
  async getRevenue(
    from?: Date,
    to?: Date,
    groupBy: 'day' | 'month' | 'year' = 'day',
  ) {
    const match: any = { status: OrderStatus.PAID };
    if (from || to) {
      match.paidAt = {};
      if (from) match.paidAt.$gte = from;
      if (to) match.paidAt.$lte = to;
    }

    // Choose date format for grouping
    let dateFormat = '%Y-%m-%d';
    if (groupBy === 'month') dateFormat = '%Y-%m';
    if (groupBy === 'year') dateFormat = '%Y';

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$paidAt' } },
          revenue: { $sum: '$totalAmount' },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 as const } },
      {
        $project: {
          _id: 0,
          date: '$_id',
          revenue: 1,
          orders: 1,
        },
      },
    ];

    const result = await this.orderModel.aggregate(pipeline).exec();
    return result;
  }

  async getTopRatedDishes(limit = 10) {
    return this.reviewModel
      .aggregate([
        {
          $group: {
            _id: '$dishId',
            averageRating: { $avg: '$rating' },
            reviewCount: { $sum: 1 },
          },
        },
        {
          $lookup: {
            from: 'dishes',
            localField: '_id',
            foreignField: '_id',
            as: 'dish',
          },
        },
        { $unwind: '$dish' },
        {
          $project: {
            _id: 0,
            dishId: '$_id',
            dishName: '$dish.name',
            averageRating: { $round: ['$averageRating', 2] },
            reviewCount: 1,
          },
        },
        { $sort: { averageRating: -1, reviewCount: -1 } },
        { $limit: limit },
      ])
      .exec();
  }

  /**
   * Top dishes: unwind items and aggregate quantity and revenue per dish.
   * Doing $unwind + $group in DB is efficient and avoids materializing
   * all items in application memory.
   */
  async getTopDishes(from?: Date, to?: Date, limit = 10) {
    const match: any = { status: OrderStatus.PAID };
    if (from || to) {
      match.paidAt = {};
      if (from) match.paidAt.$gte = from;
      if (to) match.paidAt.$lte = to;
    }

    const pipeline: any[] = [
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.dishId',
          dishName: { $first: '$items.dishName' },
          totalQuantity: { $sum: '$items.quantity' },
          revenue: {
            $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] },
          },
        },
      },
      { $sort: { totalQuantity: -1 as const, revenue: -1 as const } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          dishId: '$_id',
          dishName: 1,
          totalQuantity: 1,
          revenue: 1,
        },
      },
    ];

    const result = await this.orderModel.aggregate(pipeline as any).exec();
    return result;
  }

  /**
   * Overview numbers for dashboard. A few small queries are executed in DB.
   * - totalOrders: total number of orders
   * - ordersToday: orders created today (using createdAt)
   * - occupiedTables: count of tables with status = occupied (fast indexed query)
   * - avgOrderValue: average order total for Paid orders
   */
  async getOverview() {
    const now = new Date();
    const startOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );

    const [totalOrders, ordersToday, occupiedTablesAgg, avgAgg] =
      await Promise.all([
        this.orderModel.countDocuments({}).exec(),
        this.orderModel
          .countDocuments({ createdAt: { $gte: startOfDay } })
          .exec(),
        this.tableModel.countDocuments({ status: TableStatus.OCCUPIED }).exec(),
        this.orderModel
          .aggregate([
            { $match: { status: OrderStatus.PAID } },
            { $group: { _id: null, avg: { $avg: '$totalAmount' } } },
          ])
          .exec(),
      ]);

    const avgOrderValue = avgAgg && avgAgg.length > 0 ? avgAgg[0].avg : 0;

    return {
      totalOrders,
      ordersToday,
      occupiedTables: occupiedTablesAgg,
      avgOrderValue,
    };
  }
}
