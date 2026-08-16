import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { OrderStatus } from '../../common/enums/order-status.enum';
import {
  StatusHistoryEntry,
  StatusHistoryEntrySchema,
} from '../../common/schemas/status-history.schema';

export type OrderItemDocument = HydratedDocument<OrderItem>;
export type OrderDocument = HydratedDocument<Order>;

@Schema({ _id: true, timestamps: false })
export class OrderItem {
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

  @Prop({
    required: true,
    enum: OrderStatus,
    type: String,
    default: OrderStatus.PENDING,
  })
  status!: OrderStatus;

  @Prop({ type: [StatusHistoryEntrySchema], default: [] })
  statusHistory!: StatusHistoryEntry[];
}

export const OrderItemSchema = SchemaFactory.createForClass(OrderItem);

@Schema({ timestamps: true, collection: 'orders' })
export class Order {
  @Prop({ type: Types.ObjectId, ref: 'Session', required: true })
  sessionId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Table', required: true })
  tableId!: Types.ObjectId;

  @Prop({ type: [OrderItemSchema], required: true, default: [] })
  items!: OrderItem[];

  @Prop({
    required: true,
    enum: OrderStatus,
    type: String,
    default: OrderStatus.PENDING,
  })
  status!: OrderStatus;

  @Prop({ type: [StatusHistoryEntrySchema], default: [] })
  statusHistory!: StatusHistoryEntry[];

  @Prop({ required: true, min: 0, default: 0 })
  totalAmount!: number;

  @Prop({ required: true, min: 0, default: 0 })
  subtotalAmount!: number;

  /** Immutable discount snapshot; payment, invoices, and reports never recalculate a promotion. */
  @Prop({ required: true, min: 0, default: 0 })
  discountAmount!: number;

  @Prop({ trim: true, uppercase: true })
  promotionCode?: string;

  @Prop({ trim: true })
  note?: string;

  @Prop({ type: Date, default: null })
  paidAt?: Date | null;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

OrderSchema.index({ tableId: 1, status: 1, createdAt: -1 });
OrderSchema.index({ sessionId: 1, createdAt: -1 });
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ createdAt: -1 });
