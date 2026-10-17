import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { FormEvent } from 'react';
import { isAxiosError } from 'axios';
import { Download, Search } from 'lucide-react';
import { Feedback, PageHeader, primaryButtonClass, secondaryButtonClass } from '../../components/ui';
import { invoiceApi, invoiceCodePattern } from '../../services/api/invoice';
import type { InvoiceDetail, RecentCashInvoice } from '../../services/api/invoice';

const money = (amount: number) => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
const paymentLabels = { pending: 'Chờ xác nhận thanh toán', succeeded: 'Đã thanh toán', failed: 'Thanh toán không thành công', provider_rejected: 'Cổng thanh toán từ chối', superseded: 'Đã thay thế bằng thanh toán tiền mặt' };
type SearchState = 'idle' | 'loading' | 'invalid' | 'not-found' | 'success' | 'error';
const messages = {
  invalid: 'Mã hóa đơn không hợp lệ. Nhập theo mẫu INV-20260910-K7P4X2M9.',
  'not-found': 'Không tìm thấy hóa đơn. Vui lòng kiểm tra lại mã.',
  error: 'Chưa thể tra cứu hóa đơn. Vui lòng thử lại.',
};

export function InvoiceLookup() {
  const [params, setParams] = useSearchParams();
  const selectedCode = params.get('invoiceCode') ?? '';
  const [input, setInput] = useState(selectedCode);
  const [state, setState] = useState<SearchState>('idle');
  const [invoice, setInvoice] = useState<InvoiceDetail>();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<RecentCashInvoice[]>([]);
  const [recentError, setRecentError] = useState('');
  const requestId = useRef(0);

  useEffect(() => {
    let active = true;
    void invoiceApi.recentCash().then((receipts) => { if (active) setRecent(receipts); })
      .catch(() => { if (active) setRecentError('Chưa thể tải hóa đơn tiền mặt gần đây. Bạn vẫn có thể tra cứu bằng mã.'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    if (selectedCode) void lookup(selectedCode, controller.signal);
    else { requestId.current++; setInput(''); setInvoice(undefined); setState('idle'); }
    return () => controller.abort();
  }, [selectedCode]);

  async function lookup(value: string, signal?: AbortSignal) {
    const id = ++requestId.current;
    const code = value.trim().toUpperCase();
    setInput(code);
    setInvoice(undefined);
    setDownloadError('');
    if (!invoiceCodePattern.test(code)) {
      setState('invalid');
      inputRef.current?.focus();
      return;
    }
    setState('loading');
    try {
      const result = await invoiceApi.lookup(code, signal);
      if (signal?.aborted || id !== requestId.current) return;
      setInvoice(result);
      setState('success');
    } catch (error) {
      if (signal?.aborted || id !== requestId.current) return;
      const status = isAxiosError(error) ? error.response?.status : undefined;
      setState(status === 404 ? 'not-found' : status === 400 ? 'invalid' : 'error');
    }
  }

  function search(event: FormEvent) {
    event.preventDefault();
    const code = input.trim().toUpperCase();
    if (!invoiceCodePattern.test(code) || code === selectedCode) void lookup(code);
    else setParams({ invoiceCode: code });
  }

  async function download() {
    if (!invoice) return;
    setDownloading(true);
    setDownloadError('');
    try { await invoiceApi.download(invoice.invoiceCode); }
    catch { setDownloadError('Chưa thể tải PDF. Vui lòng thử lại.'); }
    finally { setDownloading(false); }
  }

  return <div className="mx-auto max-w-4xl space-y-6">
    <PageHeader title="Tra cứu hóa đơn" description="Nhập mã trên hóa đơn để xem các lượt gọi món và tải lại PDF." />
    <form onSubmit={(event) => void search(event)} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 sm:p-6" aria-busy={state === 'loading'}>
      <label htmlFor="invoice-code" className="block text-sm font-semibold text-slate-800">Mã hóa đơn</label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input ref={inputRef} id="invoice-code" value={input} onChange={(event) => setInput(event.target.value)} placeholder="INV-20260910-K7P4X2M9" maxLength={64} disabled={state === 'loading' || downloading} autoComplete="off" spellCheck={false} aria-invalid={state === 'invalid'} aria-describedby="invoice-hint" className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600" />
        <button type="submit" disabled={state === 'loading' || downloading} className={primaryButtonClass}><Search aria-hidden="true" className="h-4 w-4" />{state === 'loading' ? 'Đang tra cứu…' : 'Tra cứu'}</button>
      </div>
      <p id="invoice-hint" className="text-sm text-slate-600">Ví dụ: INV-20260910-K7P4X2M9. Có thể nhập chữ thường.</p>
      {state === 'loading' && <p role="status" className="text-sm text-slate-600">Đang tìm hóa đơn…</p>}
      {(state === 'invalid' || state === 'not-found' || state === 'error') && <Feedback tone="danger">{messages[state]}</Feedback>}
    </form>
    {state === 'success' && invoice && <section aria-label="Kết quả tra cứu" className="space-y-5 rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
      <p role="status" className="text-sm font-medium text-emerald-700">Đã tìm thấy hóa đơn.</p>
      <h2 className="break-words text-lg font-bold text-slate-950">{invoice.invoiceCode}</h2>
      {invoice.replacementInvoiceCode && <p className="break-words text-sm">Hóa đơn tiền mặt thay thế: {invoice.replacementInvoiceCode}</p>}
      {invoice.reconciliationRequired && <Feedback tone="warning">VNPAY ghi nhận tiền sau khi đã thu tiền mặt. Cần đối soát và xử lý khoản thu trùng.</Feedback>}
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        {invoice.paymentMethod && <div><dt className="text-slate-600">Phương thức</dt><dd className="mt-1 font-semibold">{invoice.paymentMethod === 'CASH' ? 'Tiền mặt (CASH)' : invoice.paymentMethod === 'vnpay' ? 'VNPAY' : 'Thanh toán 0 đồng'}</dd></div>}
        <div><dt className="text-slate-600">Trạng thái thanh toán</dt><dd className="mt-1 font-semibold">{paymentLabels[invoice.paymentStatus]}</dd></div>
        <div><dt className="text-slate-600">Bàn</dt><dd className="mt-1 font-semibold">{invoice.table.displayName}</dd></div>
        <div><dt className="text-slate-600">Thời gian thanh toán</dt><dd className="mt-1 font-semibold">{invoice.paidAt ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(invoice.paidAt)) : 'Chưa ghi nhận thanh toán'}</dd></div>
        {invoice.settledByName && <div><dt className="text-slate-600">Nhân viên xác nhận</dt><dd className="mt-1 font-semibold">{invoice.settledByName}</dd></div>}
        {invoice.paymentMethod !== 'CASH' && invoice.vnpTransactionNo && <div><dt className="text-slate-600">Mã VNPAY</dt><dd className="mt-1 break-words font-semibold">{invoice.vnpTransactionNo}</dd></div>}
      </dl>
      <InvoiceRounds invoice={invoice} />
      <dl className="space-y-2 border-t border-slate-200 pt-4 text-sm">
        <div className="flex justify-between gap-4"><dt>Tạm tính</dt><dd>{money(invoice.subtotalAmount)}</dd></div>
        {invoice.discountAmount > 0 && <div className="flex justify-between gap-4"><dt>Giảm giá</dt><dd>−{money(invoice.discountAmount)}</dd></div>}
        <div className="flex justify-between gap-4 text-lg font-bold"><dt>Tổng thanh toán</dt><dd>{money(invoice.totalAmount)}</dd></div>
      </dl>
      {invoice.paymentStatus === 'succeeded' && <button onClick={() => void download()} disabled={downloading} className={secondaryButtonClass}><Download aria-hidden="true" className="h-4 w-4" />{downloading ? 'Đang tải PDF…' : 'Tải lại PDF'}</button>}
      {invoice.paymentStatus === 'succeeded' && <p className="text-sm text-slate-600">Mở PDF đã tải để xem hoặc in hóa đơn.</p>}
      {downloadError && <Feedback tone="danger">{downloadError}</Feedback>}
    </section>}
    <section aria-label="Hóa đơn tiền mặt gần đây" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
      <h2 className="text-lg font-bold text-slate-950">Hóa đơn tiền mặt gần đây</h2>
      <p className="text-sm text-slate-600">20 hóa đơn gần nhất. Với hóa đơn cũ hơn, nhập mã để tra cứu.</p>
      {recentError && <Feedback tone="warning">{recentError}</Feedback>}
      <ul className="divide-y divide-slate-200">{recent.map((receipt) => <li key={receipt.invoiceCode}>
        <Link to={`?invoiceCode=${encodeURIComponent(receipt.invoiceCode)}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg py-3 text-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600">
          <span className="min-w-0"><span className="block break-words font-semibold text-brand-700">{receipt.invoiceCode}</span><span className="text-slate-600">Bàn {receipt.table.displayName}{receipt.paidAt ? ` · ${new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(receipt.paidAt))}` : ''}</span></span>
          <span className="font-semibold">{money(receipt.amount)}</span>
        </Link>
      </li>)}</ul>
    </section>
  </div>;
}

export function InvoiceRounds({ invoice }: { invoice: InvoiceDetail }) {
  return <details open className="rounded-lg border border-slate-200 p-4">
    <summary className="min-h-8 cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-brand-600">Xem chi tiết · {invoice.orders.length} lượt gọi món</summary>
    <div className="mt-4 space-y-6">{invoice.orders.map((order) => <section key={order.sequence}>
      <h3 className="font-semibold text-slate-900">Lượt gọi món #{order.sequence}</h3>
      <ul className="mt-2 divide-y divide-slate-100">{order.items.map((item, index) => <li key={index} className="py-3 text-sm">
        <div className="flex flex-wrap justify-between gap-2"><span className="min-w-0 break-words font-medium">{item.name} × {item.quantity}</span><span className="shrink-0 font-semibold">{money(item.status === 'Rejected' ? 0 : item.unitPrice * item.quantity)}</span></div>
        {item.status === 'Rejected' && <div className="mt-1 text-red-800"><p className="font-semibold">Bếp từ chối · Không tính tiền · Giá trị gốc: {money(item.unitPrice * item.quantity)}</p><p className="whitespace-pre-wrap break-words">Lý do: {item.rejectionReason}</p></div>}
        <p className="mt-1 text-slate-600">Đơn giá: {money(item.unitPrice)}</p>
        {item.note && <p className="mt-1 break-words text-slate-600">Ghi chú: {item.note}</p>}
      </li>)}</ul>
      {order.discountAmount > 0 && <p className="text-right text-sm text-slate-600">Giảm giá{order.promotionCode ? ` (${order.promotionCode})` : ''}: −{money(order.discountAmount)}</p>}
      <p className="text-right text-sm font-semibold">Thành tiền lượt này: {money(order.totalAmount)}</p>
    </section>)}</div>
  </details>;
}
