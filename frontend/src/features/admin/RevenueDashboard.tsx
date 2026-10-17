import { useEffect, useState, type FormEvent } from "react";
import {
  Feedback,
  LoadingState,
  PageHeader,
  primaryButtonClass,
  secondaryButtonClass,
} from "../../components/ui";
import {
  financeApi,
  type RevenueReport,
  type StaffOption,
} from "../../services/api/finance";
import { Pagination, ReceiptTable } from "../finance/FinanceShared";
import {
  financeError,
  inputClass,
  money,
  panelClass,
} from "../finance/finance-format";

function dates(preset: string) {
  const end = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const start = new Date(`${end}T00:00:00Z`);
  if (preset === "7days") start.setUTCDate(start.getUTCDate() - 6);
  if (preset === "month") start.setUTCDate(1);
  return { from: start.toISOString().slice(0, 10), to: end };
}

export function RevenueDashboard() {
  const [preset, setPreset] = useState("today");
  const [range, setRange] = useState(() => dates("today"));
  const [draft, setDraft] = useState(range);
  const [method, setMethod] = useState("");
  const [staffId, setStaffId] = useState("");
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [staffError, setStaffError] = useState("");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<RevenueReport>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void financeApi
      .staff(controller.signal)
      .then(setStaff)
      .catch(() => {
        if (!controller.signal.aborted)
          setStaffError("Chưa tải được bộ lọc nhân viên.");
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(undefined);
    void financeApi
      .revenue(
        {
          ...range,
          paymentMethod: method || undefined,
          staffId: staffId || undefined,
          page,
        },
        controller.signal,
      )
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(financeError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [range, method, staffId, page, refresh]);

  function selectPreset(value: string) {
    setPreset(value);
    if (value !== "custom") {
      const next = dates(value);
      setRange(next);
      setDraft(next);
      setPage(1);
    }
  }
  function custom(event: FormEvent) {
    event.preventDefault();
    setRange({ ...draft });
    setPage(1);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Doanh thu"
        description="Hóa đơn CASH và VNPAY đã thanh toán thành công. Ngày và giờ theo Việt Nam (UTC+7)."
        actions={
          <button
            className={secondaryButtonClass}
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Tải lại
          </button>
        }
      />
      <section
        className={`${panelClass} space-y-4`}
        aria-label="Bộ lọc doanh thu"
      >
        <div className="flex flex-wrap gap-2">
          {[
            ["today", "Hôm nay"],
            ["7days", "7 ngày"],
            ["month", "Tháng này"],
            ["custom", "Khoảng ngày"],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={preset === value}
              className={
                preset === value ? primaryButtonClass : secondaryButtonClass
              }
              onClick={() => selectPreset(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <form
            onSubmit={custom}
            className="grid items-end gap-3 sm:grid-cols-3"
          >
            <label className="space-y-1 text-sm font-medium">
              Từ ngày
              <input
                className={inputClass}
                type="date"
                required
                value={draft.from}
                max={draft.to}
                onChange={(event) =>
                  setDraft({ ...draft, from: event.target.value })
                }
              />
            </label>
            <label className="space-y-1 text-sm font-medium">
              Đến hết ngày
              <input
                className={inputClass}
                type="date"
                required
                value={draft.to}
                min={draft.from}
                onChange={(event) =>
                  setDraft({ ...draft, to: event.target.value })
                }
              />
            </label>
            <button className={primaryButtonClass}>Áp dụng</button>
          </form>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm font-medium">
            Phương thức
            <select
              className={inputClass}
              value={method}
              onChange={(event) => {
                setMethod(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Tất cả</option>
              <option value="CASH">CASH</option>
              <option value="VNPAY">VNPAY</option>
            </select>
          </label>
          <label className="space-y-1 text-sm font-medium">
            Nhân viên thu CASH
            <select
              className={inputClass}
              value={staffId}
              onChange={(event) => {
                setStaffId(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Tất cả nhân viên</option>
              {staff.map((user) => (
                <option key={user._id} value={user._id}>
                  {user.fullName}
                </option>
              ))}
            </select>
          </label>
        </div>
        {staffError && <Feedback tone="warning">{staffError}</Feedback>}
        <p className="text-sm text-slate-600">
          Khoảng đang xem: {range.from} — {range.to}. Các tổng số áp dụng theo
          bộ lọc.
        </p>
      </section>
      {loading && <LoadingState label="Đang tính doanh thu…" />}
      {error && <Feedback tone="danger">{error}</Feedback>}
      {data && (
        <>
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Tổng doanh thu", money(data.totalRevenue)],
              ["CASH", money(data.cashRevenue)],
              ["VNPAY", money(data.vnpayRevenue)],
              ["Số hóa đơn", data.transactionCount.toLocaleString("vi-VN")],
            ].map(([label, value]) => (
              <div key={label} className={panelClass}>
                <dt className="text-sm text-slate-600">{label}</dt>
                <dd className="mt-2 break-words text-2xl font-bold tabular-nums">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <section
            className={`${panelClass} space-y-4`}
            aria-label="CASH theo ca"
          >
            <h2 className="text-lg font-bold">CASH theo ca</h2>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["CASH trong ca OPEN", data.cashInOpenShifts],
                ["CASH trong ca PENDING_REVIEW", data.cashInPendingReviewShifts ?? 0],
                ["CASH trong ca CLOSED", data.cashInClosedShifts],
                ["Unassigned / Historical CASH", data.unassignedHistoricalCash],
              ].map(([label, amount]) => (
                <div className="min-w-0" key={label}>
                  <dt className="text-sm text-slate-600">{label}</dt>
                  <dd className="mt-1 break-words text-lg font-bold tabular-nums">
                    {money(Number(amount))}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-sm text-slate-600">
              Ba khoản cộng bằng tổng CASH theo bộ lọc, không gồm tiền đầu ca.
              Historical CASH là khoản thu chưa gắn ca, vẫn tính doanh thu và
              không tính vào chênh lệch của ca hiện tại.
            </p>
          </section>
          <section className={`${panelClass} space-y-4`}>
            <h2 className="text-lg font-bold">Hóa đơn</h2>
            <ReceiptTable rows={data.transactions} admin />
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.transactionCount}
              onPage={setPage}
            />
          </section>
          <div className="grid gap-6 xl:grid-cols-2">
            <section className={panelClass}>
              <h2 className="mb-4 text-lg font-bold">Doanh thu theo ngày</h2>
              {!data.byDay.length ? (
                <p className="text-sm text-slate-600">Chưa có doanh thu.</p>
              ) : (
                <div className="max-h-96 overflow-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr>
                        {["Ngày", "CASH", "VNPAY", "Tổng"].map((label) => (
                          <th scope="col" className="p-2" key={label}>
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.byDay.map((day) => (
                        <tr
                          key={day.date}
                          className="border-t border-slate-100"
                        >
                          <td className="whitespace-nowrap p-2">{day.date}</td>
                          <td className="whitespace-nowrap p-2 tabular-nums">
                            {money(day.cashRevenue)}
                          </td>
                          <td className="whitespace-nowrap p-2 tabular-nums">
                            {money(day.vnpayRevenue)}
                          </td>
                          <td className="whitespace-nowrap p-2 font-semibold tabular-nums">
                            {money(day.totalRevenue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className={panelClass}>
              <h2 className="mb-4 text-lg font-bold">CASH theo nhân viên</h2>
              {!data.cashByStaff.length ? (
                <p className="text-sm text-slate-600">
                  Chưa có khoản thu CASH.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.cashByStaff.map((row, index) => (
                    <li
                      key={row.staffId ?? index}
                      className="flex flex-wrap justify-between gap-3 py-3"
                    >
                      <div className="min-w-0 break-words">
                        <p className="font-medium">{row.staffName}</p>
                        <p className="text-sm text-slate-600">
                          {row.transactionCount} hóa đơn
                        </p>
                      </div>
                      <p className="font-semibold tabular-nums">
                        {money(row.revenue)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
