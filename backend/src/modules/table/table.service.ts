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
import { frontendUrl } from '../../common/config/public-urls';
import { SocketAuthService } from '../../gateway/socket-auth.service';
import {
  PaymentIntent,
  PaymentIntentDocument,
  UNRESOLVED_PAYMENT_FILTER,
} from '../vnpay/payment-intent.schema';
import { lifecycleTransaction } from '../session/lifecycle-transaction';

@Injectable()
export class TableService {
  constructor(
    @InjectModel(Table.name) private readonly tableModel: Model<TableDocument>,
    @InjectModel(Session.name)
    private readonly sessionModel: Model<SessionDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly configService: ConfigService,
    private readonly socketAuth: SocketAuthService,
    @InjectModel(PaymentIntent.name)
    private readonly paymentIntentModel: Model<PaymentIntentDocument>,
  ) {}

  private getFrontendUrl(): string {
    return frontendUrl(this.configService.get<string>('FRONTEND_URL'));
  }

  private async generateQr(tableId: string) {
    const tableToken = await this.socketAuth.issueTableEntry(tableId);
    const menuUrl = `${this.getFrontendUrl()}/menu?tableId=${tableId}&tableToken=${encodeURIComponent(tableToken)}`;
    const qrCodeUrl = await QRCode.toDataURL(menuUrl, {
      errorCorrectionLevel: 'H',
      width: 300,
      margin: 2,
    });
    return { menuUrl, qrCodeUrl };
  }

