import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import {
  PaymentIntent,
  PaymentIntentDocument,
  PaymentIntentStatus,
} from '../vnpay/payment-intent.schema';
import { User, UserDocument } from '../user/user.schema';
import { RevenueQuery } from './finance.dto';
import { UserRole } from '../../common/enums/user-role.enum';
import { ensureInvoiceCode } from '../vnpay/invoice-code';
import { REVENUE_TIMEZONE, revenuePeriod } from './revenue-period';

export const RECEIPT_PAGE_SIZE = 50;
export const successfulReceipts = {
  status: PaymentIntentStatus.SUCCEEDED,
  $or: [
    { paymentMethod: 'CASH' },
    { paymentMethod: 'vnpay', ipnConfirmed: true },
  ],
};

// Earlier CASH writes persisted staff references as strings. Normalize only in
// this read layer so old receipts retain their attribution without backfilling.
const normalizedStaff: PipelineStage.Set = {
  $set: {
    settledByUserId: {
      $convert: {
        input: '$settledByUserId',
        to: 'objectId',
        onError: null,
        onNull: null,
      },
    },
  },
};

export interface ReceiptRow {
  id: Types.ObjectId;
  invoiceCode: string | null;
}

/** Reuse invoice lookup's CAS for pre-code receipts; only fill public identity. */
export async function completeReceiptCodes(
  model: Model<PaymentIntentDocument>,
  rows: ReceiptRow[],
) {
  const missing = rows.filter((row) => !row.invoiceCode);
  if (!missing.length) return;
  const documents = await model
    .find({ _id: { $in: missing.map((row) => row.id) } })
    .exec();
  for (const document of documents) {
    const row = missing.find(
      (item) => String(item.id) === String(document._id),
    )!;
    row.invoiceCode = await ensureInvoiceCode(model, document);
  }
}

/** Presentation only: money and coverage come from the immutable receipt,
 * never current Session membership, Order totals or table occupancy. */
export function receiptRows(): PipelineStage.FacetPipelineStage[] {
  return [
    normalizedStaff,
    {
      $lookup: {
        from: 'tables',
        localField: 'tableId',
        foreignField: '_id',
        as: 'table',
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: 'settledByUserId',
        foreignField: '_id',
        as: 'staff',
      },
    },
    {
      $project: {
        _id: 0,
        id: '$_id',
        invoiceCode: { $ifNull: ['$invoiceCode', null] },
        sessionId: 1,
        orderIds: '$coveredOrderIds',
        amount: 1,
        paymentMethod: {
          $cond: [{ $eq: ['$paymentMethod', 'CASH'] }, 'CASH', 'VNPAY'],
        },
        paidAt: '$completedAt',
        status: 1,
        cashShiftId: { $ifNull: ['$cashShiftId', null] },
        settledBy: { $ifNull: ['$settledByUserId', null] },
        staffName: { $ifNull: [{ $first: '$staff.fullName' }, null] },
        tableName: {
          $ifNull: [{ $first: '$table.tableCode' }, 'Không còn thông tin bàn'],
        },
        providerTransaction: { $ifNull: ['$transactionNo', null] },
        reconciliationRequired: 1,
      },
    },
  ];
}

