import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { isAxiosError } from 'axios';
import { Download, Search } from 'lucide-react';
import { Feedback, PageHeader, primaryButtonClass, secondaryButtonClass } from '../../components/ui';
import { invoiceApi, invoiceCodePattern } from '../../services/api/invoice';
import type { InvoiceDetail } from '../../services/api/invoice';

const money = (amount: number) => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
const paymentLabels = { pending: 'Chờ xác nhận thanh toán', succeeded: 'Đã thanh toán', failed: 'Thanh toán không thành công' };
type SearchState = 'idle' | 'loading' | 'invalid' | 'not-found' | 'success' | 'error';
const messages = {
  invalid: 'Mã hóa đơn không hợp lệ. Nhập theo mẫu INV-20260910-K7P4X2M9.',
  'not-found': 'Không tìm thấy hóa đơn. Vui lòng kiểm tra lại mã.',
  error: 'Chưa thể tra cứu hóa đơn. Vui lòng thử lại.',
};

export function InvoiceLookup() {
  const [input, setInput] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [invoice, setInvoice] = useState<InvoiceDetail>();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function search(event: FormEvent) {
    event.preventDefault();
    const code = input.trim().toUpperCase();
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
      setInvoice(await invoiceApi.lookup(code));
      setState('success');
    } catch (error) {
      const status = isAxiosError(error) ? error.response?.status : undefined;
      setState(status === 404 ? 'not-found' : status === 400 ? 'invalid' : 'error');
    }
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
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div><dt className="text-slate-600">Trạng thái thanh toán</dt><dd className="mt-1 font-semibold">{paymentLabels[invoice.paymentStatus]}</dd></div>
        <div><dt className="text-slate-600">Bàn</dt><dd className="mt-1 font-semibold">{invoice.table.displayName}</dd></div>
        <div><dt className="text-slate-600">Thời gian thanh toán</dt><dd className="mt-1 font-semibold">{invoice.paidAt ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(invoice.paidAt)) : 'Chưa ghi nhận thanh toán'}</dd></div>
        {invoice.vnpTransactionNo && <div><dt className="text-slate-600">Mã VNPAY</dt><dd className="mt-1 break-words font-semibold">{invoice.vnpTransactionNo}</dd></div>}
      </dl>
      <InvoiceRounds invoice={invoice} />
      <dl className="space-y-2 border-t border-slate-200 pt-4 text-sm">
        <div className="flex justify-between gap-4"><dt>Tạm tính</dt><dd>{money(invoice.subtotalAmount)}</dd></div>
        {invoice.discountAmount > 0 && <div className="flex justify-between gap-4"><dt>Giảm giá</dt><dd>−{money(invoice.discountAmount)}</dd></div>}
        <div className="flex justify-between gap-4 text-lg font-bold"><dt>Tổng thanh toán</dt><dd>{money(invoice.totalAmount)}</dd></div>
      </dl>
      {invoice.paymentStatus === 'succeeded' && <button onClick={() => void download()} disabled={downloading} className={secondaryButtonClass}><Download aria-hidden="true" className="h-4 w-4" />{downloading ? 'Đang tải PDF…' : 'Tải lại PDF'}</button>}
      {downloadError && <Feedback tone="danger">{downloadError}</Feedback>}
    </section>}
  </div>;
}

export function InvoiceRounds({ invoice }: { invoice: InvoiceDetail }) {
  return <details open className="rounded-lg border border-slate-200 p-4">
    <summary className="min-h-8 cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-brand-600">Xem chi tiết · {invoice.orders.length} lượt gọi món</summary>
    <div className="mt-4 space-y-6">{invoice.orders.map((order) => <section key={order.sequence}>
      <h3 className="font-semibold text-slate-900">Lượt gọi món #{order.sequence}</h3>
      <ul className="mt-2 divide-y divide-slate-100">{order.items.map((item, index) => <li key={index} className="py-3 text-sm">
        <div className="flex flex-wrap justify-between gap-2"><span className="min-w-0 break-words font-medium">{item.name} × {item.quantity}</span><span className="shrink-0 font-semibold">{money(item.unitPrice * item.quantity)}</span></div>
        <p className="mt-1 text-slate-600">Đơn giá: {money(item.unitPrice)}</p>
        {item.note && <p className="mt-1 break-words text-slate-600">Ghi chú: {item.note}</p>}
      </li>)}</ul>
      <p className="text-right text-sm font-semibold">Thành tiền lượt này: {money(order.totalAmount)}</p>
    </section>)}</div>
  </details>;
}
