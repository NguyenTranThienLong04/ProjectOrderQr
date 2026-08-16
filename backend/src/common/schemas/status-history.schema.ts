import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ActorType } from '../enums/actor-type.enum';
import { OrderStatus } from '../enums/order-status.enum';
import { UserRole } from '../enums/user-role.enum';

@Schema({ _id: false })
export class StatusChangedBy {
  @Prop({ required: true, enum: ActorType, type: String })
  actorType!: ActorType;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  userId?: Types.ObjectId;

  @Prop({ enum: UserRole, type: String })
  role?: UserRole;

  @Prop({ type: Types.ObjectId, ref: 'Session' })
  sessionId?: Types.ObjectId;
}

export const StatusChangedBySchema =
  SchemaFactory.createForClass(StatusChangedBy);

@Schema({ _id: false })
export class StatusHistoryEntry {
  @Prop({ enum: OrderStatus, type: String, default: null })
  fromStatus!: OrderStatus | null;

  @Prop({ required: true, enum: OrderStatus, type: String })
  toStatus!: OrderStatus;

  @Prop({ type: StatusChangedBySchema, required: true })
  changedBy!: StatusChangedBy;

  @Prop({ required: true, default: () => new Date() })
  changedAt!: Date;

  @Prop()
  note?: string;

  /** VNPAY audit fields are written only by the verified IPN transition. */
  @Prop({ trim: true })
  transactionNo?: string;

  @Prop({ min: 0 })
  amount?: number;

  @Prop({ trim: true })
  source?: string;
}

export const StatusHistoryEntrySchema =
  SchemaFactory.createForClass(StatusHistoryEntry);

export type StatusHistoryEntryDocument = HydratedDocument<StatusHistoryEntry>;
