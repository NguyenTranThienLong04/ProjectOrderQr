import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ActorType } from '../../common/enums/actor-type.enum';
import {
  OrderStatus,
  REJECTED_ITEM_STATUS,
} from '../../common/enums/order-status.enum';
import { TableStatus } from '../../common/enums/table-status.enum';
import { Dish, DishDocument } from '../dish/dish.schema';
import { SessionService } from '../session/session.service';
import { Session, SessionDocument } from '../session/session.schema';
import { SessionStatus } from '../../common/enums/session-status.enum';
import { Table, TableDocument } from '../table/table.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { Order, OrderDocument } from './order.schema';
import { PromotionService } from '../promotion/promotion.service';
import { ForbiddenException } from '@nestjs/common';
import { InvoiceService } from './invoice.service';
import { PROCESSING_ORDER_STATUSES } from './order-transition.rules';

@Injectable()
export class OrderService implements OnModuleInit {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Table.name) private readonly tableModel: Model<TableDocument>,
    @InjectModel(Dish.name) private readonly dishModel: Model<DishDocument>,
    @InjectModel(Session.name)
    private readonly sessionModel: Model<SessionDocument>,
    private readonly sessionService: SessionService,
    private readonly promotionService: PromotionService,
    private readonly invoiceService: InvoiceService,
  ) {}

  async onModuleInit() {
    // Wait for the unique index before accepting create-order requests.
    await this.orderModel.init();
  }

  async createCustomerOrder(createOrderDto: CreateOrderDto) {
    const { idempotencyKey } = createOrderDto;
    try {
      return await this.orderModel.db.transaction(
        async (mongoSession) => {
          const existing = await this.orderModel
            .findOne({ idempotencyKey })
            .session(mongoSession)
            .exec();
          if (existing)
            return this.createOrderResult(existing, createOrderDto, true);

          const table = await this.tableModel
            .findById(createOrderDto.tableId)
            .session(mongoSession)
            .exec();
          if (!table) {
            throw new NotFoundException('Không tìm thấy bàn');
          }
          // Claim exactly the submitted cart snapshot. Transaction retries cannot consume
          // a later cart, even if another device adds items after a competing commit.
          const session = await this.sessionService.consumeCartForOrder(
            table.id,
            createOrderDto.sessionId,
            createOrderDto.cartVersion,
            mongoSession,
          );
          const uniqueDishIds = [
            ...new Set(session.cart.map((item) => item.dishId.toString())),
          ];
          const dishes = await this.dishModel
            .find({ _id: { $in: uniqueDishIds }, isAvailable: true })
            .session(mongoSession)
            .exec();
          if (dishes.length !== uniqueDishIds.length) {
            throw new BadRequestException(
              'Một hoặc nhiều món không tồn tại hoặc đã hết món',
            );
          }
          const dishesById = new Map(
            dishes.map((dish) => [dish._id.toString(), dish]),
          );

          const now = new Date();
          const items = session.cart.map((item) => {
            const dish = dishesById.get(item.dishId.toString());
            if (!dish) throw new BadRequestException('Món ăn không hợp lệ');
            const statusHistory = [
              {
                fromStatus: null,
                toStatus: OrderStatus.PENDING,
                changedBy: {
                  actorType: ActorType.CUSTOMER,
                  sessionId: session._id,
                },
                changedAt: now,
              },
            ];
            return {
              dishId: item.dishId,
              // Re-snapshot from current Dish data after availability validation.
              dishName: dish.name,
              nameEn: dish.nameEn?.trim() || undefined,
              imageUrl: dish.imageUrl?.trim() || undefined,
              unitPrice: dish.price,
              quantity: item.quantity,
              note: item.note?.trim() || undefined,
              aiNoteAnalysis: item.aiNoteAnalysis,
              status: OrderStatus.PENDING,
              statusHistory,
            };
          });
          const subtotalAmount = items.reduce(
            (total, item) => total + item.unitPrice * item.quantity,
            0,
          );
          const appliedPromotion = await this.promotionService.reserveForOrder(
            createOrderDto.promotionCode,
            subtotalAmount,
            now,
            mongoSession,
          );
          const order = await new this.orderModel({
            idempotencyKey,
            cartVersion: createOrderDto.cartVersion,
            sessionId: session._id,
            tableId: table._id,
            items,
            status: OrderStatus.PENDING,
            statusHistory: [
              {
                fromStatus: null,
                toStatus: OrderStatus.PENDING,
                changedBy: {
                  actorType: ActorType.CUSTOMER,
                  sessionId: session._id,
                },
                changedAt: now,
              },
            ],
            subtotalAmount,
            discountAmount: appliedPromotion.discountAmount,
            promotionCode: appliedPromotion.code,
            promotionSnapshot: appliedPromotion.snapshot,
            totalAmount: appliedPromotion.totalAmount,
            note: createOrderDto.note?.trim(),
          }).save({ session: mongoSession });
          // A new Pending order reopens the active session for service, including
          // every physical table in a merged session.
          await this.tableModel
            .updateMany(
              { currentSessionId: session._id },
              { $set: { status: TableStatus.OCCUPIED } },
              { session: mongoSession },
            )
            .exec();

          return this.createOrderResult(order, createOrderDto, false);
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
    } catch (error) {
      // A unique-key race aborts the whole transaction. Read the committed winner
      // outside that aborted snapshot; all other failures retain their original error.
      if ((error as { code?: number }).code === 11000) {
        const existing = await this.orderModel
          .findOne({ idempotencyKey })
          .exec();
        if (existing)
          return this.createOrderResult(existing, createOrderDto, true);
      }
      throw error;
    }
  }

  private createOrderResult(
    order: OrderDocument,
    dto: CreateOrderDto,
    replayed: boolean,
  ) {
    if (
      !order.sessionId.equals(dto.sessionId) ||
      !order.tableId.equals(dto.tableId) ||
      order.cartVersion !== dto.cartVersion
    ) {
      throw new ConflictException(
        'Idempotency key đã được sử dụng cho giỏ hàng khác',
      );
    }
    return {
      orderId: order.id,
      sessionId: order.sessionId.toString(),
      tableId: order.tableId.toString(),
      status: order.status,
      subtotalAmount: order.subtotalAmount,
      discountAmount: order.discountAmount,
      promotionCode: order.promotionCode,
      totalAmount: order.totalAmount,
      createdAt: this.getCreatedAt(order),
      replayed,
    };
  }

  /** Returns orders (with filtered items) relevant for Kitchen UI */
  async listForKitchen() {
    const docs = await this.orderModel
      .find({
        status: { $in: PROCESSING_ORDER_STATUSES },
        'items.status': { $in: [OrderStatus.PENDING, OrderStatus.PREPARING] },
      })
      .sort({ createdAt: 1 })
      .exec();
    const tableCodes = await this.getTableCodes(docs);
    const tableDisplayNames = await this.getTableDisplayNames(docs, tableCodes);
    return docs.map((order) => ({
      orderId: order.id,
      tableId: order.tableId.toString(),
      tableCode: tableCodes.get(order.tableId.toString()) ?? 'Không rõ',
      tableDisplayName:
        tableDisplayNames.get(order.id) ??
        tableCodes.get(order.tableId.toString()) ??
        'Không rõ',
      items: order.items
        .filter(
          (it) =>
            it.status === OrderStatus.PENDING ||
            it.status === OrderStatus.PREPARING,
        )
        .map((it) => ({
          itemId: it._id.toString(),
          dishName: it.dishName,
          quantity: it.quantity,
          note: it.note,
          aiNoteAnalysis: it.aiNoteAnalysis,
          status: it.status,
        })),
      createdAt: this.getCreatedAt(order),
    }));
  }

  /** Returns orders (with filtered items) relevant for Waiter UI */
  async listForWaiter() {
    const activeSessions = await this.sessionModel
      .find({ status: SessionStatus.ACTIVE })
      .select('_id')
      .exec();
    const docs = await this.orderModel
      .find({
        $or: [
          {
            status: { $in: PROCESSING_ORDER_STATUSES },
            'items.status': OrderStatus.READY,
          },
          {
            sessionId: { $in: activeSessions.map((session) => session._id) },
            'items.status': REJECTED_ITEM_STATUS,
          },
        ],
      })
      .sort({ createdAt: 1 })
      .exec();
    const tableCodes = await this.getTableCodes(docs);
    const tableDisplayNames = await this.getTableDisplayNames(docs, tableCodes);
    return docs.map((order) => ({
      orderId: order.id,
      tableId: order.tableId.toString(),
      tableCode: tableCodes.get(order.tableId.toString()) ?? 'Không rõ',
      tableDisplayName:
        tableDisplayNames.get(order.id) ??
        tableCodes.get(order.tableId.toString()) ??
        'Không rõ',
      items: order.items
        .filter(
          (it) =>
            it.status === REJECTED_ITEM_STATUS ||
            (PROCESSING_ORDER_STATUSES.includes(order.status) &&
              it.status === OrderStatus.READY),
        )
        .map((it) => ({
          itemId: it._id.toString(),
          dishName: it.dishName,
          quantity: it.quantity,
          note: it.note,
          aiNoteAnalysis: it.aiNoteAnalysis,
          status: it.status,
          rejectionReason: it.rejectionReason,
          rejectedAt: it.rejectedAt,
        })),
      createdAt: this.getCreatedAt(order),
    }));
  }

  async getPaymentStatus(orderId: string, sessionId: string) {
    if (
      !Types.ObjectId.isValid(orderId) ||
      !Types.ObjectId.isValid(sessionId)
    ) {
      throw new NotFoundException('Không tìm thấy đơn thuộc phiên ăn này');
    }
    const order = await this.orderModel
      .findOne({
        _id: new Types.ObjectId(orderId),
        sessionId: new Types.ObjectId(sessionId),
      })
      .select('status totalAmount paidAt tableId')
      .exec();
    if (!order)
      throw new NotFoundException('Không tìm thấy đơn thuộc phiên ăn này');
    return {
      orderId: order.id,
      status: order.status,
      totalAmount: order.totalAmount,
      paidAt: order.paidAt,
      tableId: order.tableId.toString(),
    };
  }

  async generateInvoice(orderId: string, sessionId: string): Promise<Buffer> {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (order.sessionId.toString() !== sessionId)
      throw new ForbiddenException('Bạn không có quyền truy cập hóa đơn này');
    if (order.status !== OrderStatus.PAID)
      throw new ForbiddenException(
        'Chỉ có thể tải hóa đơn sau khi đơn đã thanh toán',
      );
    return this.invoiceService.render(order);
  }

  /** Derived from current-session Order.status; no additional TableStatus is needed. */
  async listPaymentSummariesForWaiter() {
    const sessions = await this.sessionModel
      .find({ status: SessionStatus.ACTIVE })
      .select('_id tableIds tableId')
      .exec();
    if (!sessions.length) return [];
    const orders = await this.orderModel
      .find({
        sessionId: { $in: sessions.map((session) => session._id) },
      })
      .select('sessionId status')
      .exec();
    const statusesBySession = new Map<string, OrderStatus[]>();
    for (const order of orders) {
      const key = order.sessionId.toString();
      statusesBySession.set(key, [
        ...(statusesBySession.get(key) ?? []),
        order.status,
      ]);
    }
    return sessions.flatMap((session) => {
      const orderStatuses = statusesBySession.get(session.id) ?? [];
      if (!orderStatuses.length) return [];
      const tableIds = session.tableIds?.length
        ? session.tableIds
        : [session.tableId];
      return tableIds.map((tableId) => ({
        tableId: tableId.toString(),
        orderStatuses,
        isPaid:
          orderStatuses.includes(OrderStatus.PAID) &&
          orderStatuses.every(
            (status) =>
              status === OrderStatus.PAID || status === OrderStatus.CANCELLED,
          ),
        canClear: orderStatuses.every(
          (status) =>
            status === OrderStatus.PAID || status === OrderStatus.CANCELLED,
        ),
      }));
    });
  }

  private async getTableCodes(
    orders: OrderDocument[],
  ): Promise<Map<string, string>> {
    const tableIds = [
      ...new Set(orders.map((order) => order.tableId.toString())),
    ];
    if (tableIds.length === 0) return new Map();
    const tables = await this.tableModel
      .find({ _id: { $in: tableIds } })
      .select('tableCode')
      .exec();
    return new Map(tables.map((table) => [table.id, table.tableCode]));
  }

  private async getTableDisplayNames(
    orders: OrderDocument[],
    sourceTableCodes: Map<string, string>,
  ): Promise<Map<string, string>> {
    if (!orders.length) return new Map();
    const sessionIds = [
      ...new Set(orders.map((order) => order.sessionId.toString())),
    ];
    const sessions = await this.sessionModel
      .find({ _id: { $in: sessionIds.map((id) => new Types.ObjectId(id)) } })
      .select('_id tableId tableIds')
      .exec();
    const sessionById = new Map(
      sessions.map((session) => [session.id, session]),
    );
    const currentTableIds = [
      ...new Set(
        sessions.flatMap((session) =>
          (session.tableIds?.length ? session.tableIds : [session.tableId]).map(
            (id) => id.toString(),
          ),
        ),
      ),
    ];
    const currentTables = await this.tableModel
      .find({ _id: { $in: currentTableIds } })
      .select('tableCode')
      .exec();
    const codes = new Map([
      ...sourceTableCodes,
      ...currentTables.map((table) => [table.id, table.tableCode] as const),
    ]);
    return new Map(
      orders.map((order) => {
        const session = sessionById.get(order.sessionId.toString());
        const ids = session
          ? session.tableIds?.length
            ? session.tableIds
            : [session.tableId]
          : [order.tableId];
        const displayName = ids
          .map((id) => codes.get(id.toString()))
          .filter((code): code is string => Boolean(code))
          .sort((a, b) => a.localeCompare(b))
          .join(' + ');
        return [
          order.id,
          displayName ||
            sourceTableCodes.get(order.tableId.toString()) ||
            'Không rõ',
        ];
      }),
    );
  }

  private getCreatedAt(order: OrderDocument): Date | undefined {
    return (order as OrderDocument & { createdAt?: Date }).createdAt;
  }
}
