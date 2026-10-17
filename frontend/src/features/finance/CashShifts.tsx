import { useEffect, useState, type FormEvent } from "react";
import {
  Feedback,
  LoadingState,
  Modal,
  PageHeader,
  primaryButtonClass,
  secondaryButtonClass,
} from "../../components/ui";
import {
  financeApi,
  type CashShift,
  type ShiftDetail,
  type ShiftList,
  type StaffOption,
} from "../../services/api/finance";
import { Pagination } from "./FinanceShared";
import {
  CashShiftReview,
  ShiftCashValues,
  cashAmount,
  hasDiscrepancy,
  shiftStatus,
} from "./CashShiftReview";
import { financeError, inputClass, panelClass, time } from "./finance-format";

function ShiftDialog({
  id,
  admin,
  onClose,
  onChanged,
}: {
  id: string;
  admin: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ShiftDetail>();
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [count, setCount] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setDetail(undefined);
    void financeApi
      .detail(id, page, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDetail(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(financeError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, page, refresh]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!detail || saving) return;
    setSaving(true);
    setError("");
    try {
      const result =
        detail.status === "OPEN"
          ? await financeApi.submit(id, Number(count), detail.version)
          : await financeApi.verify(id, Number(count), detail.version);
      setDetail(result);
      setCount("");
      onChanged();
    } catch (err) {
      setError(financeError(err));
      setRefresh((value) => value + 1);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Đối soát ca tiền mặt"
      description="Kê khai tiền đã đếm và gửi Admin xác minh để hoàn tất ca."
      size="lg"
      footer={
        <button
          disabled={saving}
          className={secondaryButtonClass}
          onClick={onClose}
        >
          Đóng cửa sổ
        </button>
      }
    >
      <div className="space-y-5" aria-busy={loading || saving}>
        {error && <Feedback tone="danger">{error}</Feedback>}
        {loading && <LoadingState label="Đang tải số tiền trong ca…" />}
        {!loading && !detail && (
          <button
            className={secondaryButtonClass}
            onClick={() => {
              setError("");
              setRefresh((value) => value + 1);
            }}
          >
            Thử lại
          </button>
        )}
        {detail && (
          <CashShiftReview
            detail={detail}
            admin={admin}
            saving={saving}
            loading={loading}
            count={count}
            onCount={setCount}
            onAction={(event) => void save(event)}
            onReload={() => {
              setError("");
              setRefresh((value) => value + 1);
            }}
            onPage={setPage}
          />
        )}
      </div>
    </Modal>
  );
}

export function CashShifts({ admin = false }: { admin?: boolean }) {
  const [current, setCurrent] = useState<CashShift | null>();
  const [list, setList] = useState<ShiftList>();
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [staffId, setStaffId] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState("");
  const [selected, setSelected] = useState<string>();
  const reload = () => setRefresh((value) => value + 1);
  useEffect(() => {
    if (!admin) return;
    const controller = new AbortController();
    void financeApi
      .staff(controller.signal)
      .then(setStaff)
      .catch((err) => {
        if (!controller.signal.aborted) setError(financeError(err));
      });
    return () => controller.abort();
  }, [admin]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setList(undefined);
    setCurrent(undefined);
    void Promise.all([
      financeApi.current(controller.signal),
      financeApi.shifts(
        admin,
        {
          page,
          ...(admin
            ? { status: status || undefined, staffId: staffId || undefined }
            : {}),
        },
        controller.signal,
      ),
    ])
      .then(([active, history]) => {
        if (!controller.signal.aborted) {
          setCurrent(active);
          setList(history);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(financeError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [admin, page, status, staffId, refresh]);

  async function open(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await financeApi.open(Number(opening));
      setOpening("");
      reload();
    } catch (err) {
      setError(financeError(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title={admin ? "Đối soát tiền mặt" : "Ca tiền mặt của tôi"}
        description="Mỗi nhân viên có một ca đang mở hoặc chờ xác minh. Thu CASH được ghi vào ca của người xác nhận thanh toán."
        actions={
          <button
            className={secondaryButtonClass}
            disabled={loading || saving}
            onClick={reload}
          >
            Tải lại
          </button>
        }
      />
      {error && <Feedback tone="danger">{error}</Feedback>}
      {loading && <LoadingState label="Đang tải ca tiền mặt…" />}
      {current !== undefined && (
        <section className={`${panelClass} space-y-4`}>
          <h2 className="text-lg font-bold">Ca hiện tại của tôi</h2>
          {current ? (
            <>
              <p className="text-sm text-slate-600">
                Mở lúc {time(current.openedAt)} · {current.transactionCount} hóa
                đơn CASH
              </p>
              <ShiftCashValues shift={current} />
              {current.status === "PENDING_REVIEW" && (
                <Feedback tone="info">
                  Ca đang chờ Admin xác minh. Chưa thể mở ca mới.
                </Feedback>
              )}
              <button
                className={primaryButtonClass}
                onClick={() => setSelected(current.id)}
              >
                {current.status === "OPEN"
                  ? "Kê khai và gửi đối soát"
                  : "Xem ca chờ xác minh"}
              </button>
            </>
          ) : (
            <form
              className="max-w-md space-y-3"
              onSubmit={(event) => void open(event)}
            >
              <p className="text-sm text-slate-600">
                Mở ca trước khi xác nhận thu tiền mặt.
              </p>
              <label
                htmlFor="opening-cash"
                className="block text-sm font-semibold"
              >
                Tiền đầu ca (VND)
              </label>
              <input
                id="opening-cash"
                className={inputClass}
                type="number"
                inputMode="numeric"
                min="0"
                max={Number.MAX_SAFE_INTEGER}
                step="1"
                required
                value={opening}
                onChange={(event) => setOpening(event.target.value)}
                disabled={saving}
              />
              <button
                className={primaryButtonClass}
                disabled={saving || opening === ""}
              >
                {saving ? "Đang mở ca…" : "Mở ca tiền mặt"}
              </button>
            </form>
          )}
        </section>
      )}
      <section className={`${panelClass} space-y-4`}>
        <h2 className="text-lg font-bold">
          {admin ? "Các ca tiền mặt" : "Lịch sử ca của tôi"}
        </h2>
        {admin && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm font-medium">
              Trạng thái
              <select
                className={inputClass}
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">Tất cả</option>
                <option value="OPEN">Đang mở</option>
                <option value="PENDING_REVIEW">Chờ Admin xác minh</option>
                <option value="CLOSED">Đã đóng</option>
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium">
              Nhân viên
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
        )}
        {list && (
          <>
            {!list.shifts.length ? (
              <p className="py-5 text-sm text-slate-600">Chưa có ca phù hợp.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">
                    Đối soát ca tiền mặt, thời gian Việt Nam
                  </caption>
                  <thead className="bg-slate-50">
                    <tr>
                      {[
                        "Nhân viên",
                        "Mở ca",
                        "Gửi đối soát",
                        "Trạng thái",
                        "Dự kiến",
                        "Kê khai",
                        "Chênh lệch kê khai",
                        "Đã xác minh",
                        "Chênh lệch xác minh",
                        "Thao tác",
                      ].map((label) => (
                        <th
                          scope="col"
                          className="whitespace-nowrap px-4 py-3"
                          key={label}
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {list.shifts.map((shift) => (
                      <tr
                        key={shift.id}
                        className={hasDiscrepancy(shift) ? "bg-amber-50" : ""}
                      >
                        <td className="px-4 py-3 font-medium">
                          {shift.staffName}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {time(shift.openedAt)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {time(shift.submittedAt)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {shiftStatus[shift.status]}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                          {shift.status === "OPEN" &&
                          (!admin || shift.canSubmit)
                            ? "Ẩn khi kê khai"
                            : cashAmount(shift.expectedCash)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                          {cashAmount(shift.declaredCash)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                          {cashAmount(shift.declaredVariance)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                          {cashAmount(shift.verifiedCash)}
                          {shift.status === "CLOSED" &&
                            shift.submittedAt == null &&
                            shift.actualCash != null && (
                              <span className="block text-slate-600">
                                Thực tế ca cũ: {cashAmount(shift.actualCash)}
                              </span>
                            )}
                          {shift.declaredCash != null &&
                            shift.verifiedCash != null &&
                            shift.declaredCash !== shift.verifiedCash && (
                              <span className="block text-xs text-amber-900">
                                Khác kê khai
                              </span>
                            )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 font-semibold tabular-nums">
                          {cashAmount(shift.verifiedVariance)}
                          {shift.status === "CLOSED" &&
                            shift.submittedAt == null &&
                            shift.variance != null && (
                              <span className="block text-slate-600">
                                Chênh lệch ca cũ: {cashAmount(shift.variance)}
                              </span>
                            )}
                          {hasDiscrepancy(shift) && (
                            <span className="block text-xs text-amber-900">
                              Có chênh lệch
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            className={secondaryButtonClass}
                            aria-label={`${admin && shift.canVerify ? "Xác minh ca" : "Chi tiết ca"} ${shift.staffName}, ${time(shift.openedAt)}`}
                            onClick={() => setSelected(shift.id)}
                          >
                            {admin && shift.canVerify
                              ? "Xác minh ca"
                              : "Chi tiết"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={list.total}
              onPage={setPage}
            />
          </>
        )}
      </section>
      {selected && (
        <ShiftDialog
          key={selected}
          id={selected}
          admin={admin}
          onClose={() => setSelected(undefined)}
          onChanged={reload}
        />
      )}
    </div>
  );
}
