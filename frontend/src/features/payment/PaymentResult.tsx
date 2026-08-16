import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  CircleX,
  Clock3,
  LoaderCircle,
  ReceiptText,
} from 'lucide-react';
import { io } from 'socket.io-client';
import { paymentApi } from '../../services/api/payment';
import { secondaryButtonClass } from '../../components/ui';

const socketUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export function PaymentResult() {
  const params = new URLSearchParams(window.location.search);
  const initialResult = params.get('result');
  const txnRef = params.get('txnRef') ?? '';
  const tableId = params.get('tableId') ?? '';
  const sessionId = params.get('sessionId') ?? '';
  const [status, setStatus] = useState<'failed' | 'pending' | 'paid'>(
    initialResult === 'failed' ? 'failed' : 'pending',
  );
  const [invoiceError, setInvoiceError] = useState('');

  useEffect(() => {
    if (!txnRef || !tableId || !sessionId || initialResult === 'failed') return;
    let active = true;
    let joined = false;
    let checked = false;
    const socket = io(socketUrl);
    const checkOnceReady = async () => {
      if (!active || checked || !joined) return;
      checked = true;
      try {
        const payment = await paymentApi.getPaymentStatus(
          txnRef,
          sessionId,
          tableId,
        );
        if (!active) return;
        if (payment.status === 'succeeded') setStatus('paid');
        if (payment.status === 'failed') setStatus('failed');
      } catch {
        // The signed browser return is informational; IPN/socket remains authoritative.
      }
    };
    const updatePayment = (payment: {
      txnRef?: string;
      sessionId?: string;
      status?: string;
    }) => {
      if (
        payment.txnRef === txnRef &&
        payment.sessionId === sessionId &&
        payment.status === 'succeeded'
      ) {
        setStatus('paid');
      }
    };
    socket.on('connect', () =>
      socket.emit('join', { room: `session:${sessionId}` }),
    );
    socket.on('joined', (payload: { room?: string }) => {
      if (payload.room !== `session:${sessionId}`) return;
      joined = true;
      void checkOnceReady();
    });
    socket.on('session:payment-updated', updatePayment);
    return () => {
      active = false;
      socket.off('connect');
      socket.off('joined');
      socket.off('session:payment-updated', updatePayment);
      socket.disconnect();
    };
  }, [txnRef, tableId, sessionId, initialResult]);

  const downloadInvoice = async () => {
    setInvoiceError('');
    try {
      await paymentApi.downloadSessionInvoice(txnRef, sessionId, tableId);
    } catch {
      setInvoiceError('Chưa thể tải hóa đơn tổng hợp. Vui lòng thử lại.');
    }
  };
  const config =
    status === 'paid'
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
        : {
            icon: Clock3,
            title: 'Đang xác nhận thanh toán',
            text: 'Hệ thống đang chờ IPN xác thực từ VNPAY. Không cần tải lại trang.',
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
        <p className="mt-3 text-sm leading-6 text-stone-600">{config.text}</p>
        {status === 'paid' && txnRef && sessionId && tableId && (
          <button
            onClick={() => void downloadInvoice()}
            className={`${secondaryButtonClass} mt-6 w-full`}
          >
            <ReceiptText aria-hidden="true" className="h-4 w-4" />
            Tải hóa đơn tổng hợp
          </button>
        )}
        {invoiceError && (
          <p role="alert" className="mt-3 text-sm font-medium text-red-700">
            {invoiceError}
          </p>
        )}
        <a
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-accent-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-accent-500"
          href={tableId ? `/menu?tableId=${encodeURIComponent(tableId)}` : '/menu'}
        >
          Quay lại menu tại bàn
        </a>
        {status === 'pending' && (
          <p className="mt-4 text-xs text-stone-500">
            Trạng thái sẽ cập nhật theo thời gian thực khi IPN được xác nhận.
          </p>
        )}
      </section>
    </main>
  );
}
