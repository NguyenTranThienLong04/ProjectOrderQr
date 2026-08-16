import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';
import { Table, TableDocument } from './table.schema';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';
import { Session, SessionDocument } from '../session/session.schema';
import { SessionStatus } from '../../common/enums/session-status.enum';
import { TableStatus } from '../../common/enums/table-status.enum';
import { Order, OrderDocument } from '../order/order.schema';
import { OrderStatus } from '../../common/enums/order-status.enum';

@Injectable()
export class TableService {
  constructor(
    @InjectModel(Table.name) private readonly tableModel: Model<TableDocument>,
    @InjectModel(Session.name)
    private readonly sessionModel: Model<SessionDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly configService: ConfigService,
  ) {}

  private getFrontendUrl(): string {
    return (
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173'
    );
  }

  private async generateQrCodeDataUrl(tableId: string): Promise<string> {
    const link = `${this.getFrontendUrl()}/menu?tableId=${tableId}`;
    return QRCode.toDataURL(link, {
      errorCorrectionLevel: 'H',
      width: 300,
      margin: 2,
    });
  }

  async create(createTableDto: CreateTableDto): Promise<TableDocument> {
    const existing = await this.tableModel.findOne({
      tableCode: createTableDto.tableCode.trim().toUpperCase(),
    });
    if (existing) {
      throw new ConflictException(
        `Mã bàn ${createTableDto.tableCode} đã tồn tại`,
      );
    }

    const tableId = new Types.ObjectId();
    const qrCodeUrl = await this.generateQrCodeDataUrl(tableId.toString());

    const newTable = new this.tableModel({
      _id: tableId,
      ...createTableDto,
      tableCode: createTableDto.tableCode.trim().toUpperCase(),
      qrCodeUrl,
    });

    return newTable.save();
  }

  async findAll(): Promise<TableDocument[]> {
    return this.tableModel.find().sort({ tableCode: 1 }).exec();
  }

  async findOne(id: string): Promise<TableDocument> {
    const table = await this.tableModel.findById(id).exec();
    if (!table) {
      throw new NotFoundException(`Không tìm thấy bàn với ID ${id}`);
    }
    return table;
  }

  async update(
    id: string,
    updateTableDto: UpdateTableDto,
  ): Promise<TableDocument> {
    if (updateTableDto.tableCode) {
      const existing = await this.tableModel.findOne({
        tableCode: updateTableDto.tableCode.trim().toUpperCase(),
        _id: { $ne: new Types.ObjectId(id) },
      });
      if (existing) {
        throw new ConflictException(
          `Mã bàn ${updateTableDto.tableCode} đã tồn tại`,
        );
      }
      updateTableDto.tableCode = updateTableDto.tableCode.trim().toUpperCase();
    }

    const updatedTable = await this.tableModel
      .findByIdAndUpdate(id, updateTableDto, { new: true })
      .exec();

    if (!updatedTable) {
      throw new NotFoundException(`Không tìm thấy bàn với ID ${id}`);
    }
    return updatedTable;
  }

  async remove(id: string): Promise<void> {
    const result = await this.tableModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Không tìm thấy bàn với ID ${id}`);
    }
  }

  async regenerateQr(id: string): Promise<TableDocument> {
    const table = await this.findOne(id);
    const qrCodeUrl = await this.generateQrCodeDataUrl(table.id);
    table.qrCodeUrl = qrCodeUrl;
    return table.save();
  }

  async clear(id: string): Promise<TableDocument> {
    const table = await this.findOne(id);
    if (!table.currentSessionId) {
      throw new BadRequestException(
        'Bàn không có phiên ăn đang hoạt động để dọn',
      );
    }
    const session = await this.sessionModel
      .findById(table.currentSessionId)
      .exec();
    if (!session || session.status !== SessionStatus.ACTIVE) {
      throw new BadRequestException('Phiên ăn của bàn không còn hoạt động');
    }
    if (session.cart.length > 0) {
      throw new BadRequestException(
        'Không thể dọn bàn khi phiên ăn vẫn còn món trong giỏ hàng',
      );
    }
    const outstandingOrder = await this.orderModel
      .exists({
        sessionId: session._id,
        status: { $nin: [OrderStatus.PAID, OrderStatus.CANCELLED] },
      })
      .exec();
    if (outstandingOrder) {
      throw new BadRequestException(
        'Không thể dọn bàn khi phiên ăn vẫn còn đơn chưa thanh toán',
      );
    }
    await this.sessionModel
      .updateOne(
        { _id: session._id, status: SessionStatus.ACTIVE },
        { $set: { status: SessionStatus.CLOSED, endedAt: new Date() } },
      )
      .exec();
    // A merged session can own multiple physical tables. Clearing its bill must
    // release every table linked to that same session, never leave siblings stuck.
    const sessionTableIds = session.tableIds?.length
      ? session.tableIds
      : [table._id];
    await this.tableModel
      .updateMany(
        { _id: { $in: sessionTableIds }, currentSessionId: session._id },
        {
          $set: {
            status: TableStatus.AVAILABLE,
            currentSessionId: null,
            groupedWithTableIds: [],
            groupRootTableId: null,
            groupedAt: null,
          },
        },
      )
      .exec();
    const updated = await this.tableModel.findById(id).exec();
    if (!updated) throw new NotFoundException('Không tìm thấy bàn');
    return updated;
  }
}
