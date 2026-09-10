import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { Order, OrderDocument } from '../order/order.schema';
import { InvoiceService } from '../order/invoice.service';
import { Session, SessionDocument } from '../session/session.schema';
import { Table, TableDocument } from '../table/table.schema';
import {
  PaymentIntent,
  PaymentIntentDocument,
  PaymentIntentStatus,
} from '../vnpay/payment-intent.schema';
import {
  ensureInvoiceCode,
  INVOICE_CODE_PATTERN,
  invoiceFilename,
} from '../vnpay/invoice-code';
import { InvoiceDetailDto } from './dto/invoice.dto';

@Injectable()
export class InvoiceLookupService implements OnModuleInit {
  constructor(
    @InjectModel(PaymentIntent.name)
    private readonly intents: Model<PaymentIntentDocument>,
    @InjectModel(Order.name) private readonly orders: Model<OrderDocument>,
    @InjectModel(Session.name)
    private readonly sessions: Model<SessionDocument>,
    @InjectModel(Table.name) private readonly tables: Model<TableDocument>,
    private readonly pdf: InvoiceService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Do not serve writes until the database uniqueness authority is ready,
    // including deployments with Mongoose autoIndex disabled. Additive only.
    await this.intents.collection.createIndex(
      { invoiceCode: 1 },
      {
        unique: true,
        partialFilterExpression: { invoiceCode: { $type: 'string' } },
      },
    );
  }

  async lookup(input: string): Promise<InvoiceDetailDto> {
    const invoiceCode = input.trim().toUpperCase();
    if (!INVOICE_CODE_PATTERN.test(invoiceCode))
      throw new BadRequestException('Mã hóa đơn không hợp lệ');
    const intent = await this.intents.findOne({ invoiceCode }).exec();
    if (!intent) throw new NotFoundException('Không tìm thấy hóa đơn');
    return this.detail(intent);
  }

  async detail(intent: PaymentIntentDocument): Promise<InvoiceDetailDto> {
    const orders = await this.orders
      .find({
        _id: { $in: intent.coveredOrderIds },
        sessionId: intent.sessionId,
      })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
    if (orders.length !== intent.coveredOrderIds.length)
      throw new NotFoundException('Không tìm thấy đầy đủ đơn của hóa đơn');
    const session = await this.sessions.findById(intent.sessionId).exec();
    const tableIds = session?.tableIds?.length
      ? session.tableIds
      : [intent.tableId];
    const tables = await this.tables.find({ _id: { $in: tableIds } }).exec();
    const rounds = orders.map((order, index) => ({
      sequence: index + 1,
      items: order.items.map((item) => ({
        name: item.dishName,
        nameEn: item.nameEn,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        note: item.note,
      })),
      // Preserve the legacy subtotal fallback from immutable item snapshots.
      subtotalAmount:
        order.subtotalAmount ||
        order.items.reduce(
          (sum, item) => sum + item.unitPrice * item.quantity,
          0,
        ),
      discountAmount:
        order.discountAmount ||
        Math.max(
          0,
          (order.subtotalAmount || order.totalAmount) - order.totalAmount,
        ),
      totalAmount: order.totalAmount,
    }));
    const totalAmount = rounds.reduce(
      (sum, order) => sum + order.totalAmount,
      0,
    );
    if (totalAmount !== intent.amount)
      throw new ConflictException(
        'Số tiền hóa đơn không khớp snapshot thanh toán',
      );
    return {
      invoiceCode: await ensureInvoiceCode(this.intents, intent),
      paymentStatus: intent.status,
      paidAt:
        intent.status === PaymentIntentStatus.SUCCEEDED
          ? (intent.completedAt ?? intent.updatedAt ?? null)
          : null,
      table: {
        displayName:
          tables
            .map((table) => table.tableCode)
            .sort()
            .join(' + ') || 'Không còn thông tin bàn',
      },
      vnpTransactionNo: intent.transactionNo,
      orders: rounds,
      subtotalAmount: rounds.reduce(
        (sum, order) => sum + order.subtotalAmount,
        0,
      ),
      discountAmount: rounds.reduce(
        (sum, order) => sum + order.discountAmount,
        0,
      ),
      totalAmount,
    };
  }

  async file(
    detail: InvoiceDetailDto,
  ): Promise<{ pdf: Buffer; filename: string }> {
    if (detail.paymentStatus !== PaymentIntentStatus.SUCCEEDED)
      throw new ForbiddenException(
        'Chỉ có thể tải hóa đơn sau khi giao dịch đã được xác nhận',
      );
    return {
      pdf: await this.pdf.renderDetail(detail),
      filename: invoiceFilename(detail.invoiceCode),
    };
  }

  async legacyFile(
    orderId: string,
    sessionId: string,
  ): Promise<{ pdf: Buffer; filename: string }> {
    const order = await this.orders.findById(orderId).exec();
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (order.sessionId.toString() !== sessionId)
      throw new ForbiddenException('Bạn không có quyền truy cập hóa đơn này');
    if (order.status !== OrderStatus.PAID)
      throw new ForbiddenException(
        'Chỉ có thể tải hóa đơn sau khi đơn đã thanh toán',
      );
    const intent = await this.intents
      .findOne({
        coveredOrderIds: new Types.ObjectId(orderId),
        sessionId: order.sessionId,
        status: PaymentIntentStatus.SUCCEEDED,
      })
      .exec();
    if (intent) return this.file(await this.detail(intent));
    // Pre-Session-payment Orders have no PaymentIntent to identify. Keep their
    // historical PDF accessible without inventing a payment or exposing an ID.
    return {
      pdf: await this.pdf.render(order),
      filename: 'SmartOrder-invoice.pdf',
    };
  }
}
