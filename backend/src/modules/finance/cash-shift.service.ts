import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, PipelineStage, Types } from 'mongoose';
import { UserRole } from '../../common/enums/user-role.enum';
import { User, UserDocument } from '../user/user.schema';
import {
  PaymentIntent,
  PaymentIntentDocument,
} from '../vnpay/payment-intent.schema';
import { lifecycleTransaction } from '../session/lifecycle-transaction';
import { CashShift, CashShiftDocument } from './cash-shift.schema';
import { CloseShiftDto, ShiftQuery } from './finance.dto';
import {
  completeReceiptCodes,
  RECEIPT_PAGE_SIZE,
  ReceiptRow,
  receiptRows,
} from './revenue.service';

export type CashActor = { id: string; role: UserRole };
export interface ShiftView {
  id: Types.ObjectId;
  staffId: Types.ObjectId;
  staffName: string;
  openedAt: Date;
  closedAt: Date | null;
  openingCash: number;
  cashSales: number;
  expectedCash: number;
  actualCash: number | null;
  variance: number | null;
  status: 'OPEN' | 'CLOSED';
  closedBy: Types.ObjectId | null;
  closedByName: string | null;
  version: number;
  transactionCount: number;
}

@Injectable()
export class CashShiftService implements OnModuleInit {
  constructor(
    @InjectModel(CashShift.name)
    private readonly shifts: Model<CashShiftDocument>,
    @InjectModel(PaymentIntent.name)
    private readonly receipts: Model<PaymentIntentDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async onModuleInit() {
    // Do not accept traffic until the cross-instance OPEN constraint exists.
    await this.shifts.createIndexes();
  }

  async open(actor: CashActor, openingCash: number) {
    const user = await this.users
      .findById(actor.id)
      .select('fullName')
      .lean()
      .exec();
    if (!user) throw new ForbiddenException();
    try {
      const shift = await this.shifts.create({
        staffId: actor.id,
        staffName: user.fullName,
        openingCash,
      });
      return this.detail(String(shift._id), actor);
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        throw new ConflictException('Bạn đã có ca tiền mặt đang mở');
      throw error;
    }
  }

  private view(): PipelineStage.FacetPipelineStage[] {
    return [
      {
        $lookup: {
          from: 'payment_intents',
          localField: '_id',
          foreignField: 'cashShiftId',
          as: 'sales',
          pipeline: [
            { $match: { status: 'succeeded', paymentMethod: 'CASH' } },
            {
              $group: {
                _id: null,
                cashSales: { $sum: '$amount' },
                transactionCount: { $sum: 1 },
              },
            },
          ],
        },
      },
      {
        $set: {
          cashSales: { $ifNull: [{ $first: '$sales.cashSales' }, 0] },
          transactionCount: {
            $ifNull: [{ $first: '$sales.transactionCount' }, 0],
          },
        },
      },
      {
        $project: {
          _id: 0,
          id: '$_id',
          staffId: 1,
          staffName: 1,
          openedAt: 1,
          closedAt: 1,
          openingCash: 1,
          cashSales: 1,
          transactionCount: 1,
          version: 1,
          status: 1,
          actualCash: 1,
          variance: 1,
          closedBy: 1,
          closedByName: 1,
          expectedCash: {
            $cond: [
              { $eq: ['$status', 'CLOSED'] },
              '$expectedCash',
              { $add: ['$openingCash', '$cashSales'] },
            ],
          },
        },
      },
    ];
  }

  async list(query: ShiftQuery, actor?: CashActor) {
    const page = query.page ?? 1;
    const staffId = actor?.id ?? query.staffId;
    const [result] = await this.shifts
      .aggregate<{ shifts: ShiftView[]; count: { total: number }[] }>([
        {
          $match: {
            ...(staffId ? { staffId: new Types.ObjectId(staffId) } : {}),
            ...(query.status ? { status: query.status } : {}),
          },
        },
        {
          $facet: {
            count: [{ $count: 'total' }],
            shifts: [
              { $sort: { openedAt: -1, _id: -1 } },
              { $skip: (page - 1) * RECEIPT_PAGE_SIZE },
              { $limit: RECEIPT_PAGE_SIZE },
              ...this.view(),
            ],
          },
        },
      ])
      .exec();
    return {
      shifts: result.shifts,
      total: result.count[0]?.total ?? 0,
      page,
      pageSize: RECEIPT_PAGE_SIZE,
    };
  }

  async current(actor: CashActor) {
    return (
      (await this.list({ status: 'OPEN', page: 1 }, actor)).shifts[0] ?? null
    );
  }

  async detail(id: string, actor: CashActor, page = 1) {
    const [shift] = await this.shifts
      .aggregate<ShiftView>([
        { $match: { _id: new Types.ObjectId(id) } },
        ...this.view(),
      ])
      .exec();
    if (!shift) throw new NotFoundException('Không tìm thấy ca tiền mặt');
    if (actor.role !== UserRole.ADMIN && String(shift.staffId) !== actor.id)
      throw new ForbiddenException('Bạn chỉ được xem ca của mình');
    const transactions = await this.receipts
      .aggregate<ReceiptRow>([
        {
          $match: {
            cashShiftId: new Types.ObjectId(id),
            paymentMethod: 'CASH',
            status: 'succeeded',
          },
        },
        { $sort: { completedAt: -1, _id: -1 } },
        { $skip: (page - 1) * RECEIPT_PAGE_SIZE },
        { $limit: RECEIPT_PAGE_SIZE },
        ...receiptRows(),
      ])
      .exec();
    await completeReceiptCodes(this.receipts, transactions);
    return { ...shift, transactions, page, pageSize: RECEIPT_PAGE_SIZE };
  }

  async close(id: string, input: CloseShiftDto, actor: CashActor) {
    const closer = await this.users
      .findById(actor.id)
      .select('fullName')
      .lean()
      .exec();
    if (!closer) throw new ForbiddenException();
    await lifecycleTransaction(this.connection, async (session) => {
      const shift = await this.shifts.findById(id).session(session).exec();
      if (!shift) throw new NotFoundException('Không tìm thấy ca tiền mặt');
      if (actor.role !== UserRole.ADMIN && String(shift.staffId) !== actor.id)
        throw new ForbiddenException('Bạn chỉ được đóng ca của mình');
      if (shift.status !== 'OPEN')
        throw new ConflictException('Ca đã đóng; kết quả được giữ nguyên');
      // A settlement and close must both write this same document in their
      // transaction. A stale preview/write conflict returns 409, never silently
      // closes over receipts the operator has not seen.
      const locked = await this.shifts
        .updateOne(
          { _id: shift._id, status: 'OPEN', version: input.version },
          { $inc: { version: 1 } },
          { session },
        )
        .exec();
      if (locked.modifiedCount !== 1)
        throw new ConflictException(
          'Ca vừa có thay đổi; tải lại số tiền trước khi đóng',
        );
      const [sales] = await this.receipts
        .aggregate<{ amount: number }>([
          {
            $match: {
              cashShiftId: shift._id,
              paymentMethod: 'CASH',
              status: 'succeeded',
            },
          },
          { $group: { _id: null, amount: { $sum: '$amount' } } },
        ])
        .session(session)
        .exec();
      const expectedCash = shift.openingCash + (sales?.amount ?? 0);
      if (!Number.isSafeInteger(expectedCash))
        throw new ConflictException('Số tiền vượt giới hạn tính toán');
      await this.shifts
        .updateOne(
          { _id: shift._id, status: 'OPEN', version: input.version + 1 },
          {
            $set: {
              status: 'CLOSED',
              closedAt: new Date(),
              closedBy: actor.id,
              closedByName: closer.fullName,
              expectedCash,
              actualCash: input.actualCash,
              variance: input.actualCash - expectedCash,
            },
          },
          { session },
        )
        .exec();
    });
    return this.detail(id, actor);
  }
}
