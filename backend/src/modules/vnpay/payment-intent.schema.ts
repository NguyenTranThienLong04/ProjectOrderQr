import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { generateInvoiceCode, INVOICE_CODE_PATTERN } from './invoice-code';

export enum PaymentIntentStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  /** Operator-verified rejection before a provider payment was created; not an IPN. */
  PROVIDER_REJECTED = 'provider_rejected',
  /** Replaced by a staff-recorded payment; says nothing about provider outcome. */
  SUPERSEDED = 'superseded',
}

// Older versions also wrote FAILED on local expiry/browser return. Those
// records remain unresolved until a verified server callback confirms them.
// Reconciliation uses the distinct terminal PROVIDER_REJECTED state, never a
// fabricated ipnConfirmed flag. Keep this predicate/index definition unchanged:
// both existing unique partial indexes already exclude terminal states.
export const UNRESOLVED_PAYMENT_FILTER = {
  $or: [
    { status: PaymentIntentStatus.PENDING },
    {
      status: PaymentIntentStatus.FAILED,
      ipnConfirmed: { $in: [false, null] },
    },
  ],
};

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
  @Prop({ required: true, min: 0 })
  amount!: number;

  @Prop({
    type: String,
    enum: ['vnpay', 'internal_zero', 'CASH'],
    default: 'vnpay',
  })
  paymentMethod!: 'vnpay' | 'internal_zero' | 'CASH';

  @Prop({ default: false })
  ipnConfirmed!: boolean;

  @Prop({ type: String, enum: ['reconciliation', 'cash_settlement'] })
  resolutionSource?: 'reconciliation' | 'cash_settlement';

  @Prop({ type: Types.ObjectId, ref: 'PaymentIntent' })
  supersededByPaymentId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  settledByUserId?: Types.ObjectId;

  @Prop({ type: String, enum: ['admin', 'waiter'] })
  settledByRole?: string;

  /** Set once, in the same transaction that settles CASH and fences the OPEN shift. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'CashShift', immutable: true })
  cashShiftId?: Types.ObjectId;

  /** Only populated from a verified, real IPN after cash supersession. */
  @Prop({ type: String, enum: ['succeeded', 'failed'] })
  lateProviderStatus?: 'succeeded' | 'failed';

  @Prop({ type: Date })
  lateProviderReceivedAt?: Date;

  @Prop({ default: false })
  reconciliationRequired!: boolean;

  /** Gateway rejection code, distinct from an IPN responseCode. */
  @Prop({ trim: true })
  providerCode?: string;

  @Prop({ type: String, enum: ['terminal_not_approved'] })
  resolutionReason?: 'terminal_not_approved';

  @Prop({ type: Date })
  resolvedAt?: Date;

  @Prop({ trim: true })
  reconciliationNote?: string;

  @Prop({ match: /^[a-f0-9]{64}$/ })
  reconciliationEvidenceSha256?: string;

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
PaymentIntentSchema.index({ status: 1, completedAt: -1, _id: -1 });
PaymentIntentSchema.index({ cashShiftId: 1, completedAt: -1 });
PaymentIntentSchema.index({ sessionId: 1, createdAt: -1 });
PaymentIntentSchema.index({ status: 1, expiresAt: 1 });
PaymentIntentSchema.index(
  { sessionId: 1 },
  {
    unique: true,
    name: 'one_unresolved_checkout_per_session',
    partialFilterExpression: UNRESOLVED_PAYMENT_FILTER,
  },
);
// Session ownership can change on merge; the same Order must remain reserved.
PaymentIntentSchema.index(
  { coveredOrderIds: 1 },
  {
    unique: true,
    name: 'one_unresolved_checkout_per_order',
    partialFilterExpression: UNRESOLVED_PAYMENT_FILTER,
  },
);
PaymentIntentSchema.index(
  { coverageKey: 1 },
  {
    unique: true,
    partialFilterExpression: { status: PaymentIntentStatus.PENDING },
  },
);
