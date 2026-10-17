import { axiosClient } from "./axios-client";

export interface SettlementRow {
  id: string;
  invoiceCode: string | null;
  sessionId: string;
  orderIds: string[];
  amount: number;
  paymentMethod: "CASH" | "VNPAY";
  paidAt: string;
  settledBy: string | null;
  staffName: string | null;
  tableName: string;
  cashShiftId: string | null;
  status: "succeeded";
  providerTransaction: string | null;
  reconciliationRequired?: boolean;
}
export interface RevenueTotals {
  totalRevenue: number;
  cashRevenue: number;
  vnpayRevenue: number;
  transactionCount: number;
}
export interface RevenueReport extends RevenueTotals {
  cashInOpenShifts: number;
  cashInPendingReviewShifts: number;
  cashInClosedShifts: number;
  unassignedHistoricalCash: number;
  timezone: string;
  from: string;
  toExclusive: string;
  page: number;
  pageSize: number;
  byDay: (RevenueTotals & { date: string })[];
  byPaymentMethod: {
    paymentMethod: string;
    revenue: number;
    transactionCount: number;
  }[];
  cashByStaff: {
    staffId: string | null;
    staffName: string;
    revenue: number;
    transactionCount: number;
  }[];
  transactions: SettlementRow[];
}
export interface CashShift {
  id: string;
  staffId: string;
  staffName: string;
  openedAt: string;
  closedAt: string | null;
  openingCash: number;
  cashSales?: number;
  expectedCash?: number;
  actualCash: number | null;
  variance?: number | null;
  declaredCash: number | null;
  declaredBy: string | null;
  submittedAt: string | null;
  declaredVariance?: number | null;
  verifiedCash: number | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  verifiedVariance?: number | null;
  status: "OPEN" | "PENDING_REVIEW" | "CLOSED";
  canSubmit: boolean;
  canVerify: boolean;
  closedBy: string | null;
  closedByName: string | null;
  version: number;
  transactionCount: number;
}
export interface ShiftList {
  shifts: CashShift[];
  total: number;
  page: number;
  pageSize: number;
}
export interface ShiftDetail extends CashShift {
  transactions: SettlementRow[];
  page: number;
  pageSize: number;
}
export interface StaffOption {
  _id: string;
  fullName: string;
}

export const financeApi = {
  revenue: async (
    params: {
      from: string;
      to: string;
      paymentMethod?: string;
      staffId?: string;
      page: number;
    },
    signal?: AbortSignal,
  ) =>
    (await axiosClient.get<RevenueReport>("/admin/revenue", { params, signal }))
      .data,
  staff: async (signal?: AbortSignal) =>
    (await axiosClient.get<StaffOption[]>("/admin/revenue/staff", { signal }))
      .data,
  current: async (signal?: AbortSignal) =>
    (
      await axiosClient.get<CashShift | null>("/cash-shifts/current", {
        signal,
      })
    ).data,
  shifts: async (
    admin: boolean,
    params: { status?: string; staffId?: string; page: number },
    signal?: AbortSignal,
  ) =>
    (
      await axiosClient.get<ShiftList>(
        admin ? "/admin/cash-shifts" : "/cash-shifts/mine",
        { params, signal },
      )
    ).data,
  detail: async (id: string, page = 1, signal?: AbortSignal) =>
    (
      await axiosClient.get<ShiftDetail>(`/cash-shifts/${id}`, {
        params: { page },
        signal,
      })
    ).data,
  open: async (openingCash: number) =>
    (await axiosClient.post<ShiftDetail>("/cash-shifts", { openingCash })).data,
  submit: async (id: string, declaredCash: number, version: number) =>
    (
      await axiosClient.post<ShiftDetail>(`/cash-shifts/${id}/submit`, {
        declaredCash,
        version,
      })
    ).data,
  verify: async (id: string, verifiedCash: number, version: number) =>
    (
      await axiosClient.post<ShiftDetail>(`/admin/cash-shifts/${id}/verify`, {
        verifiedCash,
        version,
      })
    ).data,
};