@Injectable()
export class RevenueService {
  constructor(
    @InjectModel(PaymentIntent.name)
    private readonly receipts: Model<PaymentIntentDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  async staff() {
    return this.users
      .find({ role: { $in: [UserRole.ADMIN, UserRole.WAITER] } })
      .select('_id fullName')
      .sort({ fullName: 1 })
      .lean()
      .exec();
  }

  async report(query: RevenueQuery) {
    const period = revenuePeriod(query.from, query.to);
    const page = query.page ?? 1;
    const match = {
      ...successfulReceipts,
      completedAt: { $gte: period.from, $lt: period.toExclusive },
      ...(query.paymentMethod
        ? { paymentMethod: query.paymentMethod === 'CASH' ? 'CASH' : 'vnpay' }
        : {}),
    };
    const sums = {
      totalRevenue: { $sum: '$amount' },
      cashRevenue: {
        $sum: { $cond: [{ $eq: ['$paymentMethod', 'CASH'] }, '$amount', 0] },
      },
      vnpayRevenue: {
        $sum: { $cond: [{ $eq: ['$paymentMethod', 'vnpay'] }, '$amount', 0] },
      },
      transactionCount: { $sum: 1 },
    };
    const [result] = await this.receipts
      .aggregate<{
        totals: {
          totalRevenue: number;
          cashRevenue: number;
          vnpayRevenue: number;
          transactionCount: number;
        }[];
        byDay: unknown[];
        cashShiftBreakdown: {
          cashInOpenShifts: number;
          cashInClosedShifts: number;
          unassignedHistoricalCash: number;
        }[];
        byPaymentMethod: unknown[];
        cashByStaff: unknown[];
        transactions: ReceiptRow[];
      }>([
        { $match: match },
        normalizedStaff,
        ...(query.staffId
          ? [{ $match: { settledByUserId: new Types.ObjectId(query.staffId) } }]
          : []),
        {
          $facet: {
            totals: [
              { $group: { _id: null, ...sums } },
              { $project: { _id: 0 } },
            ],
            cashShiftBreakdown: [
              { $match: { paymentMethod: 'CASH' } },
              {
                $lookup: {
                  from: 'cash_shifts',
                  localField: 'cashShiftId',
                  foreignField: '_id',
                  as: 'shift',
                  pipeline: [{ $project: { status: 1 } }],
                },
              },
              {
                $group: {
                  _id: null,
                  cashInOpenShifts: {
                    $sum: {
                      $cond: [
                        { $eq: [{ $first: '$shift.status' }, 'OPEN'] },
                        '$amount',
                        0,
                      ],
                    },
                  },
                  cashInClosedShifts: {
                    $sum: {
                      $cond: [
                        { $eq: [{ $first: '$shift.status' }, 'CLOSED'] },
                        '$amount',
                        0,
                      ],
                    },
                  },
                  unassignedHistoricalCash: {
                    $sum: {
                      $cond: [
                        {
                          $in: [
                            { $first: '$shift.status' },
                            ['OPEN', 'CLOSED'],
                          ],
                        },
                        0,
                        '$amount',
                      ],
                    },
                  },
                },
              },
              { $project: { _id: 0 } },
            ],
            byDay: [
              {
                $group: {
                  _id: {
                    $dateToString: {
                      date: '$completedAt',
                      format: '%Y-%m-%d',
                      timezone: REVENUE_TIMEZONE,
                    },
                  },
                  ...sums,
                },
              },
              { $sort: { _id: 1 } },
              {
                $project: {
                  _id: 0,
                  date: '$_id',
                  totalRevenue: 1,
                  cashRevenue: 1,
                  vnpayRevenue: 1,
                  transactionCount: 1,
                },
              },
            ],
            byPaymentMethod: [
              {
                $group: {
                  _id: '$paymentMethod',
                  revenue: { $sum: '$amount' },
                  transactionCount: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
              {
                $project: {
                  _id: 0,
                  paymentMethod: {
                    $cond: [{ $eq: ['$_id', 'CASH'] }, 'CASH', 'VNPAY'],
                  },
                  revenue: 1,
                  transactionCount: 1,
                },
              },
            ],
            cashByStaff: [
              { $match: { paymentMethod: 'CASH' } },
              {
                $group: {
                  _id: '$settledByUserId',
                  revenue: { $sum: '$amount' },
                  transactionCount: { $sum: 1 },
                },
              },
              {
                $lookup: {
                  from: 'users',
                  localField: '_id',
                  foreignField: '_id',
                  as: 'staff',
                },
              },
              {
                $project: {
                  _id: 0,
                  staffId: { $ifNull: ['$_id', null] },
                  staffName: {
                    $ifNull: [
                      { $first: '$staff.fullName' },
                      'Không còn thông tin nhân viên',
                    ],
                  },
                  revenue: 1,
                  transactionCount: 1,
                },
              },
              { $sort: { revenue: -1, staffId: 1 } },
            ],
            transactions: [
              { $sort: { completedAt: -1, _id: -1 } },
              { $skip: (page - 1) * RECEIPT_PAGE_SIZE },
              { $limit: RECEIPT_PAGE_SIZE },
              ...receiptRows(),
            ],
          },
        },
      ])
      .exec();
    await completeReceiptCodes(this.receipts, result.transactions);
    const totals = result.totals[0] ?? {
      totalRevenue: 0,
      cashRevenue: 0,
      vnpayRevenue: 0,
      transactionCount: 0,
    };
    return {
      ...totals,
      ...(result.cashShiftBreakdown[0] ?? {
        cashInOpenShifts: 0,
        cashInClosedShifts: 0,
        unassignedHistoricalCash: 0,
      }),
      ...period,
      page,
      pageSize: RECEIPT_PAGE_SIZE,
      byDay: result.byDay,
      byPaymentMethod: result.byPaymentMethod,
      cashByStaff: result.cashByStaff,
      transactions: result.transactions,
    };
  }
}
