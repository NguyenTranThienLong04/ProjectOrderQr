import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { frontendUrl } from '../../common/config/public-urls';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { SessionStatus } from '../../common/enums/session-status.enum';
import { TableStatus } from '../../common/enums/table-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { lifecycleTransaction } from '../session/lifecycle-transaction';
import { AppGateway } from '../../gateway/app.gateway';
import { InvoiceLookupService } from '../invoice/invoice-lookup.service';
import { ensureInvoiceCode, withInvoiceCodeRetry } from './invoice-code';
import { Order, OrderDocument } from '../order/order.schema';
import { OrderStateMachineService } from '../order/order-state-machine.service';
import { Session, SessionDocument } from '../session/session.schema';
import { Table, TableDocument } from '../table/table.schema';
import {
  PaymentIntent,
  PaymentIntentDocument,
  PaymentIntentStatus,
  UNRESOLVED_PAYMENT_FILTER,
} from './payment-intent.schema';

type VnpayParams = Record<string, string | undefined>;
type IpnResponse = { RspCode: string; Message: string };

interface SessionOrderSummary {
  orderId: string;
  orderNumber: number;
  status: OrderStatus;
  itemCount: number;
  items: {
    dishName: string;
    nameEn?: string;
    imageUrl?: string;
    unitPrice: number;
    quantity: number;
    note?: string;
  }[];
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
  promotionCode?: string;
  createdAt?: Date;
}

export interface SessionPaymentSummary {
  sessionId: string;
  tableId: string;
  tableIds: string[];
  tableCode: string;
  sessionOrderCount: number;
  orderCount: number;
  itemCount: number;
  subtotalAmount: number;
  discountAmount: number;
  payableTotal: number;
  canPay: boolean;
  fullyPaid: boolean;
  eligibilityMessage: string;
  orders: SessionOrderSummary[];
  payableOrders: SessionOrderSummary[];
}

