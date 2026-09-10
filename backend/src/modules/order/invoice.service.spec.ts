import PDFDocument from 'pdfkit';
import { InvoiceService } from './invoice.service';
import { OrderDocument } from './order.schema';
import { PaymentIntentStatus } from '../vnpay/payment-intent.schema';
import { InvoiceDetailDto } from '../invoice/dto/invoice.dto';

describe('InvoiceService PDF content', () => {
  afterEach(() => jest.restoreAllMocks());
  const invoice: InvoiceDetailDto = {
    invoiceCode: 'INV-20260910-K7P4X2M9',
    paymentStatus: PaymentIntentStatus.SUCCEEDED,
    table: { displayName: 'A01 + A02' },
    paidAt: new Date('2026-09-10T08:00:00Z'),
    vnpTransactionNo: '12345678',
    orders: [
      {
        sequence: 1,
        items: [
          {
            name: 'Phở bò',
            unitPrice: 100000,
            quantity: 1,
            note: 'Không hành',
          },
        ],
        subtotalAmount: 100000,
        discountAmount: 0,
        totalAmount: 100000,
      },
      {
        sequence: 2,
        items: [{ name: 'Lẩu hải sản', unitPrice: 125000, quantity: 2 }],
        subtotalAmount: 250000,
        discountAmount: 50000,
        totalAmount: 200000,
      },
    ],
    subtotalAmount: 350000,
    discountAmount: 50000,
    totalAmount: 300000,
  };
  it('renders actual Unicode PDF with public code, table, rounds, snapshots, discount and VNPAY reference only', async () => {
    const text = jest.spyOn(PDFDocument.prototype, 'text');
    const pdf = await new InvoiceService().renderDetail(invoice);
    const visible = text.mock.calls.map((call) => call[0]).join('\n');
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(10000);
    for (const expected of [
      'HÓA ĐƠN THANH TOÁN',
      invoice.invoiceCode,
      'Bàn: A01 + A02',
      'Lượt gọi món #1',
      'Lượt gọi món #2',
      'Phở bò × 1',
      'Lẩu hải sản × 2',
      'Không hành',
      '350.000',
      '50.000',
      '300.000',
      'Mã VNPAY: 12345678',
    ])
      expect(visible).toContain(expected);
    expect(visible).not.toMatch(
      /[a-f\d]{24}|Mã phiên|Mã giao dịch|sessionId|orderId|dishId|txnRef|_id/i,
    );
  });
  it('omits provider reference when absent and handles enough rounds to paginate', async () => {
    const text = jest.spyOn(PDFDocument.prototype, 'text');
    const pdf = await new InvoiceService().renderDetail({
      ...invoice,
      vnpTransactionNo: undefined,
      orders: Array.from({ length: 40 }, (_, i) => ({
        ...invoice.orders[0],
        sequence: i + 1,
      })),
    });
    expect(pdf.length).toBeGreaterThan(15000);
    expect(text.mock.calls.map((call) => call[0]).join('\n')).not.toContain(
      'Mã VNPAY',
    );
  });
  it('keeps pre-PaymentIntent Order PDFs readable without Mongo IDs', async () => {
    const text = jest.spyOn(PDFDocument.prototype, 'text');
    const order = {
      id: '507f1f77bcf86cd799439011',
      items: [
        { dishName: 'Phở bò', unitPrice: 55000, quantity: 1, note: 'Ít cay' },
      ],
      subtotalAmount: 55000,
      discountAmount: 5000,
      totalAmount: 50000,
      paidAt: new Date(),
    } as unknown as OrderDocument;
    const pdf = await new InvoiceService().render(order);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    const visible = text.mock.calls.map((call) => call[0]).join('\n');
    expect(visible).not.toContain(order.id);
    expect(visible).toContain('Ít cay');
  });
});
