import type { FormEvent } from "react";
import {
  Feedback,
  primaryButtonClass,
  secondaryButtonClass,
} from "../../components/ui";
import type { CashShift, ShiftDetail } from "../../services/api/finance";
import { CashValues, Pagination, ReceiptTable } from "./FinanceShared";
import { inputClass, money, time } from "./finance-format";

export const shiftStatus = {
  OPEN: "Đang mở",
  PENDING_REVIEW: "Chờ Admin xác minh",
  CLOSED: "Đã đóng",
};
export const cashAmount = (value: number | null | undefined) =>
  value == null ? "—" : money(value);
export const hasDiscrepancy = (shift: CashShift) =>
  [shift.declaredVariance, shift.verifiedVariance, shift.variance].some(
    (value) => value != null && value !== 0,
  ) ||
  (shift.declaredCash != null &&
    shift.verifiedCash != null &&
    shift.declaredCash !== shift.verifiedCash);

export function ShiftCashValues({ shift }: { shift: CashShift }) {
  // Also guard in the UI if an old/cached response includes totals for OPEN.
  if (shift.status === "OPEN" && shift.canSubmit) return null;
  if (shift.expectedCash == null || shift.cashSales == null) return null;
  return (
    <CashValues
      openingCash={shift.openingCash}
      cashSales={shift.cashSales}
      expectedCash={shift.expectedCash}
    />
  );
}

export function CashShiftReview({
  detail,
  admin,
  saving,
  loading,
  count,
  onCount,
  onAction,
  onReload,
  onPage,
}: {
  detail: ShiftDetail;
  admin: boolean;
  saving: boolean;
  loading: boolean;
  count: string;
  onCount: (value: string) => void;
  onAction: (event: FormEvent) => void;
  onReload: () => void;
  onPage: (page: number) => void;
}) {
  const blind = detail.status === "OPEN" && (!admin || detail.canSubmit);
  const submitting = detail.status === "OPEN" && detail.canSubmit;
  const verifying =
    admin && detail.status === "PENDING_REVIEW" && detail.canVerify;
  const legacy =
    detail.status === "CLOSED" &&
    detail.submittedAt == null &&
    detail.actualCash != null;
  return (
    <>
      <p className="text-sm">
        <strong>{detail.staffName}</strong> · Mở lúc {time(detail.openedAt)} ·{" "}
        {shiftStatus[detail.status]}
      </p>
      {!blind && <ShiftCashValues shift={detail} />}
      {detail.status === "PENDING_REVIEW" && (
        <Feedback tone="info">
          Ca đang chờ Admin xác minh. Kê khai đã được lưu và không thể sửa. Chỉ
          có thể mở ca mới sau khi ca này được xác minh.
        </Feedback>
      )}
      {detail.status !== "OPEN" && (
        <div className="space-y-3 border-t border-slate-200 pt-4">
          <dl className="grid gap-4 sm:grid-cols-2">
            {(legacy
              ? ([
                  ["Thực tế nộp (ca cũ)", detail.actualCash],
                  ["Chênh lệch (ca cũ)", detail.variance],
                ] as const)
              : ([
                  ["Tiền kê khai", detail.declaredCash],
                  ["Chênh lệch kê khai", detail.declaredVariance],
                  ["Tiền đã xác minh", detail.verifiedCash],
                  ["Chênh lệch xác minh", detail.verifiedVariance],
                ] as const)
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-sm text-slate-600">{label}</dt>
                <dd className="text-xl font-bold tabular-nums">
                  {cashAmount(value)}
                </dd>
              </div>
            ))}
          </dl>
          {hasDiscrepancy(detail) && (
            <Feedback tone="warning">
              Có chênh lệch đối soát. Cần kiểm tra các khoản thu và tiền bàn
              giao.
            </Feedback>
          )}
          {detail.declaredCash != null &&
            detail.verifiedCash != null &&
            detail.declaredCash !== detail.verifiedCash && (
              <Feedback tone="warning">
                Tiền kê khai khác tiền Admin xác minh.
              </Feedback>
            )}
          {legacy ? (
            <p className="text-sm text-slate-600">
              Ca cũ: chưa có bằng chứng kê khai và xác minh riêng.
            </p>
          ) : (
            <p className="text-sm text-slate-600">
              Gửi lúc {time(detail.submittedAt)} · Xác minh lúc{" "}
              {time(detail.verifiedAt)}
            </p>
          )}
          {detail.status === "CLOSED" && (
            <p className="text-sm text-slate-600">
              Đóng lúc {time(detail.closedAt)} · Người đóng:{" "}
              {detail.closedByName ?? "Không còn thông tin"}. Kết quả đã được
              lưu.
            </p>
          )}
        </div>
      )}
      {(submitting || verifying) && (
        <form
          onSubmit={onAction}
          className="space-y-3 border-t border-slate-200 pt-4"
        >
          <p id="cash-count-hint" className="text-sm text-slate-600">
            {submitting
              ? "Đếm toàn bộ tiền mặt thực tế trong két và nhập số tiền. Sau khi gửi, bạn không thể sửa kê khai."
              : "Đếm lại tiền bàn giao và nhập số tiền xác minh. Kết quả xác minh sẽ đóng ca và không thể sửa."}
          </p>
          <label htmlFor="counted-cash" className="block text-sm font-semibold">
            {submitting ? "Tiền kê khai (VND)" : "Tiền xác minh (VND)"}
          </label>
          <input
            id="counted-cash"
            type="number"
            inputMode="numeric"
            min="0"
            max={Number.MAX_SAFE_INTEGER}
            step="1"
            required
            className={inputClass}
            value={count}
            disabled={saving || loading}
            onChange={(event) => onCount(event.target.value)}
            aria-describedby="cash-count-hint"
          />
          <div className="flex flex-wrap gap-3">
            <button
              className={primaryButtonClass}
              disabled={saving || loading || count === ""}
            >
              {saving
                ? "Đang lưu…"
                : submitting
                  ? "Gửi đối soát"
                  : "Xác nhận xác minh"}
            </button>
            <button
              type="button"
              disabled={saving || loading}
              className={secondaryButtonClass}
              onClick={onReload}
            >
              Tải lại ca
            </button>
          </div>
        </form>
      )}
      {admin && detail.status === "PENDING_REVIEW" && !detail.canVerify && (
        <Feedback tone="info">
          Ca của Admin phải được một Admin khác xác minh.
        </Feedback>
      )}
      {!blind && (
        <section className="space-y-3">
          <h2 className="font-bold">
            Hóa đơn CASH trong ca ({detail.transactionCount})
          </h2>
          <ReceiptTable rows={detail.transactions} admin={admin} />
          <Pagination
            page={detail.page}
            pageSize={detail.pageSize}
            total={detail.transactionCount}
            onPage={onPage}
            disabled={saving}
          />
        </section>
      )}
    </>
  );
}
