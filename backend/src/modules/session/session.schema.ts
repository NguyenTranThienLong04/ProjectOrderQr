import {
  OrderNoteAnalysis,
  OrderNoteAnalysisSchema,
} from '../../common/schemas/order-note-analysis.schema';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { SessionStatus } from '../../common/enums/session-status.enum';

export type SessionCartItemDocument = HydratedDocument<SessionCartItem>;
export type SessionDocument = HydratedDocument<Session>;

@Schema({ _id: true, timestamps: false })
export class SessionCartItem {
  _id!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Dish', required: true })
  dishId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  dishName!: string;

  @Prop({ required: true, min: 0 })
  unitPrice!: number;

  @Prop({ required: true, min: 1, default: 1 })
  quantity!: number;

  @Prop({ trim: true, maxlength: 250 })
  note?: string;

  @Prop({ type: OrderNoteAnalysisSchema, default: undefined })
  aiNoteAnalysis?: OrderNoteAnalysis;

  @Prop({ required: true, default: () => new Date() })
  addedAt!: Date;
}

export const SessionCartItemSchema =
  SchemaFactory.createForClass(SessionCartItem);

@Schema({ timestamps: true, collection: 'sessions' })
export class Session {
  @Prop({ type: Types.ObjectId, ref: 'Table', required: true })
  tableId!: Types.ObjectId;

  /** Primary table is retained for backwards-compatible queries; tableIds is authoritative. */
  @Prop({ type: [Types.ObjectId], ref: 'Table', default: [] })
  tableIds!: Types.ObjectId[];

  @Prop({
    required: true,
    enum: SessionStatus,
    type: String,
    default: SessionStatus.ACTIVE,
  })
  status!: SessionStatus;

  @Prop({ type: [SessionCartItemSchema], default: [] })
  cart!: SessionCartItem[];

  @Prop({ required: true, default: 0, min: 0 })
  version!: number;

  @Prop({ required: true, default: () => new Date() })
  startedAt!: Date;

  /** Only writes that represent customer intent refresh the pre-order timeout. */
  @Prop({ required: true, default: () => new Date() })
  lastActivityAt!: Date;

  @Prop({ type: Date, default: null })
  endedAt?: Date | null;

  @Prop({ type: [Types.ObjectId], ref: 'Session', default: [] })
  mergedFromSessionIds!: Types.ObjectId[];

  @Prop({ type: Types.ObjectId, ref: 'Session', default: null })
  mergedIntoSessionId?: Types.ObjectId | null;

  /** Required to restore an unmerged child without subtracting unrelated cart changes. */
  @Prop({ type: [SessionCartItemSchema], default: [] })
  preMergeCart!: SessionCartItem[];

  /**
   * Exact shared-cart state immediately after the merge. Unmerge compares the
   * current root cart with this snapshot so it never guesses ownership after a
   * customer has changed the shared cart.
   */
  @Prop({ type: [SessionCartItemSchema], default: undefined })
  postMergeRootCart?: SessionCartItem[];

  @Prop({ type: [Types.ObjectId], ref: 'Table', default: [] })
  preMergeTableIds!: Types.ObjectId[];

  @Prop({ type: Date, default: null })
  mergedAt?: Date | null;
}

export const SessionSchema = SchemaFactory.createForClass(Session);

SessionSchema.index({ tableId: 1, status: 1 });
SessionSchema.index({ status: 1, startedAt: -1 });
SessionSchema.index({ tableId: 1, status: 1, startedAt: -1 });
SessionSchema.index({ tableIds: 1, status: 1 });
SessionSchema.index({ mergedIntoSessionId: 1 });
SessionSchema.index({ status: 1, lastActivityAt: 1 });
