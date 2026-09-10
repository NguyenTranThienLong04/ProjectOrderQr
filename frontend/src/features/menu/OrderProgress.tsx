import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { StatusBadge } from '../../components/ui';
import type { SessionPaymentOrder } from '../../services/api/payment';

const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });

function OrderThumbnail({ src }: { src?: string }) {
  const [failedSrc, setFailedSrc] = useState<string>();
  return (
    <div aria-hidden="true" className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-stone-100">
      {src && src !== failedSrc ? (
        <img src={src} alt="" width={48} height={48} loading="lazy" onError={() => setFailedSrc(src)} className="h-full w-full object-contain" />
      ) : (
        <ImageOff className="h-5 w-5 text-stone-400" />
      )}
    </div>
  );
}

export function OrderProgress({ orders, lang }: { orders: SessionPaymentOrder[]; lang: 'vi' | 'en' }) {
  const english = lang === 'en';
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-bold text-stone-950">{english ? 'Order progress' : 'Tiến độ các lượt gọi món'}</h3>
      <ul className="mt-3 divide-y divide-stone-200 rounded-lg border border-stone-200">
        {orders.map((order) => (
          <li key={order.orderId} className="px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-stone-900">{english ? 'Order' : 'Lượt gọi món'} #{order.orderNumber}</p>
                <p className="text-xs text-stone-500">{order.itemCount} {english ? (order.itemCount === 1 ? 'item' : 'items') : 'món'}</p>
              </div>
              <StatusBadge status={order.status} label={english ? order.status : undefined} />
            </div>
            <ul className="mt-3 space-y-3">
              {order.items.map((item, index) => {
                const name = english ? item.nameEn?.trim() || item.dishName : item.dishName;
                return (
                  <li key={index} className="flex items-start gap-3">
                    <OrderThumbnail src={item.imageUrl} />
                    <div className="min-w-0 flex-1">
                      <p className="overflow-wrap-anywhere text-sm font-semibold leading-5 text-stone-900">{name}</p>
                      <p className="mt-0.5 text-xs tabular-nums leading-5 text-stone-600">x{item.quantity} · {currency.format(item.unitPrice)}</p>
                      {item.note?.trim() && <p className="overflow-wrap-anywhere mt-0.5 line-clamp-2 text-xs leading-5 text-amber-800" title={item.note}>{english ? 'Note' : 'Ghi chú'}: {item.note}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
