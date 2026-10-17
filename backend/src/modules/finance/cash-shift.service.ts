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
import { SubmitShiftDto, VerifyShiftDto, ShiftQuery } from './finance.dto';
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
  declaredCash: number | null;
  declaredBy: Types.ObjectId | null;
  submittedAt: Date | null;
  declaredVariance: number | null;
  verifiedCash: number | null;
  verifiedBy: Types.ObjectId | null;
  verifiedAt: Date | null;
  verifiedVariance: number | null;
  actualCash: number | null;
  variance: number | null;
  status: CashShift['status'];
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
    // Do not accept traffic until both cross-instance active constraints exist.
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
        throw new ConflictException(
          'Bạn đã có ca tiền mặt đang mở hoặc chờ xác minh',
        );
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
          declaredCash: { $ifNull: ['$declaredCash', null] },
          declaredBy: { $ifNull: ['$declaredBy', null] },
          submittedAt: { $ifNull: ['$submittedAt', null] },
          declaredVariance: { $ifNull: ['$declaredVariance', null] },
          verifiedCash: { $ifNull: ['$verifiedCash', null] },
          verifiedBy: { $ifNull: ['$verifiedBy', null] },
          verifiedAt: { $ifNull: ['$verifiedAt', null] },
          verifiedVariance: { $ifNull: ['$verifiedVariance', null] },
          closedBy: 1,
          closedByName: 1,
          expectedCash: {
            $cond: [
              { $ne: ['$status', 'OPEN'] },
              '$expectedCash',
              { $add: ['$openingCash', '$cashSales'] },
            ],
          },
        },
      },
    ];
  }

  private blind(shift: ShiftView, actor: CashActor) {
    return (
      shift.status === 'OPEN' &&
      (actor.role !== UserRole.ADMIN || String(shift.staffId) === actor.id)
    );
  }

  private present(shift: ShiftView, actor: CashActor) {
    const {
      cashSales,
      expectedCash,
      variance,
      declaredVariance,
      verifiedVariance,
      ...base
    } = shift;
    return {
      ...base,
      ...(!this.blind(shift, actor)
        ? {
            cashSales,
            expectedCash,
            variance,
            declaredVariance,
            verifiedVariance,
          }
        : {}),
      canSubmit: shift.status === 'OPEN' && String(shift.staffId) === actor.id,
      canVerify:
        shift.status === 'PENDING_REVIEW' &&
        actor.role === UserRole.ADMIN &&
        String(shift.staffId) !== actor.id,
    };
  }

  async list(query: ShiftQuery, actor: CashActor, ownOnly = true) {
    if (!ownOnly && actor.role !== UserRole.ADMIN)
      throw new ForbiddenException();
    const page = query.page ?? 1;
    const staffId = ownOnly ? actor.id : query.staffId;
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
      shifts: result.shifts.map((shift) => this.present(shift, actor)),
      total: result.count[0]?.total ?? 0,
      page,
      pageSize: RECEIPT_PAGE_SIZE,
    };
  }

  async current(actor: CashActor) {
    const [shift] = await this.shifts
      .aggregate<ShiftView>([
        {
          $match: {
            staffId: new Types.ObjectId(actor.id),
            status: { $in: ['OPEN', 'PENDING_REVIEW'] },
          },
        },
        ...this.view(),
      ])
      .exec();
    return shift ? this.present(shift, actor) : null;
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
    // Receipt amounts would let the collector reconstruct the blind total.
    if (this.blind(shift, actor))
      return {
        ...this.present(shift, actor),
        transactions: [],
        page,
        pageSize: RECEIPT_PAGE_SIZE,
      };
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
    return {
      ...this.present(shift, actor),
      transactions,
      page,
      pageSize: RECEIPT_PAGE_SIZE,
    };
  }

  async submit(id: string, input: SubmitShiftDto, actor: CashActor) {
    if (![UserRole.ADMIN, UserRole.WAITER].includes(actor.role))
      throw new ForbiddenException();
    await lifecycleTransaction(this.connection, async (session) => {
      const shift = await this.shifts.findById(id).session(session).exec();
      if (!shift) throw new NotFoundException('Không tìm thấy ca tiền mặt');
      if (String(shift.staffId) !== actor.id)
        throw new ForbiddenException('Bạn chỉ được gửi đối soát ca của mình');
      if (shift.status !== 'OPEN')
        throw new ConflictException(
          'Ca đã gửi đối soát; kê khai được giữ nguyên',
        );
      // Settlement and submission write the same document in their transaction.
      // A competing receipt requires reloading and counting again, never retrying
      // the declaration silently against a newer snapshot.
      const locked = await this.shifts
        .updateOne(
          { _id: shift._id, status: 'OPEN', version: input.version },
          { $inc: { version: 1 } },
          { session },
        )
        .exec();
      if (locked.modifiedCount !== 1)
        throw new ConflictException(
          'Ca vừa có thay đổi; tải lại và kiểm đếm trước khi gửi đối soát',
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
      const submitted = await this.shifts
        .updateOne(
          { _id: shift._id, status: 'OPEN', version: input.version + 1 },
          {
            $set: {
              status: 'PENDING_REVIEW',
              submittedAt: new Date(),
              declaredBy: actor.id,
              expectedCash,
              declaredCash: input.declaredCash,
              declaredVariance: input.declaredCash - expectedCash,
            },
          },
          { session },
        )
        .exec();
      if (submitted.modifiedCount !== 1)
        throw new ConflictException('Ca vừa có thay đổi');
    });
    return this.detail(id, actor);
  }

  async verify(id: string, input: VerifyShiftDto, actor: CashActor) {
    if (actor.role !== UserRole.ADMIN)
      throw new ForbiddenException('Chỉ Admin được xác minh ca');
    const verifier = await this.users
      .findById(actor.id)
      .select('fullName')
      .lean()
      .exec();
    if (!verifier) throw new ForbiddenException();
    await lifecycleTransaction(this.connection, async (session) => {
      const shift = await this.shifts.findById(id).session(session).exec();
      if (!shift) throw new NotFoundException('Không tìm thấy ca tiền mặt');
      if (String(shift.staffId) === actor.id)
        throw new ForbiddenException(
          'Ca của Admin phải được một Admin khác xác minh',
        );
      if (shift.status !== 'PENDING_REVIEW')
        throw new ConflictException(
          'Chỉ xác minh ca đang chờ; ca đã đóng không thể sửa',
        );
      if (
        shift.expectedCash === null ||
        !Number.isSafeInteger(shift.expectedCash)
      )
        throw new ConflictException('Ca chưa có số tiền dự kiến hợp lệ');
      const now = new Date();
      const verified = await this.shifts
        .updateOne(
          { _id: shift._id, status: 'PENDING_REVIEW', version: input.version },
          {
            $inc: { version: 1 },
            $set: {
              status: 'CLOSED',
              verifiedCash: input.verifiedCash,
              verifiedVariance: input.verifiedCash - shift.expectedCash,
              verifiedBy: actor.id,
              verifiedAt: now,
              closedAt: now,
              closedBy: actor.id,
              closedByName: verifier.fullName,
            },
          },
          { session },
        )
        .exec();
      if (verified.modifiedCount !== 1)
        throw new ConflictException(
          'Ca vừa có thay đổi; tải lại trước khi xác minh',
        );
    });
    return this.detail(id, actor);
  }
}
