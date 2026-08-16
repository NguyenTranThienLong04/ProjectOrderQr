import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { ActorType } from '../../common/enums/actor-type.enum';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { Order, OrderDocument } from './order.schema';
import { Table, TableDocument } from '../table/table.schema';
import { TableStatus } from '../../common/enums/table-status.enum';

@Injectable()
export class OrderStateMachineService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Table.name) private readonly tableModel: Model<TableDocument>,
  ) {}
  /** Central state machine: only these edges exist; direct status writes are forbidden. */
  async transitionItem(
    orderId: string,
    itemId: string,
    next: OrderStatus,
    actor: { id: string; role: UserRole },
  ) {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    const item = order.items.find(
      (entry) => entry._id.toString() === itemId.toString(),
    );
    if (!item) throw new NotFoundException('Không tìm thấy món trong đơn');
    const allowed =
      (actor.role === UserRole.KITCHEN &&
        ((item.status === OrderStatus.PENDING &&
          next === OrderStatus.PREPARING) ||
          (item.status === OrderStatus.PREPARING &&
            next === OrderStatus.READY))) ||
      (actor.role === UserRole.WAITER &&
        item.status === OrderStatus.READY &&
        next === OrderStatus.SERVED) ||
      actor.role === UserRole.ADMIN;
    if (!allowed)
      throw new ForbiddenException(
        'Role hoặc thứ tự chuyển trạng thái không hợp lệ',
      );
    if (actor.role === UserRole.ADMIN && next === OrderStatus.CANCELLED) {
      /* admin override */
    } else if (item.status === next)
      throw new BadRequestException('Món đã ở trạng thái này');
    const from = item.status;
    item.status = next;
    item.statusHistory.push({
      fromStatus: from,
      toStatus: next,
      changedBy: {
        actorType: ActorType.USER,
        userId: new Types.ObjectId(actor.id),
        role: actor.role,
      },
      changedAt: new Date(),
    });
    // An order is Served only when every item has been served. This keeps the
    // payment gate aligned with the item-level kitchen/waiter workflow.
    if (
      next === OrderStatus.SERVED &&
      order.status === OrderStatus.PENDING &&
      order.items.every((orderItem) => orderItem.status === OrderStatus.SERVED)
    ) {
      order.status = OrderStatus.SERVED;
      order.statusHistory.push({
        fromStatus: OrderStatus.PENDING,
        toStatus: OrderStatus.SERVED,
        changedBy: {
          actorType: ActorType.USER,
          userId: new Types.ObjectId(actor.id),
          role: actor.role,
        },
        changedAt: new Date(),
      });
    }
    await order.save();
    if (order.status === OrderStatus.SERVED) {
      const hasUnservedActiveOrder = await this.orderModel.exists({
        sessionId: order.sessionId,
        status: {
          $nin: [OrderStatus.SERVED, OrderStatus.PAID, OrderStatus.CANCELLED],
        },
      });
      if (!hasUnservedActiveOrder) {
        await this.tableModel
          .updateMany(
            { currentSessionId: order.sessionId },
            { $set: { status: TableStatus.WAITING_PAYMENT } },
          )
          .exec();
      }
    }
    return order;
  }

  /**
   * The payment edge is deliberately not exposed to controllers used by people.
   * It can only be invoked by a payment provider after its webhook is verified.
   */
  async transition(
    orderId: string,
    next: OrderStatus.PAID,
    metadata: {
      triggeredBy: 'vnpay_webhook';
      transactionNo?: string;
      amount: number;
    },
  ): Promise<OrderDocument> {
    if (next !== OrderStatus.PAID) {
      throw new BadRequestException('Transition hệ thống không hợp lệ');
    }
    const changedAt = new Date();
    // Compare-and-set makes simultaneous VNPAY retries safe: exactly one request
    // can win Served → Paid and append the payment audit entry.
    const order = await this.orderModel
      .findOneAndUpdate(
        { _id: orderId, status: OrderStatus.SERVED },
        {
          $set: { status: OrderStatus.PAID, paidAt: changedAt },
          $push: {
            statusHistory: {
              fromStatus: OrderStatus.SERVED,
              toStatus: OrderStatus.PAID,
              changedBy: { actorType: ActorType.SYSTEM },
              changedAt,
              transactionNo: metadata.transactionNo,
              amount: metadata.amount,
              source: metadata.triggeredBy,
            },
          },
        },
        { new: true },
      )
      .exec();
    if (order) return order;
    const current = await this.orderModel.findById(orderId).exec();
    if (!current) throw new NotFoundException('Không tìm thấy đơn');
    if (current.status === OrderStatus.PAID)
      throw new BadRequestException('Đơn đã được thanh toán');
    throw new BadRequestException('Chỉ đơn đã phục vụ mới được thanh toán');
  }

  /**
   * Session checkout edge. The caller owns the MongoDB transaction containing
   * both this multi-Order compare-and-set and the PaymentIntent completion.
   * A mismatch aborts the transaction, preventing a partially paid Session.
   */
  async transitionManyToPaid(
    orderIds: Types.ObjectId[],
    sessionId: Types.ObjectId,
    metadata: {
      triggeredBy: 'vnpay_webhook';
      transactionNo?: string;
      amount: number;
    },
    mongoSession: ClientSession,
  ): Promise<OrderDocument[]> {
    const uniqueOrderIds = [
      ...new Map(orderIds.map((id) => [id.toString(), id])).values(),
    ];
    if (!uniqueOrderIds.length)
      throw new BadRequestException('Giao dịch không bao gồm đơn nào');

    const coveredOrders = await this.orderModel
      .find({ _id: { $in: uniqueOrderIds }, sessionId })
      .session(mongoSession)
      .exec();
    if (coveredOrders.length !== uniqueOrderIds.length)
      throw new BadRequestException(
        'Snapshot giao dịch không khớp các đơn của phiên ăn',
      );
    if (
      coveredOrders.some(
        (order) =>
          order.status !== OrderStatus.SERVED ||
          order.items.some((item) => item.status !== OrderStatus.SERVED),
      )
    ) {
      throw new BadRequestException(
        'Tất cả đơn trong snapshot phải ở trạng thái Served',
      );
    }

    const changedAt = new Date();
    const result = await this.orderModel
      .updateMany(
        {
          _id: { $in: uniqueOrderIds },
          sessionId,
          status: OrderStatus.SERVED,
        },
        {
          $set: { status: OrderStatus.PAID, paidAt: changedAt },
          $push: {
            statusHistory: {
              fromStatus: OrderStatus.SERVED,
              toStatus: OrderStatus.PAID,
              changedBy: { actorType: ActorType.SYSTEM },
              changedAt,
              transactionNo: metadata.transactionNo,
              amount: metadata.amount,
              source: metadata.triggeredBy,
            },
          },
        },
      )
      .session(mongoSession)
      .exec();
    if (result.modifiedCount !== uniqueOrderIds.length) {
      throw new BadRequestException(
        'Không thể xác nhận toàn bộ đơn trong cùng một giao dịch',
      );
    }
    return this.orderModel
      .find({ _id: { $in: uniqueOrderIds }, sessionId })
      .sort({ createdAt: 1 })
      .session(mongoSession)
      .exec();
  }

  async cancelCustomer(orderId: string, sessionId: string) {
    const order = await this.orderModel
      .findOne({ _id: orderId, sessionId })
      .exec();
    if (!order)
      throw new NotFoundException('Không tìm thấy đơn thuộc phiên ăn này');
    // Only allow customer cancel when the order-level status is Pending AND all items are still Pending.
    if (order.status !== OrderStatus.PENDING)
      throw new ForbiddenException('Chỉ hủy được đơn Pending');
    const anyStarted = order.items.some(
      (it) => it.status !== OrderStatus.PENDING,
    );
    if (anyStarted)
      throw new ForbiddenException('Không thể hủy: món đã được bắt đầu xử lý');
    order.status = OrderStatus.CANCELLED;
    order.statusHistory.push({
      fromStatus: OrderStatus.PENDING,
      toStatus: OrderStatus.CANCELLED,
      changedBy: {
        actorType: ActorType.CUSTOMER,
        sessionId: new Types.ObjectId(sessionId),
      },
      changedAt: new Date(),
    });
    await order.save();
    return order;
  }
  /** Admin override: cancel any order at any status (for support/incident handling). */
  async cancelByAdmin(orderId: string, admin: { id: string; role: UserRole }) {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status === OrderStatus.CANCELLED)
      throw new BadRequestException('Đơn đã bị hủy trước đó');
    const from = order.status;
    order.status = OrderStatus.CANCELLED;
    order.statusHistory.push({
      fromStatus: from,
      toStatus: OrderStatus.CANCELLED,
      changedBy: {
        actorType: ActorType.USER,
        userId: new Types.ObjectId(admin.id),
        role: admin.role,
      },
      changedAt: new Date(),
    });
    await order.save();
    return order;
  }
}
