import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { join } from 'path';
import { OrderDocument } from './order.schema';

const fontPath = join(__dirname, '../../../assets/fonts/NotoSans-Regular.ttf');
const currency = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
});

@Injectable()
export class InvoiceService {
  async render(order: OrderDocument): Promise<Buffer> {
    const document = new PDFDocument({ margin: 50, size: 'A4' });
    document.registerFont('NotoSans', fontPath);
    document.font('NotoSans');
    const chunks: Buffer[] = [];
    const result = new Promise<Buffer>((resolve, reject) => {
      document.on('data', (chunk: Buffer) => chunks.push(chunk));
      document.on('end', () => resolve(Buffer.concat(chunks)));
      document.on('error', reject);
    });

    document.fontSize(20).text('NHÀ HÀNG SMARTORDER', { align: 'center' });
    document
      .moveDown(0.5)
      .fontSize(10)
      .fillColor('#555555')
      .text('Hóa đơn điện tử', { align: 'center' });
    document.fillColor('#000000').moveDown(2);
    document.fontSize(11).text(`Mã đơn: ${order.id}`);
    document.text(
      `Thời gian: ${this.formatDate(order.paidAt ?? this.createdAt(order))}`,
    );
    document.moveDown();

    document.fontSize(12).text('Danh sách món', { underline: true });
    document.moveDown(0.5);
    for (const item of order.items) {
      const lineTotal = item.unitPrice * item.quantity;
      document
        .fontSize(10)
        .text(`${item.dishName} × ${item.quantity}`, { continued: true });
      document.text(currency.format(lineTotal), { align: 'right' });
      document
        .fillColor('#555555')
        .fontSize(9)
        .text(`Đơn giá: ${currency.format(item.unitPrice)}`);
      document.fillColor('#000000');
    }

    document.moveDown();
    const itemsSubtotal = order.items.reduce(
      (total, item) => total + item.unitPrice * item.quantity,
      0,
    );
    // Orders created before Phase 12 do not have a subtotal snapshot; derive it from their immutable item snapshots.
    const subtotalAmount = order.subtotalAmount || itemsSubtotal;
    document
      .fontSize(10)
      .text(`Tạm tính: ${currency.format(subtotalAmount)}`, { align: 'right' });
    if (order.discountAmount > 0) {
      const promotion = order.promotionCode ? ` (${order.promotionCode})` : '';
      document.text(
        `Giảm giá${promotion}: -${currency.format(order.discountAmount)}`,
        { align: 'right' },
      );
    }
    document
      .fontSize(13)
      .text(`Tổng thanh toán: ${currency.format(order.totalAmount)}`, {
        align: 'right',
      });
    document
      .moveDown(2)
      .fontSize(10)
      .fillColor('#555555')
      .text('Cảm ơn quý khách!', { align: 'center' });
    document.end();
    return result;
  }

  async renderSession(
    orders: OrderDocument[],
    payment: {
      sessionId: string;
      txnRef: string;
      transactionNo?: string;
      amount: number;
      paidAt: Date;
    },
  ): Promise<Buffer> {
    const document = new PDFDocument({ margin: 50, size: 'A4' });
    document.registerFont('NotoSans', fontPath);
    document.font('NotoSans');
    const chunks: Buffer[] = [];
    const result = new Promise<Buffer>((resolve, reject) => {
      document.on('data', (chunk: Buffer) => chunks.push(chunk));
      document.on('end', () => resolve(Buffer.concat(chunks)));
      document.on('error', reject);
    });

    document.fontSize(20).text('NHÀ HÀNG SMARTORDER', { align: 'center' });
    document
      .moveDown(0.5)
      .fontSize(10)
      .fillColor('#555555')
      .text('Hóa đơn tổng hợp phiên ăn', { align: 'center' });
    document.fillColor('#000000').moveDown(2);
    document.fontSize(10).text(`Mã phiên: ${payment.sessionId}`);
    document.text(`Mã giao dịch: ${payment.txnRef}`);
    if (payment.transactionNo)
      document.text(`Mã VNPAY: ${payment.transactionNo}`);
    document.text(`Thời gian: ${this.formatDate(payment.paidAt)}`);

    orders.forEach((order, orderIndex) => {
      document
        .moveDown(1.2)
        .fontSize(12)
        .text(`Lượt gọi món #${orderIndex + 1} · ${order.id}`, {
          underline: true,
        });
      document.moveDown(0.4);
      for (const item of order.items) {
        const lineTotal = item.unitPrice * item.quantity;
        document
          .fontSize(10)
          .text(`${item.dishName} × ${item.quantity}`, { continued: true });
        document.text(currency.format(lineTotal), { align: 'right' });
        if (item.note) {
          document
            .fillColor('#555555')
            .fontSize(9)
            .text(`Ghi chú: ${item.note}`)
            .fillColor('#000000');
        }
      }
      document
        .fontSize(10)
        .fillColor('#555555')
        .text(`Thành tiền lượt này: ${currency.format(order.totalAmount)}`, {
          align: 'right',
        })
        .fillColor('#000000');
    });

    const subtotalAmount = orders.reduce(
      (sum, order) =>
        sum +
        (order.subtotalAmount ||
          order.items.reduce(
            (itemSum, item) => itemSum + item.unitPrice * item.quantity,
            0,
          )),
      0,
    );
    const discountAmount = orders.reduce(
      (sum, order) =>
        sum +
        (order.discountAmount ||
          Math.max(
            0,
            (order.subtotalAmount || order.totalAmount) - order.totalAmount,
          )),
      0,
    );
    const paidTotal = orders.reduce((sum, order) => sum + order.totalAmount, 0);
    document.moveDown(1.5);
    document
      .fontSize(10)
      .text(`Tạm tính: ${currency.format(subtotalAmount)}`, { align: 'right' });
    if (discountAmount > 0) {
      document.text(`Giảm giá: -${currency.format(discountAmount)}`, {
        align: 'right',
      });
    }
    document
      .fontSize(13)
      .text(`Tổng thanh toán: ${currency.format(paidTotal)}`, {
        align: 'right',
      });
    if (paidTotal !== payment.amount) {
      throw new Error('PaymentIntent amount không khớp snapshot hóa đơn');
    }
    document
      .moveDown(2)
      .fontSize(10)
      .fillColor('#555555')
      .text('Cảm ơn quý khách!', { align: 'center' });
    document.end();
    return result;
  }

  private createdAt(order: OrderDocument): Date {
    return (
      (order as OrderDocument & { createdAt?: Date }).createdAt ?? new Date()
    );
  }
  private formatDate(date: Date): string {
    return new Intl.DateTimeFormat('vi-VN', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'Asia/Ho_Chi_Minh',
    }).format(date);
  }
}
