import { ReceiptText } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { CashSettlementReceipt } from '../services/api/payment';
import { Modal, primaryButtonClass, secondaryButtonClass } from './ui';

export type CashSettlementResult = CashSettlementReceipt & { tableCode: string };

export function CashSettlementSuccess({ receipt, invoicePath, onClose }: {
  receipt: CashSettlementResult | null;
  invoicePath: string;
  onClose: () => void;
}) {
  return <Modal
    open={Boolean(receipt)}
    onClose={onClose}
    title="Thanh toán tiền mặt thành công"
    description="Hóa đơn đã được lưu. Bạn có thể tìm lại trong Tra cứu hóa đơn."
    size="sm"
    footer={<>
      <button type="button" onClick={onClose} className={secondaryButtonClass}>Đóng</button>
      {receipt && <Link
        to={`${invoicePath}?invoiceCode=${encodeURIComponent(receipt.invoiceCode)}`}
        className={primaryButtonClass}
      ><ReceiptText aria-hidden="true" className="h-4 w-4" />Xem / In hóa đơn</Link>}
    </>}
  >
    {receipt && <dl className="space-y-3 text-sm">
      <div><dt className="text-slate-600">Bàn</dt><dd className="font-bold">{receipt.tableCode}</dd></div>
      <div><dt className="text-slate-600">Số tiền đã thanh toán</dt><dd className="text-xl font-bold">{new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(receipt.amount)}</dd></div>
      <div><dt className="text-slate-600">Phương thức</dt><dd className="font-semibold">Tiền mặt</dd></div>
      <div><dt className="text-slate-600">Mã hóa đơn</dt><dd className="break-words font-semibold">{receipt.invoiceCode}</dd></div>
    </dl>}
  </Modal>;
}
