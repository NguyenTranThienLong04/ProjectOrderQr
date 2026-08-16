import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { TableStatus } from '../../common/enums/table-status.enum';

export type TableDocument = HydratedDocument<Table>;

@Schema({ timestamps: true, collection: 'tables' })
export class Table {
  @Prop({ required: true, unique: true, trim: true, uppercase: true })
  tableCode!: string;

  @Prop({
    required: true,
    enum: TableStatus,
    type: String,
    default: TableStatus.AVAILABLE,
  })
  status!: TableStatus;

  @Prop({ required: true })
  qrCodeUrl!: string;

  @Prop({ type: Types.ObjectId, ref: 'Session', default: null })
  currentSessionId?: Types.ObjectId | null;

  /** Symmetric list of tables grouped before any customer has opened a session. */
  @Prop({ type: [Types.ObjectId], ref: 'Table', default: [] })
  groupedWithTableIds!: Types.ObjectId[];

  @Prop({ type: Types.ObjectId, ref: 'Table', default: null })
  groupRootTableId?: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  groupedAt?: Date | null;

  /** Short-lived server-side lock used to reject overlapping merge requests. */
  @Prop({ type: String, default: null })
  mergeLockToken?: string | null;

  @Prop({ type: Date, default: null })
  mergeLockExpiresAt?: Date | null;

  @Prop({ default: 4, min: 1 })
  capacity!: number;
}

export const TableSchema = SchemaFactory.createForClass(Table);

TableSchema.index({ status: 1 });
TableSchema.index({ currentSessionId: 1 });