  async create(createTableDto: CreateTableDto): Promise<TableDocument> {
    if (
      createTableDto.status &&
      createTableDto.status !== TableStatus.AVAILABLE
    )
      throw new BadRequestException('Bàn mới phải ở trạng thái trống');
    const existing = await this.tableModel.findOne({
      tableCode: createTableDto.tableCode.trim().toUpperCase(),
    });
    if (existing) {
      throw new ConflictException(
        `Mã bàn ${createTableDto.tableCode} đã tồn tại`,
      );
    }

    const tableId = new Types.ObjectId();
    const qr = await this.generateQr(tableId.toString());

    const newTable = new this.tableModel({
      _id: tableId,
      ...createTableDto,
      tableCode: createTableDto.tableCode.trim().toUpperCase(),
      ...qr,
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

    const changesStatus = updateTableDto.status !== undefined;
    if (changesStatus && updateTableDto.status !== TableStatus.AVAILABLE)
      throw new ConflictException(
        'Trạng thái phục vụ/thanh toán do phiên ăn quản lý',
      );
    const updatedTable = await this.tableModel
      .findOneAndUpdate(
        {
          _id: id,
          ...(changesStatus
            ? {
                currentSessionId: null,
                status: TableStatus.AVAILABLE,
                groupedWithTableIds: { $size: 0 },
              }
            : {}),
        },
        { $set: updateTableDto, $inc: { __v: 1 } },
        { new: true },
      )
      .exec();

    if (!updatedTable) {
      if (await this.tableModel.exists({ _id: id }))
        throw new ConflictException(
          'Bàn đang có phiên hoặc thuộc nhóm. Hãy xác nhận thanh toán tiền mặt hoặc dọn bàn qua nghiệp vụ riêng',
        );
      throw new NotFoundException(`Không tìm thấy bàn với ID ${id}`);
    }
    return updatedTable;
  }

  async remove(id: string): Promise<void> {
    const result = await this.tableModel
      .findOneAndDelete({
        _id: id,
        currentSessionId: null,
        status: TableStatus.AVAILABLE,
        groupedWithTableIds: { $size: 0 },
      })
      .exec();
    if (!result) {
      if (await this.tableModel.exists({ _id: id }))
        throw new ConflictException(
          'Không thể xóa bàn đang có phiên hoặc thuộc nhóm',
        );
      throw new NotFoundException(`Không tìm thấy bàn với ID ${id}`);
    }
  }

  async regenerateQr(id: string): Promise<TableDocument> {
    const table = await this.findOne(id);
    const qr = await this.generateQr(table.id);
    table.qrCodeUrl = qr.qrCodeUrl;
    table.menuUrl = qr.menuUrl;
    return table.save();
  }

  async clear(id: string): Promise<TableDocument> {
    return lifecycleTransaction(this.tableModel.db, async (mongoSession) => {
      const table = await this.tableModel
        .findById(id)
        .session(mongoSession)
        .exec();
      if (!table) throw new NotFoundException('Không tìm thấy bàn');
      if (!table.currentSessionId) {
        throw new ConflictException(
          'Bàn không có phiên ăn đang hoạt động để dọn',
        );
      }
      const session = await this.sessionModel
        .findById(table.currentSessionId)
        .session(mongoSession)
        .exec();
      if (!session || session.status !== SessionStatus.ACTIVE) {
        throw new ConflictException('Phiên ăn của bàn không còn hoạt động');
      }
      if (session.cart.length > 0) {
        throw new ConflictException(
          'Không thể dọn bàn khi phiên ăn vẫn còn món trong giỏ hàng',
        );
      }
      const outstandingOrder = await this.orderModel
        .exists({
          sessionId: session._id,
          status: { $nin: [OrderStatus.PAID, OrderStatus.CANCELLED] },
        })
        .session(mongoSession)
        .exec();
      if (outstandingOrder) {
        throw new ConflictException(
          'Không thể dọn bàn khi phiên ăn vẫn còn đơn chưa thanh toán',
        );
      }
      const orders = await this.orderModel
        .find({ sessionId: session._id })
        .select('_id')
        .session(mongoSession)
        .exec();
      const unresolved = await this.paymentIntentModel
        .exists({
          $and: [
            UNRESOLVED_PAYMENT_FILTER,
            {
              $or: [
                { sessionId: session._id },
                { coveredOrderIds: { $in: orders.map((order) => order._id) } },
              ],
            },
          ],
        })
        .session(mongoSession)
        .exec();
      if (unresolved)
        throw new ConflictException(
          'Checkout chưa được xác nhận, không thể đóng phiên',
        );
      const sessionTableIds = session.tableIds?.length
        ? session.tableIds
        : [session.tableId];
      const owned = await this.tableModel
        .find({ currentSessionId: session._id })
        .session(mongoSession)
        .exec();
      if (
        owned.length !== sessionTableIds.length ||
        !sessionTableIds.some((tableId) => tableId.equals(session.tableId)) ||
        !sessionTableIds.some((tableId) => tableId.equals(table._id)) ||
        owned.some(
          (member) =>
            !sessionTableIds.some((tableId) => tableId.equals(member._id)),
        )
      )
        throw new ConflictException('Liên kết phiên và bàn không còn khớp');
      const closed = await this.sessionModel
        .updateOne(
          {
            _id: session._id,
            status: SessionStatus.ACTIVE,
            version: session.version,
            cart: { $size: 0 },
          },
          {
            $set: { status: SessionStatus.CLOSED, endedAt: new Date() },
            $inc: { version: 1 },
          },
          { session: mongoSession },
        )
        .exec();
      if (closed.modifiedCount !== 1)
        throw new ConflictException('Phiên vừa thay đổi');
      // A merged session can own multiple physical tables. Clearing its bill must
      // release every table linked to that same session, never leave siblings stuck.
      const released = await this.tableModel
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
            $inc: { __v: 1 },
          },
          { session: mongoSession },
        )
        .exec();
      if (released.modifiedCount !== sessionTableIds.length)
        throw new ConflictException('Bàn vừa thay đổi');
      const updated = await this.tableModel
        .findById(id)
        .session(mongoSession)
        .exec();
      if (!updated) throw new NotFoundException('Không tìm thấy bàn');
      return updated;
    });
  }
}
