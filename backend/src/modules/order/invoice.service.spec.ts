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
  it('renders CASH with staff, paidAt, promotions and excluded items in the same PDF template', async () => {
    const text = jest.spyOn(PDFDocument.prototype, 'text');
    const pdf = await new InvoiceService().renderDetail({
      ...invoice,
      paymentMethod: 'CASH',
      settledByName: 'Nguyễn An',
      orders: invoice.orders.map((order) => ({
        ...order,
        promotionCode: order.discountAmount ? 'SAVE50' : undefined,
        items: [
          ...order.items,
          {
            name: 'Món hết',
            unitPrice: 90000,
            quantity: 1,
            status: 'Rejected',
            rejectionReason: 'Hết nguyên liệu',
          },
        ],
      })),
    });
    const visible = text.mock.calls.map((call) => call[0]).join('\n');
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    for (const expected of [
      invoice.invoiceCode,
      'Tiền mặt (CASH)',
      'Nguyễn An',
      '10/9/26',
      'SAVE50',
      'Không tính tiền',
      'Hết nguyên liệu',
      'Tổng thanh toán: 300.000',
    ])
      expect(visible).toContain(expected);
    expect(visible).not.toMatch(/VNPAY|txnRef|12345678/);
  });
  it('prints rejected item, original value and reason as excluded from the charge in both PDF paths', async () => {
    const text = jest.spyOn(PDFDocument.prototype, 'text');
    const rejected = {
      name: 'Món hết',
      unitPrice: 20000,
      quantity: 2,
      status: 'Rejected',
      rejectionReason: 'Hết nguyên liệu',
    };
    await new InvoiceService().renderDetail({
      ...invoice,
      orders: [
        {
          sequence: 1,
          items: [rejected],
          subtotalAmount: 0,
          discountAmount: 0,
          totalAmount: 0,
        },
      ],
      subtotalAmount: 0,
      discountAmount: 0,
      totalAmount: 0,
    });
    let visible = text.mock.calls.map((call) => call[0]).join('\n');
    expect(visible).toContain('Không tính tiền (giá trị gốc: 40.000');
    expect(visible).toContain('Hết nguyên liệu');
    expect(visible).toMatch(/Tổng thanh toán: 0/);
    text.mockClear();
    await new InvoiceService().render({
      items: [{ ...rejected, dishName: rejected.name }],
      subtotalAmount: 0,
      discountAmount: 0,
      totalAmount: 0,
    } as OrderDocument);
    visible = text.mock.calls.map((call) => call[0]).join('\n');
    expect(visible).toContain('Không tính tiền');
    expect(visible).toMatch(/Tạm tính: 0/);
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
