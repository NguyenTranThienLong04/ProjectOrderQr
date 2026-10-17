import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types, UpdateQuery } from 'mongoose';
import { ActorType } from '../../common/enums/actor-type.enum';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { Order, OrderDocument } from './order.schema';
import { Table, TableDocument } from '../table/table.schema';
import { TableStatus } from '../../common/enums/table-status.enum';
import {
  canTransitionOrder,
  ITEM_TRANSITIONS,
  orderSourcesFor,
  PROCESSING_ORDER_STATUSES,
} from './order-transition.rules';

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
    const order = await this.updateState(orderId, (current) => {
      if (!PROCESSING_ORDER_STATUSES.includes(current.status))
        throw new ForbiddenException('Đơn không còn cho phép xử lý món');
      const index = current.items.findIndex(
        (entry) => entry._id.toString() === itemId.toString(),
      );
      if (index < 0)
        throw new NotFoundException('Không tìm thấy món trong đơn');
      const item = current.items[index];
      const edge = ITEM_TRANSITIONS[item.status];
      if (!edge || edge.to !== next || !edge.roles.includes(actor.role))
        throw new ForbiddenException(
          'Role hoặc thứ tự chuyển trạng thái không hợp lệ',
        );
      const history = {
        fromStatus: item.status,
        toStatus: next,
        changedBy: {
          actorType: ActorType.USER,
          userId: new Types.ObjectId(actor.id),
          role: actor.role,
        },
        changedAt: new Date(),
      };
      const update: UpdateQuery<OrderDocument> = {
        $set: { [`items.${index}.status`]: next },
        $push: { [`items.${index}.statusHistory`]: history },
      };
      // Compute from the version that will actually be committed. A competing
      // item transition makes the CAS fail and this calculation runs again.
      if (
        next === OrderStatus.SERVED &&
        current.items.every(
          (entry, i) => i === index || entry.status === OrderStatus.SERVED,
        )
      ) {
        update.$set!.status = OrderStatus.SERVED;
        update.$push!.statusHistory = {
          ...history,
          fromStatus: current.status,
        };
      }
      return update;
    });
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
        {
          _id: orderId,
          status: { $in: orderSourcesFor(next) },
          items: {
            $not: { $elemMatch: { status: { $ne: OrderStatus.SERVED } } },
          },
        },
        {
          $set: { status: OrderStatus.PAID, paidAt: changedAt },
          $inc: { __v: 1 },
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
      triggeredBy: 'vnpay_webhook' | 'internal_zero' | 'cash_settlement';
      actor?: { id: string; role: UserRole };
      transactionNo?: string;
      amount: number;
    },
    mongoSession: ClientSession,
  ): Promise<OrderDocument[]> {
    if (
      metadata.triggeredBy === 'cash_settlement' &&
      (!metadata.actor ||
        ![UserRole.ADMIN, UserRole.WAITER].includes(metadata.actor.role))
    )
      throw new ForbiddenException('Chỉ Admin/Waiter được xác nhận tiền mặt');
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
    const total = coveredOrders.reduce(
      (sum, order) => sum + order.totalAmount,
      0,
    );
    if (
      coveredOrders.some(
        (order) =>
          !Number.isSafeInteger(order.totalAmount) || order.totalAmount < 0,
      ) ||
      !Number.isSafeInteger(total) ||
      total !== metadata.amount ||
      (metadata.triggeredBy === 'internal_zero' && total !== 0)
    ) {
      throw new BadRequestException('Số tiền không khớp snapshot thanh toán');
    }
    if (
      coveredOrders.some(
        (order) =>
          !canTransitionOrder(order.status, OrderStatus.PAID) ||
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
          status: { $in: orderSourcesFor(OrderStatus.PAID) },
          items: {
            $not: { $elemMatch: { status: { $ne: OrderStatus.SERVED } } },
          },
        },
        {
          $set: {
            status: OrderStatus.PAID,
            paidAt: changedAt,
            paymentMethod:
              metadata.triggeredBy === 'cash_settlement'
                ? 'CASH'
                : metadata.triggeredBy === 'vnpay_webhook'
                  ? 'VNPAY'
                  : 'INTERNAL_ZERO',
          },
          $inc: { __v: 1 },
          $push: {
            statusHistory: {
              fromStatus: OrderStatus.SERVED,
              toStatus: OrderStatus.PAID,
              changedBy:
                metadata.triggeredBy === 'cash_settlement'
                  ? {
                      actorType: ActorType.USER,
                      userId: new Types.ObjectId(metadata.actor!.id),
                      role: metadata.actor!.role,
                    }
                  : { actorType: ActorType.SYSTEM },
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
    if (!sessionId || !Types.ObjectId.isValid(sessionId))
      throw new BadRequestException('Phiên ăn không hợp lệ');
    return this.updateState(
      orderId,
      (order) => {
        this.assertOrderTransition(order.status, OrderStatus.CANCELLED);
        if (order.status !== OrderStatus.PENDING)
          throw new ForbiddenException('Chỉ hủy được đơn Pending');
        if (order.items.some((it) => it.status !== OrderStatus.PENDING))
          throw new ForbiddenException(
            'Không thể hủy: món đã được bắt đầu xử lý',
          );
        return {
          $set: { status: OrderStatus.CANCELLED },
          $push: {
            statusHistory: {
              fromStatus: order.status,
              toStatus: OrderStatus.CANCELLED,
              changedBy: {
                actorType: ActorType.CUSTOMER,
                sessionId: new Types.ObjectId(sessionId),
              },
              changedAt: new Date(),
            },
          },
        };
      },
      sessionId,
    );
  }

  /** Admin may cancel a nonterminal order, but cannot undo payment. */
  async cancelByAdmin(orderId: string, admin: { id: string; role: UserRole }) {
    if (admin.role !== UserRole.ADMIN)
      throw new ForbiddenException('Chỉ admin được hủy đơn tại đây');
    return this.updateState(orderId, (order) => {
      this.assertOrderTransition(order.status, OrderStatus.CANCELLED);
      return {
        $set: { status: OrderStatus.CANCELLED },
        $push: {
          statusHistory: {
            fromStatus: order.status,
            toStatus: OrderStatus.CANCELLED,
            changedBy: {
              actorType: ActorType.USER,
              userId: new Types.ObjectId(admin.id),
              role: admin.role,
            },
            changedAt: new Date(),
          },
        },
      };
    });
  }

  private assertOrderTransition(from: OrderStatus, to: OrderStatus) {
    if (!canTransitionOrder(from, to))
      throw new ForbiddenException('Thứ tự chuyển trạng thái đơn không hợp lệ');
  }

  private async updateState(
    orderId: string,
    buildUpdate: (order: OrderDocument) => UpdateQuery<OrderDocument>,
    sessionId?: string,
  ): Promise<OrderDocument> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const order = await this.orderModel
        .findOne({
          _id: orderId,
          ...(sessionId !== undefined ? { sessionId } : {}),
        })
        .exec();
      if (!order) throw new NotFoundException('Không tìm thấy đơn');
      const update = buildUpdate(order);
      const updated = await this.orderModel
        .findOneAndUpdate(
          {
            _id: order._id,
            sessionId: order.sessionId,
            status: order.status,
            __v: order.__v ?? { $exists: false },
          },
          { ...update, $inc: { __v: 1 } },
          { returnDocument: 'after', runValidators: true },
        )
        .exec();
      if (updated) return updated;
      // Retry only a competing write. Validation and database errors propagate;
      // failed comparisons never write either state or history.
    }
    throw new ConflictException('Đơn vừa thay đổi, vui lòng thử lại');
  }
}
