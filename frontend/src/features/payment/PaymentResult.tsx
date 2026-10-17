import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleX,
  Clock3,
  LoaderCircle,
  ReceiptText,
} from 'lucide-react';
import { createCustomerSocket } from '../../services/socket-client';
import { customerScopeTable } from '../../services/customer-access';
import { paymentApi } from '../../services/api/payment';
import { secondaryButtonClass } from '../../components/ui';
import { createPaymentRecovery, type PaymentRecoveryStatus } from '../../services/payment-recovery';
import { bindSnapshotRecovery } from '../../services/snapshot-refresh';


export function PaymentResult() {
  const params = new URLSearchParams(window.location.search);
  const txnRef = params.get('txnRef') ?? '';
  const tableId = params.get('tableId') ?? '';
  const sessionId = params.get('sessionId') ?? '';
  const [status, setStatus] = useState<PaymentRecoveryStatus>('pending');
  const recoveryRef = useRef<ReturnType<typeof createPaymentRecovery> | null>(null);
  const [invoiceError, setInvoiceError] = useState('');
  const [invoiceCode, setInvoiceCode] = useState<string>();
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    setInvoiceCode(undefined);
    if (!txnRef || !tableId || !sessionId) { setStatus('unknown'); return; }
    const recovery = createPaymentRecovery(
      async (signal) => {
        const payment = await paymentApi.getPaymentStatus(txnRef, sessionId, tableId, signal);
        if (payment.txnRef !== txnRef || payment.sessionId !== sessionId) throw new Error('Payment scope mismatch');
        return payment;
      },
      (next, payment) => { setStatus(next); if (payment) setInvoiceCode(payment.invoiceCode); },
    );
    recoveryRef.current = recovery;
    void recovery.check(); // Independent of Socket connection, room join, or URL result.
    const socket = createCustomerSocket(customerScopeTable(sessionId, tableId), sessionId);
    const unbind = bindSnapshotRecovery(socket, recovery.recheck, () => socket.emit('join', { room: `session:${sessionId}` }));
    const updatePayment = (payment: {
      txnRef?: string;
      sessionId?: string;
      status?: string;
    }) => {
      if (
        payment.txnRef === txnRef &&
        payment.sessionId === sessionId
      ) {
        void recovery.recheck();
      }
    };
    socket.on('session:payment-updated', updatePayment);
    socket.on('session:closed', (event: { sessionId?: string }) => {
      if (event.sessionId === sessionId) void recovery.recheck();
    });
    return () => {
      recovery.dispose(); recoveryRef.current = null; unbind();
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [txnRef, tableId, sessionId]);

  const downloadInvoice = async () => {
    setInvoiceError('');
    setDownloading(true);
    try {
      const code = await paymentApi.downloadSessionInvoice(txnRef, sessionId, tableId);
      if (code) setInvoiceCode(code);
    } catch {
      setInvoiceError('Chưa thể tải hóa đơn tổng hợp. Vui lòng thử lại.');
    } finally {
      setDownloading(false);
    }
  };
  const config =
    status === 'superseded' ? {
      icon: CheckCircle2,
      title: 'Đã thanh toán tiền mặt',
      text: 'Nhân viên đã xác nhận tiền mặt và đóng phiên ăn. Checkout VNPAY này đã được thay thế. Nếu ngân hàng vẫn trừ tiền, hãy liên hệ nhân viên để đối soát.',
      color: 'bg-emerald-50 text-emerald-700',
    } : status === 'paid'
      ? {
          icon: CheckCircle2,
          title: 'Thanh toán thành công',
          text: 'VNPAY đã xác nhận một giao dịch cho toàn bộ các lượt gọi món trong hóa đơn này.',
          color: 'bg-emerald-50 text-emerald-700',
        }
      : status === 'failed'
        ? {
            icon: CircleX,
            title: 'Giao dịch chưa thành công',
            text: 'Giao dịch bị hủy hoặc thất bại. Phiên ăn và toàn bộ đơn vẫn được giữ nguyên để bạn thanh toán lại.',
            color: 'bg-red-50 text-red-700',
          }
        : status === 'unknown' ? {
            icon: Clock3,
            title: 'Chưa xác minh được thanh toán',
            text: txnRef && tableId && sessionId
              ? 'Chưa nhận được kết quả cuối cùng từ hệ thống. Hãy kiểm tra lại hoặc liên hệ nhân viên trước khi thanh toán thêm.'
              : 'Thiếu thông tin giao dịch để kiểm tra. Vui lòng liên hệ nhân viên để xác minh.',
            color: 'bg-amber-50 text-amber-700',
          } : {
            icon: Clock3,
            title: 'Đang xác nhận thanh toán',
            text: 'Đang kiểm tra kết quả thanh toán với hệ thống. Vui lòng chờ trong giây lát.',
            color: 'bg-blue-50 text-blue-700',
          };
  const Icon = config.icon;
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="grid min-h-dvh place-items-center bg-[#f8f5ef] p-5"
    >
      <section className="w-full max-w-md rounded-xl border border-stone-200 bg-white p-6 text-center shadow-sm sm:p-8">
        <span
          className={`mx-auto grid h-14 w-14 place-items-center rounded-full ${config.color}`}
        >
          {status === 'pending' ? (
            <LoaderCircle aria-hidden="true" className="h-7 w-7 animate-spin" />
          ) : (
            <Icon aria-hidden="true" className="h-7 w-7" />
          )}
        </span>
        <h1 className="mt-5 text-2xl font-bold text-stone-950">
          {config.title}
        </h1>
        <p role="status" className="mt-3 text-sm leading-6 text-stone-600">{config.text}</p>
        {status === 'unknown' && txnRef && sessionId && tableId && <button className={`${secondaryButtonClass} mt-4 w-full`} onClick={() => void recoveryRef.current?.check()}>Kiểm tra lại</button>}
        {status === 'paid' && invoiceCode && <p className="mt-3 break-words text-sm font-semibold">Mã hóa đơn: {invoiceCode}</p>}
        {status === 'paid' && txnRef && sessionId && tableId && (
          <button
            onClick={() => void downloadInvoice()}
            disabled={downloading}
            className={`${secondaryButtonClass} mt-6 w-full`}
          >
            <ReceiptText aria-hidden="true" className="h-4 w-4" />
            {downloading ? 'Đang tải hóa đơn…' : 'Tải hóa đơn tổng hợp'}
          </button>
        )}
        {invoiceError && (
          <p role="alert" className="mt-3 text-sm font-medium text-red-700">
            {invoiceError}
          </p>
        )}
        {status !== 'superseded' && <a
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-accent-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-accent-500"
          href={tableId ? `/menu?tableId=${encodeURIComponent(customerScopeTable(sessionId, tableId))}&sessionId=${encodeURIComponent(sessionId)}` : '/menu'}
        >
          Quay lại menu tại bàn
        </a>}
        {status === 'superseded' && <p className="mt-4 text-sm text-stone-600">Quét lại QR trên bàn để bắt đầu phiên mới.</p>}
        {status === 'pending' && (
          <p className="mt-4 text-xs text-stone-500">
            Kết quả được kiểm tra qua HTTP ngay cả khi mất kết nối cập nhật trực tiếp.
          </p>
        )}
      </section>
    </main>
  );
}
