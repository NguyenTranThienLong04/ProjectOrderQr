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
import {
  OrderStatus,
  OrderItemStatus,
  REJECTED_ITEM_STATUS,
} from '../../common/enums/order-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { Order, OrderDocument } from './order.schema';
import { Table, TableDocument } from '../table/table.schema';
import { TableStatus } from '../../common/enums/table-status.enum';
import {
  canTransitionOrder,
  ITEM_TRANSITIONS,
  orderSourcesFor,
  PROCESSING_ORDER_STATUSES,
  canRejectItem,
  isFinishedItem,
  TERMINAL_ITEM_STATUSES,
} from './order-transition.rules';
import { lifecycleTransaction } from '../session/lifecycle-transaction';
import {
  PaymentIntent,
  PaymentIntentDocument,
  UNRESOLVED_PAYMENT_FILTER,
} from '../vnpay/payment-intent.schema';
import { Session, SessionDocument } from '../session/session.schema';
import { SessionStatus } from '../../common/enums/session-status.enum';
import { billableSubtotal } from './order-billing';
import { promotionAmounts } from '../promotion/promotion-amounts';

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
    next: OrderItemStatus,
    actor: { id: string; role: UserRole },
    rejectionReason?: string,
  ) {
    if (next === REJECTED_ITEM_STATUS)
      return this.rejectItem(orderId, itemId, actor, rejectionReason);
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
      const set: Record<string, unknown> = { [`items.${index}.status`]: next };
      const push: Record<string, unknown> = {
        [`items.${index}.statusHistory`]: history,
      };
      // Compute from the version that will actually be committed. A competing
      // item transition makes the CAS fail and this calculation runs again.
      if (
        next === OrderStatus.SERVED &&
        current.items.every(
          (entry, i) => i === index || isFinishedItem(entry.status),
        )
      ) {
        set.status = OrderStatus.SERVED;
        push.statusHistory = {
          ...history,
          fromStatus: current.status,
        };
      }
      return { $set: set, $push: push };
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

  private async rejectItem(
    orderId: string,
    itemId: string,
    actor: { id: string; role: UserRole },
    rejectionReason?: string,
  ): Promise<OrderDocument> {
    if (actor.role !== UserRole.KITCHEN)
      throw new ForbiddenException('Chỉ bếp được từ chối món');
    const reason =
      typeof rejectionReason === 'string' ? rejectionReason.trim() : '';
    if (!reason || reason.length > 250)
      throw new BadRequestException('Lý do từ chối phải có từ 1 đến 250 ký tự');
    return lifecycleTransaction(this.orderModel.db, async (mongoSession) => {
      const current = await this.orderModel
        .findById(orderId)
        .session(mongoSession)
        .exec();
      if (!current) throw new NotFoundException('Không tìm thấy đơn');
      const index = current.items.findIndex(
        (item) => item._id.toString() === itemId,
      );
      if (index < 0)
        throw new NotFoundException('Không tìm thấy món trong đơn');
      const item = current.items[index];
      if (!canRejectItem(current.status, item.status, actor.role))
        throw new ForbiddenException(
          'Chỉ được từ chối món Pending trong đơn đang phục vụ',
        );

      // Share a document write with checkout/cart/lifecycle transactions so a
      // concurrent checkout cannot appear after the unresolved-intent read.
      const claimedSession = await this.orderModel.db
        .model<SessionDocument>(Session.name)
        .updateOne(
          { _id: current.sessionId, status: SessionStatus.ACTIVE },
          { $inc: { __v: 1 } },
          { session: mongoSession },
        )
        .exec();
      if (claimedSession.modifiedCount !== 1)
        throw new ConflictException('Phiên ăn không còn hoạt động');
      const unresolved = await this.orderModel.db
        .model<PaymentIntentDocument>(PaymentIntent.name)
        .exists({
          $and: [
            {
              $or: [
                { sessionId: current.sessionId },
                { coveredOrderIds: current._id },
              ],
            },
            UNRESOLVED_PAYMENT_FILTER,
          ],
        })
        .session(mongoSession);
      if (unresolved)
        throw new ConflictException(
          'Phiên đang có checkout chưa được xác nhận; chưa thể từ chối món',
        );
      if (
        (current.promotionCode || current.discountAmount > 0) &&
        !current.promotionSnapshot
      )
        throw new ConflictException(
          'Đơn cũ thiếu snapshot quy tắc giảm giá; chưa thể tính lại khi từ chối món',
        );

      const items = current.items.map((entry, i) => ({
        status: i === index ? REJECTED_ITEM_STATUS : entry.status,
        unitPrice: entry.unitPrice,
        quantity: entry.quantity,
      }));
      const amounts = promotionAmounts(
        current.promotionSnapshot,
        billableSubtotal(items),
      );
      const aggregate = items.every(
        (entry) => entry.status === REJECTED_ITEM_STATUS,
      )
        ? OrderStatus.CANCELLED
        : items.every((entry) => isFinishedItem(entry.status))
          ? OrderStatus.SERVED
          : current.status;
      const changedAt = new Date();
      const history = {
        fromStatus: item.status,
        toStatus: REJECTED_ITEM_STATUS,
        changedBy: {
          actorType: ActorType.USER,
          userId: new Types.ObjectId(actor.id),
          role: actor.role,
        },
        changedAt,
        note: reason,
        source: 'kitchen_reject',
        amount: amounts.totalAmount,
      };
      const updated = await this.orderModel
        .findOneAndUpdate(
          {
            _id: current._id,
            sessionId: current.sessionId,
            status: current.status,
            __v: current.__v ?? { $exists: false },
          },
          {
            $set: {
              [`items.${index}.status`]: REJECTED_ITEM_STATUS,
              [`items.${index}.rejectionReason`]: reason,
              [`items.${index}.rejectedBy`]: new Types.ObjectId(actor.id),
              [`items.${index}.rejectedAt`]: changedAt,
              ...amounts,
              status: aggregate,
            },
            $inc: { __v: 1 },
            $push: {
              [`items.${index}.statusHistory`]: history,
              ...(aggregate !== current.status
                ? {
                    statusHistory: {
                      ...history,
                      fromStatus: current.status,
                      toStatus: aggregate,
                    },
                  }
                : {}),
            },
          },
          {
            returnDocument: 'after',
            runValidators: true,
            session: mongoSession,
          },
        )
        .exec();
      if (!updated)
        throw new ConflictException('Món vừa thay đổi, vui lòng tải lại');
      if (
        aggregate === OrderStatus.SERVED ||
        aggregate === OrderStatus.CANCELLED
      ) {
        const unserved = await this.orderModel
          .exists({
            sessionId: current.sessionId,
            status: { $in: PROCESSING_ORDER_STATUSES },
          })
          .session(mongoSession);
        if (!unserved)
          await this.tableModel
            .updateMany(
              { currentSessionId: current.sessionId },
              { $set: { status: TableStatus.WAITING_PAYMENT } },
              { session: mongoSession },
            )
            .exec();
      }
      return updated;
    });
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
            $not: { $elemMatch: { status: { $nin: TERMINAL_ITEM_STATUSES } } },
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
          order.items.some((item) => !isFinishedItem(item.status)),
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
            $not: { $elemMatch: { status: { $nin: TERMINAL_ITEM_STATUSES } } },
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
