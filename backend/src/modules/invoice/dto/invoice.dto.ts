import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { INVOICE_CODE_PATTERN } from '../../vnpay/invoice-code';
import { PaymentIntentStatus } from '../../vnpay/payment-intent.schema';

export class InvoiceParamsDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(INVOICE_CODE_PATTERN, {
    message: 'Mã hóa đơn không hợp lệ. Dùng INV-YYYYMMDD-XXXXXXXX.',
  })
  invoiceCode!: string;
}

export interface InvoiceDetailDto {
  invoiceCode: string;
  paymentStatus: PaymentIntentStatus;
  paidAt: Date | null;
  table: { displayName: string };
  vnpTransactionNo?: string;
  orders: {
    sequence: number;
    items: {
      name: string;
      nameEn?: string;
      quantity: number;
      unitPrice: number;
      note?: string;
    }[];
    subtotalAmount: number;
    discountAmount: number;
    totalAmount: number;
  }[];
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
}
