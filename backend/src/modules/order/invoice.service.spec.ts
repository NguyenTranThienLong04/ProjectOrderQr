import { InvoiceService } from './invoice.service';
import { OrderStatus } from '../../common/enums/order-status.enum';

describe('InvoiceService', () => {
  it('generates a non-empty PDF with the bundled Unicode font', async () => {
    const service = new InvoiceService();
    const pdf = await service.render({
      id: '507f1f77bcf86cd799439011',
      items: [
        { dishName: 'Phở bò', unitPrice: 55000, quantity: 1 },
        { dishName: 'Bánh mì', unitPrice: 25000, quantity: 2 },
        { dishName: 'Cà phê sữa đá', unitPrice: 30000, quantity: 1 },
      ],
      subtotalAmount: 135000,
      discountAmount: 13500,
      promotionCode: 'SAVE10',
      totalAmount: 121500,
      status: OrderStatus.PAID,
      paidAt: new Date('2026-08-13T08:00:00.000Z'),
    } as any);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(10_000);
  });

  it('generates one aggregate PDF for every Order covered by a Session payment', async () => {
    const service = new InvoiceService();
    const orders = [
      {
        id: '507f1f77bcf86cd799439011',
        items: [{ dishName: 'Phở bò', unitPrice: 100_000, quantity: 1 }],
        subtotalAmount: 100_000,
        discountAmount: 0,
        totalAmount: 100_000,
      },
      {
        id: '507f1f77bcf86cd799439012',
        items: [{ dishName: 'Lẩu hải sản', unitPrice: 250_000, quantity: 1 }],
        subtotalAmount: 250_000,
        discountAmount: 50_000,
        totalAmount: 200_000,
      },
    ] as any;
    const pdf = await service.renderSession(orders, {
      sessionId: '507f1f77bcf86cd799439099',
      txnRef: '507f1f77bcf86cd799439099123456',
      transactionNo: 'VNP123456',
      amount: 300_000,
      paidAt: new Date('2026-08-15T08:00:00.000Z'),
    });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(10_000);
  });
});
