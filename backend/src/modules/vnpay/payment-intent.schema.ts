import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { generateInvoiceCode, INVOICE_CODE_PATTERN } from './invoice-code';

export enum PaymentIntentStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

export type PaymentIntentDocument = HydratedDocument<PaymentIntent>;

@Schema({ timestamps: true, collection: 'payment_intents' })
export class PaymentIntent {
  /** Public display identity; optional only for pre-existing intents. */
  @Prop({ type: String, immutable: true, match: INVOICE_CODE_PATTERN })
  invoiceCode?: string;

  @Prop({ required: true, trim: true })
  txnRef!: string;

  /** Stable identity for one exact Session/order snapshot, used to collapse double-clicks. */
  @Prop({ required: true, trim: true })
  coverageKey!: string;

  @Prop({ type: Types.ObjectId, ref: 'Session', required: true })
  sessionId!: Types.ObjectId;

  /** QR table context used to prove customer ownership on return/status/invoice. */
  @Prop({ type: Types.ObjectId, ref: 'Table', required: true })
  tableId!: Types.ObjectId;

  /** Immutable checkout cutoff. IPN must never discover a newer set of Orders. */
  @Prop({ type: [Types.ObjectId], ref: 'Order', required: true, default: [] })
  coveredOrderIds!: Types.ObjectId[];

  /** VND amount snapshotted from SUM(covered Order.totalAmount). */
  @Prop({ required: true, min: 1 })
  amount!: number;

  /** Reused while this intent is pending, so concurrent clicks cannot charge twice. */
  @Prop({ required: true, trim: true })
  paymentUrl!: string;

  @Prop({
    required: true,
    enum: PaymentIntentStatus,
    type: String,
    default: PaymentIntentStatus.PENDING,
  })
  status!: PaymentIntentStatus;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  completedAt?: Date | null;

  @Prop({ trim: true })
  transactionNo?: string;

  @Prop({ trim: true })
  responseCode?: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const PaymentIntentSchema = SchemaFactory.createForClass(PaymentIntent);

// A default would also run while hydrating legacy documents, producing phantom
// codes that have never been persisted. Generate only for new writes instead.
PaymentIntentSchema.pre('validate', function () {
  if (this.isNew && !this.invoiceCode) this.invoiceCode = generateInvoiceCode();
});
PaymentIntentSchema.index(
  { invoiceCode: 1 },
  {
    unique: true,
    partialFilterExpression: { invoiceCode: { $type: 'string' } },
  },
);

PaymentIntentSchema.index({ txnRef: 1 }, { unique: true });
PaymentIntentSchema.index({ sessionId: 1, createdAt: -1 });
PaymentIntentSchema.index({ status: 1, expiresAt: 1 });
PaymentIntentSchema.index(
  { coverageKey: 1 },
  {
    unique: true,
    partialFilterExpression: { status: PaymentIntentStatus.PENDING },
  },
);
