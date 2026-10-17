import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type CashShiftDocument = HydratedDocument<CashShift>;

@Schema({ collection: 'cash_shifts', timestamps: true })
export class CashShift {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: 'User',
    required: true,
    immutable: true,
  })
  staffId!: Types.ObjectId;

  @Prop({ required: true, immutable: true })
  staffName!: string;

  @Prop({ required: true, immutable: true, default: Date.now })
  openedAt!: Date;

  @Prop({ type: Date, default: null })
  closedAt!: Date | null;

  @Prop({ required: true, min: 0, immutable: true })
  openingCash!: number;

  @Prop({ type: Number, default: null })
  expectedCash!: number | null;

  @Prop({ type: Number, default: null })
  actualCash!: number | null;

  @Prop({ type: Number, default: null })
  variance!: number | null;

  @Prop({
    type: String,
    enum: ['OPEN', 'CLOSED'],
    default: 'OPEN',
    required: true,
  })
  status!: 'OPEN' | 'CLOSED';

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  closedBy!: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  closedByName!: string | null;

  /** Shared write fence for settlement and close; also a close-preview token. */
  @Prop({ required: true, default: 0 })
  version!: number;
}

export const CashShiftSchema = SchemaFactory.createForClass(CashShift);
CashShiftSchema.index(
  { staffId: 1 },
  {
    unique: true,
    name: 'one_open_cash_shift_per_staff',
    partialFilterExpression: { status: 'OPEN' },
  },
);
CashShiftSchema.index({ status: 1, openedAt: -1 });