@Injectable()
export class VnpayService implements OnModuleInit {
  private readonly logger = new Logger(VnpayService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Session.name)
    private readonly sessionModel: Model<SessionDocument>,
    @InjectModel(Table.name) private readonly tableModel: Model<TableDocument>,
    @InjectModel(PaymentIntent.name)
    private readonly paymentIntentModel: Model<PaymentIntentDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly stateMachine: OrderStateMachineService,
    private readonly gateway: AppGateway,
    private readonly invoiceService: InvoiceLookupService,
  ) {}

  async onModuleInit() {
    // Never accept checkout traffic before the cross-instance constraints exist.
    // Existing ambiguous overlaps must be resolved before these indexes can build.
    try {
      await this.paymentIntentModel.createIndexes();
    } catch (error) {
      const failure = error as {
        code?: number;
        keyPattern?: Record<string, unknown>;
      };
      const index = failure.keyPattern?.sessionId
        ? 'one_unresolved_checkout_per_session'
        : failure.keyPattern?.coveredOrderIds
          ? 'one_unresolved_checkout_per_order'
          : 'PaymentIntent schema indexes';
      const message =
        `Cannot initialize payment_intents index ${index} (MongoDB code ${failure.code ?? 'unknown'}). ` +
        'Checkout remains unavailable. Run npm run migrate:payment-intents -- --help, ' +
        'back up and reconcile legacy unresolved payments before restarting; do not remove the uniqueness constraints.';
      this.logger.error(message);
      // Do not leak a driver message/URI or let checkout start without constraints.
      throw new Error(message);
    }
  }

  private getRequiredConfig(key: string): string {
    const value = this.config.get<string>(key)?.trim();
    if (!value) throw new BadRequestException(`Thiếu cấu hình ${key}`);
    return value;
  }

  /** Matches VNPAY's published NodeJS sample: encode values first, spaces as '+'. */
  private vnpEncode(value: string): string {
    return encodeURIComponent(value).replace(/%20/g, '+');
  }

  private sortedParams(params: VnpayParams): Record<string, string> {
    return Object.entries(params)
      .filter(
        ([key, value]) =>
          key.startsWith('vnp_') &&
          key !== 'vnp_SecureHash' &&
          key !== 'vnp_SecureHashType' &&
          value !== undefined &&
          value !== null,
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .reduce<Record<string, string>>((result, [key, value]) => {
        result[key] = this.vnpEncode(value!);
        return result;
      }, {});
  }

  private sortedData(params: VnpayParams): string {
    return Object.entries(this.sortedParams(params))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
  }

  private sign(params: VnpayParams): string {
    return createHmac('sha512', this.getRequiredConfig('VNP_HASH_SECRET'))
      .update(this.sortedData(params), 'utf8')
      .digest('hex');
  }

  private mask(value: string | undefined): string {
    if (!value) return '<missing>';
    return value.length <= 8
      ? '***'
      : `${value.slice(0, 4)}…${value.slice(-4)}`;
  }

  private logDiagnostics(
    stage: 'create' | 'return' | 'ipn',
    params: VnpayParams,
    secureHash?: string,
    paymentUrl?: string,
  ): void {
    if (this.config.get<string>('VNPAY_DEBUG') !== 'true') return;
    this.logger.debug({
      stage,
      env: {
        processTmnCode: process.env.VNP_TMN_CODE,
        configTmnCode: this.config.get<string>('VNP_TMN_CODE'),
        processHashSecret: this.mask(process.env.VNP_HASH_SECRET),
        configHashSecret: this.mask(this.config.get<string>('VNP_HASH_SECRET')),
      },
      paramsBeforeSort: params,
      paramsAfterSort: this.sortedParams(params),
      signData: this.sortedData(params),
      secureHash,
      paymentUrl,
    });
  }

  private normalizeClientIp(ipAddress: string): string {
    const firstAddress = ipAddress.split(',')[0]?.trim() || '127.0.0.1';
    if (firstAddress === '::1') return '127.0.0.1';
    const ipv4Mapped = firstAddress.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    return ipv4Mapped?.[1] ?? firstAddress;
  }

  verifySignature(
    params: VnpayParams,
    diagnosticStage?: 'return' | 'ipn',
  ): boolean {
    if (
      Object.entries(params).some(
        ([key, value]) =>
          key.startsWith('vnp_') &&
          value !== undefined &&
          typeof value !== 'string',
      )
    )
      return false;
    const received = params.vnp_SecureHash;
    if (!received || !/^[a-fA-F0-9]{128}$/.test(received)) return false;
    const expected = this.sign(params);
    if (diagnosticStage) this.logDiagnostics(diagnosticStage, params, expected);
    return timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(received, 'hex'),
    );
  }

  private assertObjectIds(sessionId: string, tableId: string): void {
    if (
      !Types.ObjectId.isValid(sessionId) ||
      !Types.ObjectId.isValid(tableId)
    ) {
      throw new NotFoundException('Không tìm thấy phiên ăn thuộc bàn này');
    }
  }

  private async assertOwnedActiveSession(
    sessionId: string,
    tableId: string,
    mongoSession?: ClientSession,
  ): Promise<{ session: SessionDocument; table: TableDocument }> {
    this.assertObjectIds(sessionId, tableId);
    const sessionObjectId = new Types.ObjectId(sessionId);
    const tableObjectId = new Types.ObjectId(tableId);
    const session = await this.sessionModel
      .findOne({
        _id: sessionObjectId,
        status: SessionStatus.ACTIVE,
        $or: [{ tableId: tableObjectId }, { tableIds: tableObjectId }],
      })
      .session(mongoSession ?? null)
      .exec();
    const table = await this.tableModel
      .findOne({ _id: tableObjectId, currentSessionId: sessionObjectId })
      .session(mongoSession ?? null)
      .exec();
    if (!session || !table)
      throw new NotFoundException('Không tìm thấy phiên ăn thuộc bàn này');
    return { session, table };
  }

  private createdAt(order: OrderDocument): Date | undefined {
    return (order as OrderDocument & { createdAt?: Date }).createdAt;
  }

  private subtotalSnapshot(order: OrderDocument): number {
    if (Number.isSafeInteger(order.subtotalAmount) && order.subtotalAmount > 0)
      return order.subtotalAmount;
    return order.items.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0,
    );
  }

  private summarizeOrder(
    order: OrderDocument,
    orderNumber: number,
  ): SessionOrderSummary {
    const subtotalAmount = this.subtotalSnapshot(order);
    const discountAmount =
      Number.isSafeInteger(order.discountAmount) && order.discountAmount > 0
        ? order.discountAmount
        : Math.max(0, subtotalAmount - order.totalAmount);
    return {
      orderId: order.id,
      orderNumber,
      status: order.status,
      itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      items: order.items.map((item) => ({
        dishName: item.dishName,
        nameEn: item.nameEn,
        imageUrl: item.imageUrl,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        note: item.note,
      })),
      subtotalAmount,
      discountAmount,
      totalAmount: order.totalAmount,
      promotionCode: order.promotionCode,
      createdAt: this.createdAt(order),
    };
  }

  private async loadSessionBilling(
    sessionId: string,
    tableId: string,
    mongoSession?: ClientSession,
  ) {
    const ownership = await this.assertOwnedActiveSession(
      sessionId,
      tableId,
      mongoSession,
    );
    const orderDocuments = await this.orderModel
      .find({ sessionId: ownership.session._id })
      .sort({ createdAt: 1 })
      .session(mongoSession ?? null)
      .exec();
    const orders = orderDocuments.map((order, index) =>
      this.summarizeOrder(order, index + 1),
    );
    const payableDocuments = orderDocuments.filter(
      (order) =>
        order.status !== OrderStatus.PAID &&
        order.status !== OrderStatus.CANCELLED,
    );
    const payableIds = new Set(payableDocuments.map((order) => order.id));
    const payableOrders = orders.filter((order) =>
      payableIds.has(order.orderId),
    );
    const canPay =
      payableDocuments.length > 0 &&
      payableDocuments.every(
        (order) =>
          order.status === OrderStatus.SERVED &&
          order.items.every((item) => item.status === OrderStatus.SERVED),
      );
    const nonCancelledOrders = orderDocuments.filter(
      (order) => order.status !== OrderStatus.CANCELLED,
    );
    const fullyPaid =
      nonCancelledOrders.length > 0 && payableDocuments.length === 0;
    const eligibilityMessage = fullyPaid
      ? 'Toàn bộ lượt gọi món trong phiên đã được thanh toán.'
      : payableDocuments.length === 0
        ? 'Phiên ăn chưa có lượt gọi món cần thanh toán.'
        : canPay
          ? 'Toàn bộ món chưa thanh toán đã được phục vụ.'
          : 'Chỉ có thể thanh toán khi toàn bộ món chưa thanh toán đã được phục vụ.';
    const tableIds = (
      ownership.session.tableIds?.length
        ? ownership.session.tableIds
        : [ownership.session.tableId]
    ).map((id) => id.toString());
    const summary: SessionPaymentSummary = {
      sessionId: ownership.session.id,
      tableId: ownership.table.id,
      tableIds,
      tableCode: ownership.table.tableCode,
      sessionOrderCount: nonCancelledOrders.length,
      orderCount: payableOrders.length,
      itemCount: payableOrders.reduce((sum, order) => sum + order.itemCount, 0),
      subtotalAmount: payableOrders.reduce(
        (sum, order) => sum + order.subtotalAmount,
        0,
      ),
      discountAmount: payableOrders.reduce(
        (sum, order) => sum + order.discountAmount,
        0,
      ),
      // Payment authority is always the immutable Order.totalAmount snapshot.
      payableTotal: payableOrders.reduce(
        (sum, order) => sum + order.totalAmount,
        0,
      ),
      canPay,
      fullyPaid,
      eligibilityMessage,
      orders,
      payableOrders,
    };
    return { ...ownership, orderDocuments, payableDocuments, summary };
  }

  async getSessionPaymentSummary(
    sessionId: string,
    tableId: string,
  ): Promise<SessionPaymentSummary> {
    return (await this.loadSessionBilling(sessionId, tableId)).summary;
  }

  private async cashBilling(tableId: string, mongoSession?: ClientSession) {
    if (!Types.ObjectId.isValid(tableId))
      throw new NotFoundException('Không tìm thấy bàn');
    const table = await this.tableModel
      .findById(tableId)
      .session(mongoSession ?? null)
      .exec();
    if (!table?.currentSessionId)
      throw new ConflictException('Bàn không có phiên đang hoạt động');
    const billing = await this.loadSessionBilling(
      table.currentSessionId.toString(),
      tableId,
      mongoSession,
    );
    const paidByProvider = await this.paymentIntentModel
      .exists({
        status: PaymentIntentStatus.SUCCEEDED,
        paymentMethod: 'vnpay',
        $or: [
          { sessionId: billing.session._id },
          {
            coveredOrderIds: {
              $in: billing.orderDocuments.map((order) => order._id),
            },
          },
        ],
      })
      .session(mongoSession ?? null)
      .exec();
    if (paidByProvider)
      throw new ConflictException(
        'VNPAY đã xác nhận thanh toán; không thể thu tiền mặt cho phiên này',
      );
    if (billing.session.cart.length)
      throw new ConflictException(
        'Phải xử lý giỏ hàng trước khi thanh toán tiền mặt',
      );
    if (!billing.summary.canPay)
      throw new ConflictException(billing.summary.eligibilityMessage);
    return billing;
  }

  private cashConfirmationKey(orders: OrderDocument[]) {
    // A cancellation can change the bill without changing Session.version.
    return createHash('sha256')
      .update(
        JSON.stringify(
          orders
            .map((order) => [order.id, order.totalAmount])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ),
      )
      .digest('hex');
  }

  async getCashSettlementSummary(
    tableId: string,
  ): Promise<
    SessionPaymentSummary & { sessionVersion: number; confirmationKey: string }
  > {
    const billing = await this.cashBilling(tableId);
    return {
      ...billing.summary,
      sessionVersion: billing.session.version,
      confirmationKey: this.cashConfirmationKey(billing.payableDocuments),
    };
  }

  async settleCash(
    tableId: string,
    expected: {
      sessionId: string;
      sessionVersion: number;
      confirmationKey: string;
    },
    actor: { id: string; role: UserRole },
  ) {
    if (
      ![UserRole.ADMIN, UserRole.WAITER].includes(actor.role) ||
      !Types.ObjectId.isValid(actor.id)
    )
      throw new ForbiddenException('Chỉ Admin/Waiter được xác nhận tiền mặt');
    const result = await withInvoiceCodeRetry((invoiceCode) =>
      lifecycleTransaction(this.connection, async (mongoSession) => {
        const billing = await this.cashBilling(tableId, mongoSession);
        const { session, summary } = billing;
        if (
          session.id !== expected.sessionId ||
          session.version !== expected.sessionVersion ||
          this.cashConfirmationKey(billing.payableDocuments) !==
            expected.confirmationKey
        )
          throw new ConflictException(
            'Phiên vừa thay đổi; hãy tải lại số tiền trước khi xác nhận',
          );
        const tableIds = session.tableIds?.length
          ? session.tableIds
          : [session.tableId];
        const owned = await this.tableModel
          .find({ currentSessionId: session._id })
          .session(mongoSession)
          .exec();
        if (
          owned.length !== tableIds.length ||
          !tableIds.some((id) => id.equals(session.tableId)) ||
          owned.some((member) => !tableIds.some((id) => id.equals(member._id)))
        )
          throw new ConflictException('Liên kết phiên và bàn không còn khớp');
        const coveredOrderIds = billing.payableDocuments.map(
          (order) => order._id,
        );
        const unresolved = await this.paymentIntentModel
          .find({
            $and: [
              UNRESOLVED_PAYMENT_FILTER,
              {
                $or: [
                  { sessionId: session._id },
                  {
                    coveredOrderIds: {
                      $in: billing.orderDocuments.map((order) => order._id),
                    },
                  },
                ],
              },
            ],
          })
          .session(mongoSession)
          .exec();
        if (
          unresolved.some(
            (intent) =>
              !intent.sessionId.equals(session._id) ||
              !intent.coveredOrderIds.length ||
              intent.coveredOrderIds.some(
                (id) => !coveredOrderIds.some((covered) => covered.equals(id)),
              ),
          )
        )
          throw new ConflictException(
            'Checkout không khớp các đơn cần thanh toán; cần kiểm tra trước khi thu tiền',
          );

        const now = new Date();
        // Shared write fence with cart/create-order/move/merge/clear. Never retry
        // the staff confirmation against a newer session snapshot.
        const closed = await this.sessionModel
          .updateOne(
            {
              _id: session._id,
              status: SessionStatus.ACTIVE,
              version: expected.sessionVersion,
              cart: { $size: 0 },
            },
            {
              $set: { status: SessionStatus.CLOSED, endedAt: now },
              $inc: { version: 1 },
            },
            { session: mongoSession },
          )
          .exec();
        if (closed.modifiedCount !== 1)
          throw new ConflictException('Phiên vừa thay đổi');
        const paidOrders = await this.stateMachine.transitionManyToPaid(
          coveredOrderIds,
          session._id,
          {
            triggeredBy: 'cash_settlement',
            actor,
            amount: summary.payableTotal,
          },
          mongoSession,
        );
        // A separate receipt preserves the original VNPAY identity/provider facts.
        const receipt = await new this.paymentIntentModel({
          invoiceCode,
          txnRef: `CASH-${new Types.ObjectId().toString()}`,
          coverageKey: `cash:${session.id}:${coveredOrderIds.map(String).sort().join('.')}`,
          sessionId: session._id,
          tableId: billing.table._id,
          coveredOrderIds,
          amount: summary.payableTotal,
          paymentMethod: 'CASH',
          paymentUrl: 'about:blank',
          status: PaymentIntentStatus.SUCCEEDED,
          ipnConfirmed: false,
          expiresAt: now,
          completedAt: now,
          settledByUserId: actor.id,
          settledByRole: actor.role,
        }).save({ session: mongoSession });
        if (unresolved.length) {
          const resolved = await this.paymentIntentModel
            .updateMany(
              {
                _id: { $in: unresolved.map((intent) => intent._id) },
                ...UNRESOLVED_PAYMENT_FILTER,
              },
              {
                $set: {
                  status: PaymentIntentStatus.SUPERSEDED,
                  resolutionSource: 'cash_settlement',
                  supersededByPaymentId: receipt._id,
                  resolvedAt: now,
                },
              },
              { session: mongoSession },
            )
            .exec();
          if (resolved.modifiedCount !== unresolved.length)
            throw new ConflictException('Checkout vừa thay đổi');
        }
        const released = await this.tableModel
          .updateMany(
            { _id: { $in: tableIds }, currentSessionId: session._id },
            {
              $set: {
                status: TableStatus.AVAILABLE,
                currentSessionId: null,
                groupedWithTableIds: [],
                groupRootTableId: null,
                groupedAt: null,
              },
              $inc: { __v: 1 },
            },
            { session: mongoSession },
          )
          .exec();
        if (released.modifiedCount !== tableIds.length)
          throw new ConflictException('Bàn vừa thay đổi');
        return { receipt, paidOrders, tableIds: tableIds.map(String) };
      }),
    );
    await this.notifySettlement(result.receipt, result.paidOrders);
    return {
      sessionId: result.receipt.sessionId.toString(),
      tableIds: result.tableIds,
      invoiceCode: result.receipt.invoiceCode,
      amount: result.receipt.amount,
      paymentMethod: 'CASH' as const,
    };
  }

  async createPaymentUrl(
    sessionId: string,
    tableId: string,
    ipAddress: string,
  ): Promise<{
    paymentUrl: string;
    txnRef: string;
    amount: number;
    coveredOrderIds: string[];
  }> {
    let coverageKey: string | undefined;
    try {
      const result = await withInvoiceCodeRetry((invoiceCode) =>
        this.connection.transaction(
          async (mongoSession) => {
            const billing = await this.loadSessionBilling(
              sessionId,
              tableId,
              mongoSession,
            );
            const coveredOrderIds = billing.payableDocuments.map(
              (order) => order._id,
            );
            coverageKey = `${billing.session.id}:${coveredOrderIds.map(String).sort().join('.')}`;
            const existing = await this.paymentIntentModel
              .findOne({
                sessionId: billing.session._id,
                ...UNRESOLVED_PAYMENT_FILTER,
              })
              .session(mongoSession)
              .exec();
            if (existing)
              return {
                intent: this.reuseCheckout(existing, coverageKey),
                paidOrders: [],
              };
            // A retry after a zero settlement returns the persisted receipt.
            if (billing.summary.fullyPaid) {
              const settled = await this.paymentIntentModel
                .findOne({
                  sessionId: billing.session._id,
                  status: PaymentIntentStatus.SUCCEEDED,
                  paymentMethod: 'internal_zero',
                })
                .sort({ createdAt: -1 })
                .session(mongoSession)
                .exec();
              if (settled) return { intent: settled, paidOrders: [] };
            }
            if (!billing.summary.canPay)
              throw new BadRequestException(billing.summary.eligibilityMessage);
            const amount = billing.summary.payableTotal;
            if (
              !Number.isSafeInteger(amount * 100) ||
              amount < 0 ||
              billing.payableDocuments.some(
                (order) =>
                  !Number.isSafeInteger(order.totalAmount) ||
                  order.totalAmount < 0,
              )
            )
              throw new BadRequestException(
                'Tổng tiền phiên ăn không hợp lệ để thanh toán',
              );

            // Fence the snapshot against concurrent payment/cancel/ownership writes.
            // A mere transactional read would permit a stale checkout after IPN commit.
            const claimed = await this.orderModel
              .updateMany(
                {
                  _id: { $in: coveredOrderIds },
                  sessionId: billing.session._id,
                  status: OrderStatus.SERVED,
                },
                { $inc: { __v: 1 } },
                { session: mongoSession },
              )
              .exec();
            if (claimed.modifiedCount !== coveredOrderIds.length)
              throw new ConflictException('Đơn vừa thay đổi, vui lòng thử lại');

            const now = new Date();
            const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
            const txnRef = `${billing.session.id}${Date.now()}${randomBytes(3).toString('hex')}`;
            const paymentUrl =
              amount === 0
                ? `${frontendUrl()}/menu?tableId=${billing.table.id}`
                : this.providerPaymentUrl(
                    txnRef,
                    billing.session.id,
                    amount,
                    ipAddress,
                    now,
                    expiresAt,
                  );
            const intent = await new this.paymentIntentModel({
              invoiceCode,
              txnRef,
              coverageKey,
              sessionId: billing.session._id,
              tableId: billing.table._id,
              coveredOrderIds,
              amount,
              paymentMethod: amount === 0 ? 'internal_zero' : 'vnpay',
              paymentUrl,
              status: PaymentIntentStatus.PENDING,
              expiresAt,
            }).save({ session: mongoSession });
            return amount === 0
              ? this.settleIntent(intent, 'internal_zero', mongoSession)
              : { intent, paidOrders: [] };
          },
          {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
          },
        ),
      );
      if (result.paidOrders.length)
        await this.notifySettlement(result.intent, result.paidOrders);
      return this.checkoutResult(result.intent, tableId);
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const winner = await this.paymentIntentModel
        .findOne({
          sessionId: new Types.ObjectId(sessionId),
          ...UNRESOLVED_PAYMENT_FILTER,
        })
        .exec();
      if (winner)
        return this.checkoutResult(
          this.reuseCheckout(winner, coverageKey!),
          tableId,
        );
      throw new ConflictException(
        'Một đơn đang thuộc checkout khác; vui lòng kiểm tra trạng thái thanh toán',
      );
    }
  }

  private reuseCheckout(intent: PaymentIntentDocument, coverageKey: string) {
    if (
      intent.coverageKey !== coverageKey ||
      intent.status !== PaymentIntentStatus.PENDING ||
      intent.expiresAt.getTime() <= Date.now()
    )
      throw new ConflictException(
        'Checkout trước chưa được VNPAY xác nhận; chưa thể tạo checkout mới',
      );
    return intent;
  }

  private checkoutResult(intent: PaymentIntentDocument, tableId: string) {
    return {
      // A merged-session retry may come from another authorized physical table.
      paymentUrl:
        intent.paymentMethod === 'internal_zero'
          ? `${frontendUrl()}/menu?tableId=${tableId}`
          : intent.paymentUrl,
      txnRef: intent.txnRef,
      amount: intent.amount,
      coveredOrderIds: intent.coveredOrderIds.map((id) => id.toString()),
    };
  }

  private providerPaymentUrl(
    txnRef: string,
    sessionId: string,
    amount: number,
    ipAddress: string,
    now: Date,
    expiresAt: Date,
  ) {
    const params: VnpayParams = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: this.getRequiredConfig('VNP_TMN_CODE'),
      vnp_Amount: String(amount * 100),
      vnp_CurrCode: 'VND',
      vnp_TxnRef: txnRef,
      vnp_OrderInfo: `Thanh toan phien ${sessionId}`,
      vnp_OrderType: 'other',
      vnp_Locale: 'vn',
      vnp_ReturnUrl: this.getRequiredConfig('VNP_RETURN_URL'),
      vnp_IpAddr: this.normalizeClientIp(ipAddress),
      vnp_CreateDate: this.vnpDate(now),
      vnp_ExpireDate: this.vnpDate(expiresAt),
    };
    const secureHash = this.sign(params);
    const url = `${this.getRequiredConfig('VNP_URL')}?${this.sortedData(params)}&vnp_SecureHash=${secureHash}`;
    this.logDiagnostics('create', params, secureHash, url);
    return url;
  }

  async handleReturn(params: VnpayParams): Promise<{
    txnRef: string;
    sessionId: string;
    tableId: string;
  } | null> {
    const txnRef = params.vnp_TxnRef;
    if (!txnRef) return null;
    const intent = await this.paymentIntentModel.findOne({ txnRef }).exec();
    if (!intent) return null;
    // Browser navigation is informational, never proof that a charge failed.
    return {
      txnRef: intent.txnRef,
      sessionId: intent.sessionId.toString(),
      tableId: intent.tableId.toString(),
    };
  }

  private async findOwnedIntent(
    txnRef: string,
    sessionId: string,
    tableId: string,
  ): Promise<PaymentIntentDocument> {
    this.assertObjectIds(sessionId, tableId);
    const intent = await this.paymentIntentModel
      .findOne({
        txnRef,
        sessionId: new Types.ObjectId(sessionId),
        tableId: new Types.ObjectId(tableId),
      })
      .exec();
    if (!intent)
      throw new ForbiddenException('Bạn không có quyền truy cập giao dịch này');
    return intent;
  }

  async getPaymentStatus(txnRef: string, sessionId: string, tableId: string) {
    const intent = await this.findOwnedIntent(txnRef, sessionId, tableId);
    const status =
      intent.status === PaymentIntentStatus.PROVIDER_REJECTED
        ? PaymentIntentStatus.FAILED
        : intent.status === PaymentIntentStatus.FAILED && !intent.ipnConfirmed
          ? PaymentIntentStatus.PENDING
          : intent.status;
    return {
      invoiceCode:
        intent.status === PaymentIntentStatus.SUCCEEDED
          ? await ensureInvoiceCode(this.paymentIntentModel, intent)
          : intent.invoiceCode,
      txnRef: intent.txnRef,
      sessionId: intent.sessionId.toString(),
      status,
      amount: intent.amount,
      coveredOrderIds: intent.coveredOrderIds.map((id) => id.toString()),
      completedAt:
        status === PaymentIntentStatus.PENDING ? null : intent.completedAt,
      transactionNo: intent.transactionNo,
    };
  }

  async generateSessionInvoice(
    txnRef: string,
    sessionId: string,
    tableId: string,
  ): Promise<Buffer> {
    return (await this.generateSessionInvoiceFile(txnRef, sessionId, tableId))
      .pdf;
  }

  async generateSessionInvoiceFile(
    txnRef: string,
    sessionId: string,
    tableId: string,
  ) {
    const intent = await this.findOwnedIntent(txnRef, sessionId, tableId);
    if (intent.status !== PaymentIntentStatus.SUCCEEDED)
      throw new ForbiddenException(
        'Chỉ có thể tải hóa đơn sau khi giao dịch đã được xác nhận',
      );
    return this.invoiceService.file(await this.invoiceService.detail(intent));
  }

  async handleIpn(params: VnpayParams): Promise<IpnResponse> {
    try {
      if (
        !this.verifySignature(params, 'ipn') ||
        params.vnp_TmnCode !== this.getRequiredConfig('VNP_TMN_CODE')
      )
        return { RspCode: '97', Message: 'Invalid signature' };
      if (!params.vnp_TxnRef)
        return { RspCode: '01', Message: 'Payment intent not found' };
      const success =
        params.vnp_ResponseCode === '00' &&
        params.vnp_TransactionStatus === '00';
      const failure =
        /^\d{2}$/.test(params.vnp_ResponseCode ?? '') &&
        params.vnp_ResponseCode !== '00' &&
        params.vnp_TransactionStatus === '02';
      if (
        (!success && !failure) ||
        !/^\d+$/.test(params.vnp_TransactionNo ?? '') ||
        (success && /^0+$/.test(params.vnp_TransactionNo!))
      )
        return { RspCode: '99', Message: 'Unresolved provider result' };

      const result = await this.connection.transaction(
        async (
          mongoSession,
        ): Promise<{
          response: IpnResponse;
          intent?: PaymentIntentDocument;
          paidOrders?: OrderDocument[];
        }> => {
          const intent = await this.paymentIntentModel
            .findOne({ txnRef: params.vnp_TxnRef })
            .session(mongoSession)
            .exec();
          if (
            !intent ||
            intent.paymentMethod !== 'vnpay' ||
            intent.amount === 0
          )
            return {
              response: { RspCode: '01', Message: 'Payment intent not found' },
            };
          const receivedAmount = Number(params.vnp_Amount);
          if (
            !/^\d+$/.test(params.vnp_Amount ?? '') ||
            !Number.isSafeInteger(receivedAmount) ||
            receivedAmount !== intent.amount * 100
          )
            return { response: { RspCode: '04', Message: 'Invalid amount' } };
          if (intent.status === PaymentIntentStatus.SUPERSEDED) {
            if (intent.ipnConfirmed) {
              const matches =
                intent.lateProviderStatus ===
                  (success ? 'succeeded' : 'failed') &&
                intent.responseCode === params.vnp_ResponseCode &&
                intent.transactionNo === params.vnp_TransactionNo;
              return {
                response: matches
                  ? { RspCode: '02', Message: 'Order already confirmed' }
                  : { RspCode: '99', Message: 'Conflicting provider result' },
              };
            }
            // This is a real receipt, never another Served -> Paid transition.
            // Cash remains authoritative; a late provider charge requires review/refund.
            const recorded = await this.paymentIntentModel
              .updateOne(
                {
                  _id: intent._id,
                  status: PaymentIntentStatus.SUPERSEDED,
                  ipnConfirmed: { $ne: true },
                },
                {
                  $set: {
                    ipnConfirmed: true,
                    responseCode: params.vnp_ResponseCode,
                    transactionNo: params.vnp_TransactionNo,
                    lateProviderStatus: success ? 'succeeded' : 'failed',
                    lateProviderReceivedAt: new Date(),
                    reconciliationRequired: success,
                  },
                },
                { session: mongoSession },
              )
              .exec();
            if (recorded.modifiedCount !== 1)
              throw new ConflictException('Giao dịch vừa thay đổi');
            if (success)
              this.logger.warn(
                `Late VNPAY charge after cash settlement requires reconciliation: ${intent.txnRef}`,
              );
            return { response: { RspCode: '00', Message: 'Confirm Success' } };
          }
          // A receipt after a verified pre-transaction rejection contradicts the
          // reconciliation. Preserve history/Orders and require operator review.
          if (intent.status === PaymentIntentStatus.PROVIDER_REJECTED) {
            this.logger.warn(
              `Provider result conflicts with reconciliation for ${intent.txnRef}`,
            );
            return {
              response: {
                RspCode: '99',
                Message: 'Conflicting provider result',
              },
            };
          }
          if (
            intent.status === PaymentIntentStatus.SUCCEEDED ||
            intent.ipnConfirmed
          ) {
            const matches =
              success === (intent.status === PaymentIntentStatus.SUCCEEDED) &&
              intent.responseCode === params.vnp_ResponseCode &&
              intent.transactionNo === params.vnp_TransactionNo;
            return {
              response: matches
                ? { RspCode: '02', Message: 'Order already confirmed' }
                : { RspCode: '99', Message: 'Conflicting provider result' },
            };
          }
          // Local expiry and browser failures do not veto a verified late receipt.
          if (success)
            return {
              response: { RspCode: '00', Message: 'Confirm Success' },
              ...(await this.settleIntent(
                intent,
                'vnpay_webhook',
                mongoSession,
                params.vnp_TransactionNo,
              )),
            };
          const updated = await this.paymentIntentModel
            .findOneAndUpdate(
              { _id: intent._id, ...UNRESOLVED_PAYMENT_FILTER },
              {
                $set: {
                  status: PaymentIntentStatus.FAILED,
                  ipnConfirmed: true,
                  responseCode: params.vnp_ResponseCode,
                  transactionNo: params.vnp_TransactionNo,
                  completedAt: new Date(),
                },
              },
              { returnDocument: 'after', session: mongoSession },
            )
            .exec();
          if (!updated) throw new ConflictException('Giao dịch vừa thay đổi');
          return { response: { RspCode: '00', Message: 'Confirm Success' } };
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
      if (result.intent && result.paidOrders)
        await this.notifySettlement(result.intent, result.paidOrders);
      return result.response;
    } catch (error) {
      this.logger.warn(
        `Could not confirm payment intent ${params.vnp_TxnRef}: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Includes DB read/write/commit failures. 99 keeps VNPAY's IPN retry active.
      return { RspCode: '99', Message: 'Temporary confirmation error' };
    }
  }

  private async settleIntent(
    intent: PaymentIntentDocument,
    source: 'vnpay_webhook' | 'internal_zero',
    mongoSession: ClientSession,
    transactionNo?: string,
  ) {
    const paidOrders = await this.stateMachine.transitionManyToPaid(
      intent.coveredOrderIds,
      intent.sessionId,
      { triggeredBy: source, transactionNo, amount: intent.amount },
      mongoSession,
    );
    const completed = await this.paymentIntentModel
      .findOneAndUpdate(
        { _id: intent._id, ...UNRESOLVED_PAYMENT_FILTER },
        {
          $set: {
            status: PaymentIntentStatus.SUCCEEDED,
            responseCode: '00',
            ipnConfirmed: source === 'vnpay_webhook',
            transactionNo,
            completedAt: new Date(),
          },
        },
        { returnDocument: 'after', session: mongoSession },
      )
      .exec();
    if (!completed) throw new ConflictException('Giao dịch vừa thay đổi');
    return { intent: completed, paidOrders };
  }

  private async notifySettlement(
    completedIntent: PaymentIntentDocument,
    paidOrders: OrderDocument[],
  ) {
    try {
      if (completedIntent.paymentMethod === 'CASH')
        await this.gateway.endCustomerSession(
          completedIntent.sessionId.toString(),
        );
      const session = await this.sessionModel
        .findById(completedIntent.sessionId)
        .exec();
      const tableIds = (
        session?.tableIds?.length
          ? session.tableIds
          : session
            ? [session.tableId]
            : [completedIntent.tableId]
      ).map((id) => id.toString());
      const rooms = [
        'waiter',
        'admin',
        `session:${completedIntent.sessionId.toString()}`,
        ...tableIds.map((id) => `table:${id}`),
      ];
      const paymentPayload = {
        txnRef: completedIntent.txnRef,
        sessionId: completedIntent.sessionId.toString(),
        status: PaymentIntentStatus.SUCCEEDED,
        amount: completedIntent.amount,
        paymentMethod: completedIntent.paymentMethod,
        coveredOrderIds: completedIntent.coveredOrderIds.map((id) =>
          id.toString(),
        ),
        transactionNo: completedIntent.transactionNo,
      };
      await this.gateway.emit(rooms, 'session:payment-updated', paymentPayload);
      for (const order of paidOrders) {
        await this.gateway.emit(rooms, 'order:paid', {
          ...paymentPayload,
          orderId: order.id,
          tableId: order.tableId.toString(),
        });
        await this.gateway.emit(rooms, 'order:updated', order);
      }
      await this.gateway.emit(['waiter', 'admin'], 'tables:updated');
    } catch (error) {
      // The receipt is already committed; notification errors cannot undo it.
      this.logger.warn(
        `Payment committed but notification failed: ${String(error)}`,
      );
    }
  }

  private vnpDate(date: Date): string {
    const vietnamDate = new Date(date.getTime() + 7 * 60 * 60 * 1000);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${vietnamDate.getUTCFullYear()}${pad(vietnamDate.getUTCMonth() + 1)}${pad(vietnamDate.getUTCDate())}${pad(vietnamDate.getUTCHours())}${pad(vietnamDate.getUTCMinutes())}${pad(vietnamDate.getUTCSeconds())}`;
  }
}
