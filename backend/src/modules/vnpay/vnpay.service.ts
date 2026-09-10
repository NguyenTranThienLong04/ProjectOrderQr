import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Connection, Model, Types } from 'mongoose';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { SessionStatus } from '../../common/enums/session-status.enum';
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
export class VnpayService {
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
  ): Promise<{ session: SessionDocument; table: TableDocument }> {
    this.assertObjectIds(sessionId, tableId);
    const sessionObjectId = new Types.ObjectId(sessionId);
    const tableObjectId = new Types.ObjectId(tableId);
    const [session, table] = await Promise.all([
      this.sessionModel
        .findOne({
          _id: sessionObjectId,
          status: SessionStatus.ACTIVE,
          $or: [{ tableId: tableObjectId }, { tableIds: tableObjectId }],
        })
        .exec(),
      this.tableModel
        .findOne({ _id: tableObjectId, currentSessionId: sessionObjectId })
        .exec(),
    ]);
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

  private async loadSessionBilling(sessionId: string, tableId: string) {
    const ownership = await this.assertOwnedActiveSession(sessionId, tableId);
    const orderDocuments = await this.orderModel
      .find({ sessionId: ownership.session._id })
      .sort({ createdAt: 1 })
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
    const billing = await this.loadSessionBilling(sessionId, tableId);
    if (!billing.summary.canPay) {
      throw new BadRequestException(billing.summary.eligibilityMessage);
    }
    if (
      !Number.isSafeInteger(billing.summary.payableTotal) ||
      billing.summary.payableTotal <= 0
    ) {
      throw new BadRequestException(
        'Tổng tiền phiên ăn không hợp lệ để thanh toán',
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    const coveredOrderIds = billing.payableDocuments.map((order) => order._id);
    const coverageKey = `${billing.session.id}:${coveredOrderIds
      .map((id) => id.toString())
      .sort()
      .join('.')}`;
    await this.paymentIntentModel
      .updateMany(
        {
          coverageKey,
          status: PaymentIntentStatus.PENDING,
          expiresAt: { $lte: now },
        },
        {
          $set: {
            status: PaymentIntentStatus.FAILED,
            responseCode: 'expired',
            completedAt: now,
          },
        },
      )
      .exec();
    const existingIntent = await this.paymentIntentModel
      .findOne({
        coverageKey,
        status: PaymentIntentStatus.PENDING,
        expiresAt: { $gt: now },
      })
      .exec();
    if (existingIntent) {
      return {
        paymentUrl: existingIntent.paymentUrl,
        txnRef: existingIntent.txnRef,
        amount: existingIntent.amount,
        coveredOrderIds: existingIntent.coveredOrderIds.map((id) =>
          id.toString(),
        ),
      };
    }
    const txnRef = `${billing.session.id}${Date.now()}${randomBytes(3).toString('hex')}`;
    const params: VnpayParams = {
      vnp_Version: '2.1.0',
      vnp_Command: 'pay',
      vnp_TmnCode: this.getRequiredConfig('VNP_TMN_CODE'),
      vnp_Amount: String(billing.summary.payableTotal * 100),
      vnp_CurrCode: 'VND',
      vnp_TxnRef: txnRef,
      vnp_OrderInfo: `Thanh toan phien ${billing.session.id}`,
      vnp_OrderType: 'other',
      vnp_Locale: 'vn',
      vnp_ReturnUrl: this.getRequiredConfig('VNP_RETURN_URL'),
      vnp_IpAddr: this.normalizeClientIp(ipAddress),
      vnp_CreateDate: this.vnpDate(now),
      vnp_ExpireDate: this.vnpDate(expiresAt),
    };
    const secureHash = this.sign(params);
    const paymentUrl = `${this.getRequiredConfig('VNP_URL')}?${this.sortedData(params)}&vnp_SecureHash=${secureHash}`;

    // Persist the exact cutoff before redirecting. A later Order in the same
    // Session is intentionally absent and can never be paid by this txnRef.
    let intent: PaymentIntentDocument;
    try {
      intent = await withInvoiceCodeRetry(
        (invoiceCode) =>
          new this.paymentIntentModel({
            invoiceCode,
            txnRef,
            coverageKey,
            sessionId: billing.session._id,
            tableId: billing.table._id,
            coveredOrderIds,
            amount: billing.summary.payableTotal,
            paymentUrl,
            status: PaymentIntentStatus.PENDING,
            expiresAt,
          }).save(),
        now,
      );
    } catch (error) {
      // The partial unique index makes two simultaneous checkout clicks converge
      // on the one intent that won the insert race.
      if ((error as { code?: number }).code !== 11000) throw error;
      const winner = await this.paymentIntentModel
        .findOne({ coverageKey, status: PaymentIntentStatus.PENDING })
        .exec();
      if (!winner) throw error;
      return {
        paymentUrl: winner.paymentUrl,
        txnRef: winner.txnRef,
        amount: winner.amount,
        coveredOrderIds: winner.coveredOrderIds.map((id) => id.toString()),
      };
    }
    this.logDiagnostics('create', params, secureHash, paymentUrl);
    return {
      paymentUrl,
      txnRef: intent.txnRef,
      amount: intent.amount,
      coveredOrderIds: intent.coveredOrderIds.map((id) => id.toString()),
    };
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
    if (
      params.vnp_ResponseCode !== '00' &&
      intent.status === PaymentIntentStatus.PENDING
    ) {
      await this.paymentIntentModel
        .updateOne(
          { _id: intent._id, status: PaymentIntentStatus.PENDING },
          {
            $set: {
              status: PaymentIntentStatus.FAILED,
              responseCode: params.vnp_ResponseCode ?? 'missing',
              completedAt: new Date(),
            },
          },
        )
        .exec();
    }
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
    return {
      invoiceCode:
        intent.status === PaymentIntentStatus.SUCCEEDED
          ? await ensureInvoiceCode(this.paymentIntentModel, intent)
          : intent.invoiceCode,
      txnRef: intent.txnRef,
      sessionId: intent.sessionId.toString(),
      status: intent.status,
      amount: intent.amount,
      coveredOrderIds: intent.coveredOrderIds.map((id) => id.toString()),
      completedAt: intent.completedAt,
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
    if (!this.verifySignature(params, 'ipn'))
      return { RspCode: '97', Message: 'Invalid signature' };
    const txnRef = params.vnp_TxnRef;
    if (!txnRef) return { RspCode: '01', Message: 'Payment intent not found' };
    const initialIntent = await this.paymentIntentModel
      .findOne({ txnRef })
      .exec();
    if (!initialIntent)
      return { RspCode: '01', Message: 'Payment intent not found' };
    if (initialIntent.status === PaymentIntentStatus.SUCCEEDED)
      return { RspCode: '02', Message: 'Order already confirmed' };

    const receivedAmount = Number(params.vnp_Amount);
    if (
      !Number.isSafeInteger(receivedAmount) ||
      receivedAmount !== initialIntent.amount * 100
    ) {
      this.logger.warn(
        `Rejected VNPAY IPN with invalid amount for intent ${txnRef}: ${params.vnp_Amount}`,
      );
      return { RspCode: '04', Message: 'Invalid amount' };
    }
    if (params.vnp_ResponseCode !== '00') {
      await this.paymentIntentModel
        .updateOne(
          { _id: initialIntent._id, status: PaymentIntentStatus.PENDING },
          {
            $set: {
              status: PaymentIntentStatus.FAILED,
              responseCode: params.vnp_ResponseCode ?? 'missing',
              completedAt: new Date(),
            },
          },
        )
        .exec();
      return { RspCode: '00', Message: 'Confirm Success' };
    }
    if (initialIntent.status !== PaymentIntentStatus.PENDING)
      return { RspCode: '02', Message: 'Order already confirmed' };

    let paidOrders: OrderDocument[] = [];
    try {
      await this.connection.transaction(async (mongoSession) => {
        const intent = await this.paymentIntentModel
          .findOne({
            _id: initialIntent._id,
            status: PaymentIntentStatus.PENDING,
          })
          .session(mongoSession)
          .exec();
        if (!intent)
          throw new BadRequestException('Giao dịch đã được xử lý trước đó');

        paidOrders = await this.stateMachine.transitionManyToPaid(
          intent.coveredOrderIds,
          intent.sessionId,
          {
            triggeredBy: 'vnpay_webhook',
            transactionNo: params.vnp_TransactionNo,
            amount: intent.amount,
          },
          mongoSession,
        );
        const changedAt = new Date();
        const update = await this.paymentIntentModel
          .findOneAndUpdate(
            { _id: intent._id, status: PaymentIntentStatus.PENDING },
            {
              $set: {
                status: PaymentIntentStatus.SUCCEEDED,
                responseCode: params.vnp_ResponseCode,
                transactionNo: params.vnp_TransactionNo,
                completedAt: changedAt,
              },
            },
            { new: true, session: mongoSession },
          )
          .exec();
        if (!update)
          throw new BadRequestException('Giao dịch đã được xử lý trước đó');
      });
    } catch (error) {
      const latest = await this.paymentIntentModel
        .findById(initialIntent._id)
        .exec();
      if (latest?.status === PaymentIntentStatus.SUCCEEDED)
        return { RspCode: '02', Message: 'Order already confirmed' };
      this.logger.warn(
        `Could not settle payment intent ${txnRef}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { RspCode: '02', Message: 'Order already confirmed' };
    }

    const completedIntent = await this.paymentIntentModel
      .findById(initialIntent._id)
      .exec();
    if (
      !completedIntent ||
      completedIntent.status !== PaymentIntentStatus.SUCCEEDED
    )
      return { RspCode: '02', Message: 'Order already confirmed' };
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
      `session:${completedIntent.sessionId.toString()}`,
      ...tableIds.map((id) => `table:${id}`),
    ];
    const paymentPayload = {
      txnRef: completedIntent.txnRef,
      sessionId: completedIntent.sessionId.toString(),
      status: PaymentIntentStatus.SUCCEEDED,
      amount: completedIntent.amount,
      coveredOrderIds: completedIntent.coveredOrderIds.map((id) =>
        id.toString(),
      ),
      transactionNo: completedIntent.transactionNo,
    };
    this.gateway.emit(rooms, 'session:payment-updated', paymentPayload);
    for (const order of paidOrders) {
      this.gateway.emit(rooms, 'order:paid', {
        ...paymentPayload,
        orderId: order.id,
        tableId: order.tableId.toString(),
      });
      this.gateway.emit(rooms, 'order:updated', order);
    }
    this.gateway.emit(['waiter', 'admin'], 'tables:updated');
    return { RspCode: '00', Message: 'Confirm Success' };
  }

  private vnpDate(date: Date): string {
    const vietnamDate = new Date(date.getTime() + 7 * 60 * 60 * 1000);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${vietnamDate.getUTCFullYear()}${pad(vietnamDate.getUTCMonth() + 1)}${pad(vietnamDate.getUTCDate())}${pad(vietnamDate.getUTCHours())}${pad(vietnamDate.getUTCMinutes())}${pad(vietnamDate.getUTCSeconds())}`;
  }
}
