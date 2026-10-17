import { Link } from "react-router-dom";
import { secondaryButtonClass } from "../../components/ui";
import type { SettlementRow } from "../../services/api/finance";

import { money, time } from "./finance-format";

export function CashValues({
  openingCash,
  cashSales,
  expectedCash,
}: {
  openingCash: number;
  cashSales: number;
  expectedCash: number;
}) {
  return (
    <dl className="grid gap-4 sm:grid-cols-3">
      {[
        ["Tiền đầu ca", openingCash],
        ["CASH đã thu", cashSales],
        ["Tiền mặt dự kiến", expectedCash],
      ].map(([label, amount]) => (
        <div key={label}>
          <dt className="text-sm text-slate-600">{label}</dt>
          <dd className="mt-1 break-words text-lg font-bold tabular-nums text-slate-950">
            {money(Number(amount))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  disabled = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  disabled?: boolean;
}) {
  if (total <= pageSize && page === 1) return null;
  return (
    <nav
      aria-label="Phân trang"
      className="mt-4 flex flex-wrap items-center justify-end gap-3 text-sm"
    >
      <span>
        Trang {page} / {Math.max(1, Math.ceil(total / pageSize))} · {total} bản
        ghi
      </span>
      <button
        className={secondaryButtonClass}
        disabled={disabled || page <= 1}
        onClick={() => onPage(page - 1)}
      >
        Trước
      </button>
      <button
        className={secondaryButtonClass}
        disabled={disabled || page * pageSize >= total}
        onClick={() => onPage(page + 1)}
      >
        Sau
      </button>
    </nav>
  );
}

export function ReceiptTable({
  rows,
  admin,
}: {
  rows: SettlementRow[];
  admin: boolean;
}) {
  if (!rows.length)
    return (
      <p className="py-6 text-sm text-slate-600">Chưa có hóa đơn phù hợp.</p>
    );
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Các hóa đơn thanh toán thành công, thời gian Việt Nam
        </caption>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            {[
              "Thời gian",
              "Invoice",
              "Bàn",
              "Phương thức",
              "Số tiền",
              "Nhân viên",
            ].map((label) => (
              <th
                scope="col"
                key={label}
                className="whitespace-nowrap px-4 py-3 font-semibold"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="whitespace-nowrap px-4 py-3">
                {time(row.paidAt)}
              </td>
              <td className="px-4 py-3">
                {row.invoiceCode ? (
                  <Link
                    className="font-semibold text-brand-700 underline underline-offset-4"
                    to={`${admin ? "/admin" : "/waiter"}/invoices?invoiceCode=${encodeURIComponent(row.invoiceCode)}`}
                  >
                    {row.invoiceCode}
                  </Link>
                ) : (
                  <span>Hóa đơn cũ chưa có mã</span>
                )}
                {row.paymentMethod === "CASH" && !row.cashShiftId && (
                  <span className="mt-1 block text-xs text-amber-800">
                    Chưa gắn ca
                  </span>
                )}
                {row.reconciliationRequired && (
                  <span className="mt-1 block text-xs text-amber-800">
                    Cần kiểm tra khoản thu trùng
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-3">{row.tableName}</td>
              <td className="px-4 py-3">{row.paymentMethod}</td>
              <td className="whitespace-nowrap px-4 py-3 font-semibold tabular-nums">
                {money(row.amount)}
              </td>
              <td className="px-4 py-3">
                {row.paymentMethod === "CASH"
                  ? (row.staffName ?? row.settledBy ?? "Không còn thông tin")
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
