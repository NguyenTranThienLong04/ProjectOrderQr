import { OrderNoteMetadata } from '../../components/OrderNoteMetadata';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { BellRing, ChefHat, Clock3, Flame, LoaderCircle, RefreshCw, StickyNote } from 'lucide-react';
import { orderApi, type KitchenOrder, type KitchenItem } from '../../services/api/order';
import { EmptyState, Feedback, PageHeader, StatusBadge, primaryButtonClass, secondaryButtonClass } from '../../components/ui';

import { API_URL as socketUrl } from '../../config/api-url';
const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : 'Vui lòng thử lại.';
const elapsed = (createdAt?: string, now = Date.now()) => {
  if (!createdAt) return 'Mới nhận';
  const minutes = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 60000));
  return minutes < 1 ? 'Vừa nhận' : `${minutes} phút`;
};

type Ticket = { order: KitchenOrder; item: KitchenItem };

export default function KitchenDisplay() {
  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [updatingItemId, setUpdatingItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const loadPromiseRef = useRef<Promise<void> | null>(null);

  const load = useCallback(() => {
    if (loadPromiseRef.current) return loadPromiseRef.current;
    const request = orderApi.listForKitchen()
      .then((nextOrders) => { setOrders(nextOrders); setError(null); })
      .catch((loadError: unknown) => { setError(`Không thể tải danh sách bếp: ${getErrorMessage(loadError)}`); })
      .finally(() => {
        setLoading(false);
        if (loadPromiseRef.current === request) loadPromiseRef.current = null;
      });
    loadPromiseRef.current = request;
    return request;
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const socket = io(socketUrl);
    socket.on('connect', () => socket.emit('join', { room: 'kitchen' }));
    socket.on('order:updated', () => void load());
    return () => { socket.removeAllListeners(); socket.disconnect(); };
  }, [load]);

  const tickets = useMemo(() => orders.flatMap((order) => order.items.map((item) => ({ order, item }))), [orders]);
  const pending = tickets.filter(({ item }) => item.status === 'Pending');
  const preparing = tickets.filter(({ item }) => item.status === 'Preparing');

  const transition = async (ticket: Ticket, status: 'Preparing' | 'Ready') => {
    if (updatingItemId) return;
    setUpdatingItemId(ticket.item.itemId); setError(null);
    try { await orderApi.transitionItem(ticket.order.orderId, ticket.item.itemId, status); await load(); }
    catch (transitionError) { setError(`Không thể chuyển trạng thái: ${getErrorMessage(transitionError)}`); }
    finally { setUpdatingItemId(null); }
  };

  const TicketCard = ({ ticket, lane }: { ticket: Ticket; lane: 'Pending' | 'Preparing' }) => {
    const isUpdating = updatingItemId === ticket.item.itemId;
    const waiting = elapsed(ticket.order.createdAt, now);
    const urgent = ticket.order.createdAt ? now - new Date(ticket.order.createdAt).getTime() > 15 * 60000 : false;
    return <article className={`overflow-hidden rounded-xl border bg-white ${urgent ? 'border-red-300' : lane === 'Pending' ? 'border-amber-200' : 'border-blue-200'}`}>
      <div className={`flex items-center justify-between gap-3 border-b px-4 py-3 ${urgent ? 'border-red-200 bg-red-50' : lane === 'Pending' ? 'border-amber-100 bg-amber-50' : 'border-blue-100 bg-blue-50'}`}>
        <div><p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Bàn</p><h3 className="text-3xl font-black leading-none text-slate-950">{ticket.order.tableDisplayName}</h3></div>
        <div className="text-right"><StatusBadge status={lane} /><p className={`mt-1.5 flex items-center justify-end gap-1 text-sm font-bold tabular-nums ${urgent ? 'text-red-700' : 'text-slate-600'}`}><Clock3 aria-hidden="true" className="h-4 w-4" />{waiting}</p></div>
      </div>
      <div className="p-4"><div className="flex items-start gap-3"><span className="tabular-nums grid h-11 min-w-11 place-items-center rounded-lg bg-slate-950 px-2 text-xl font-black text-white">{ticket.item.quantity}×</span><div className="min-w-0 flex-1"><p className="text-xl font-bold leading-7 text-slate-950">{ticket.item.dishName}</p>{ticket.item.note && <p className="overflow-wrap-anywhere mt-2 flex items-start gap-2 whitespace-pre-wrap rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-sm font-semibold leading-5 text-amber-950"><StickyNote aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /><span>Ghi chú khách: {ticket.item.note}</span></p>}<OrderNoteMetadata analysis={ticket.item.aiNoteAnalysis} /></div></div>
        <button disabled={isUpdating} onClick={() => void transition(ticket, lane === 'Pending' ? 'Preparing' : 'Ready')} className={`${primaryButtonClass} mt-5 min-h-14 w-full text-base ${lane === 'Pending' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-700 hover:bg-emerald-800'}`}>{isUpdating ? <><LoaderCircle aria-hidden="true" className="h-5 w-5 animate-spin" />Đang cập nhật…</> : lane === 'Pending' ? <><Flame aria-hidden="true" className="h-5 w-5" />Bắt đầu chế biến</> : <><BellRing aria-hidden="true" className="h-5 w-5" />Món đã sẵn sàng</>}</button>
      </div>
    </article>;
  };

  return <main id="main-content" tabIndex={-1} className="min-h-[calc(100dvh-4rem)] bg-slate-100 px-4 py-5 text-slate-900 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-[100rem] space-y-5">
      <PageHeader eyebrow="Kitchen display" title="Điều phối món tại bếp" description="Hai hàng đợi cập nhật theo thời gian thực. Ưu tiên ticket có thời gian chờ màu đỏ." actions={<button onClick={() => void load()} className={secondaryButtonClass}><RefreshCw aria-hidden="true" className="h-4 w-4" />Tải lại</button>} />
      {error && <Feedback tone="danger">{error}</Feedback>}
      <div className="grid grid-cols-2 gap-3 sm:max-w-xl"><div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-sm font-semibold text-amber-900">Món mới</p><p className="tabular-nums mt-1 text-3xl font-black text-amber-950">{pending.length}</p></div><div className="rounded-xl border border-blue-200 bg-blue-50 p-4"><p className="text-sm font-semibold text-blue-900">Đang chế biến</p><p className="tabular-nums mt-1 text-3xl font-black text-blue-950">{preparing.length}</p></div></div>
      {loading ? <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-600"><LoaderCircle aria-hidden="true" className="mx-auto h-6 w-6 animate-spin text-brand-600" /><p className="mt-2">Đang nhận danh sách món…</p></div> : tickets.length === 0 ? <EmptyState icon={ChefHat} title="Bếp đã xử lý hết món" description="Món mới sẽ xuất hiện tự động khi khách gửi đơn." /> : <div className="grid gap-5 xl:grid-cols-2">
        <section aria-labelledby="pending-title"><div className="mb-3 flex items-center justify-between"><h2 id="pending-title" className="flex items-center gap-2 text-lg font-bold"><span className="h-3 w-3 rounded-full bg-amber-500" />Món mới cần bắt đầu</h2><span className="tabular-nums text-sm font-semibold text-slate-500">{pending.length} ticket</span></div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">{pending.length ? pending.map((ticket) => <TicketCard key={ticket.item.itemId} ticket={ticket} lane="Pending" />) : <EmptyState icon={Flame} title="Không có món mới" description="Theo dõi cột đang chế biến để hoàn tất các món còn lại." />}</div></section>
        <section aria-labelledby="preparing-title"><div className="mb-3 flex items-center justify-between"><h2 id="preparing-title" className="flex items-center gap-2 text-lg font-bold"><span className="h-3 w-3 rounded-full bg-blue-500" />Đang chế biến</h2><span className="tabular-nums text-sm font-semibold text-slate-500">{preparing.length} ticket</span></div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">{preparing.length ? preparing.map((ticket) => <TicketCard key={ticket.item.itemId} ticket={ticket} lane="Preparing" />) : <EmptyState icon={ChefHat} title="Chưa có món đang chế biến" description="Bắt đầu một món mới từ hàng đợi bên cạnh." />}</div></section>
      </div>}
    </div>
  </main>;
}
