import { useRef, useState } from 'react';
import { Banknote, LoaderCircle } from 'lucide-react';
import {
  paymentApi,
  type CashSettlementReceipt,
  type CashSettlementSummary,
} from '../services/api/payment';
import {
  Feedback,
  Modal,
  primaryButtonClass,
  secondaryButtonClass,
} from './ui';

const money = (amount: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(
    amount,
  );
const message = (error: unknown) =>
  (error as { response?: { data?: { message?: string } } })?.response?.data
    ?.message ?? 'Chưa thể xác nhận. Hãy tải lại thông tin thanh toán.';

export function CashSettlementAction({
  tableId,
  onSettled,
}: {
  tableId: string;
  onSettled: (receipt: CashSettlementReceipt & { tableCode: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<CashSettlementSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const preview = async () => {
    if (pending.current) return;
    pending.current = true;
    setOpen(true);
    setBusy(true);
    setSummary(null);
    setError('');
    try {
      setSummary(await paymentApi.getCashSettlementSummary(tableId));
    } catch (error) {
      setError(message(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!summary || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const receipt = await paymentApi.settleCash(
        tableId,
        summary.sessionId,
        summary.sessionVersion,
        summary.confirmationKey,
      );
      setOpen(false);
      setSummary(null);
      // The parent owns the result: releasing the table can unmount this action
      // through a socket refresh before the settlement response arrives.
      onSettled({ ...receipt, tableCode: summary.tableCode });
    } catch (error) {
      setError(message(error));
      setSummary(null);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={() => void preview()}
        disabled={busy}
        className={secondaryButtonClass}
      >
        <Banknote aria-hidden="true" className="h-4 w-4 shrink-0" />
        Xác nhận thanh toán tiền mặt
      </button>
      <Modal
        open={open}
        onClose={() => {
          if (!pending.current) setOpen(false);
        }}
        title="Xác nhận thanh toán tiền mặt"
        description="Chỉ xác nhận sau khi đã nhận đủ tiền. Phiên ăn sẽ kết thúc và các bàn trong phiên sẽ chuyển về trống."
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className={secondaryButtonClass}
            >
              Hủy
            </button>
            {summary ? (
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={busy}
                className={primaryButtonClass}
              >
                {busy && (
                  <LoaderCircle
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin"
                  />
                )}
                Đã nhận {money(summary.payableTotal)}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void preview()}
                disabled={busy}
                className={primaryButtonClass}
              >
                Tải lại thông tin
              </button>
            )}
          </>
        }
      >
        <div aria-busy={busy} className="space-y-3">
          {busy && <p role="status">Đang xử lý…</p>}
          {error && <Feedback tone="danger">{error}</Feedback>}
          {summary && (
            <dl className="space-y-3 text-sm">
              <div>
                <dt>Bàn</dt>
                <dd className="font-bold">
                  {summary.tableCode}
                  {summary.tableIds.length > 1
                    ? ` · Nhóm ${summary.tableIds.length} bàn`
                    : ''}
                </dd>
              </div>
              <div>
                <dt>Phiên ăn</dt>
                <dd className="break-all">{summary.sessionId}</dd>
              </div>
              <div>
                <dt>Số lượt gọi món cần thanh toán</dt>
                <dd>{summary.orderCount}</dd>
              </div>
              <div>
                <dt>Tổng tiền phải thu</dt>
                <dd className="text-xl font-bold">
                  {money(summary.payableTotal)}
                </dd>
              </div>
            </dl>
          )}
        </div>
      </Modal>
    </>
  );
}
