import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  BellRing,
  ChefHat,
  CreditCard,
  ImageOff,
  Languages,
  LoaderCircle,
  Minus,
  Plus,
  Search,
  ShoppingBag,
  StickyNote,
  Tag,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import { menuApi, type PublicDish, type PublicMenu, type SharedCart } from '../../services/api/menu';
import { paymentApi, type SessionPaymentSummary } from '../../services/api/payment';
import { promotionApi, type PromotionPreview } from '../../services/api/promotion';
import { EmptyState, Feedback, Modal, StatusBadge, controlClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui';
import { ReviewFeedback } from './ReviewFeedback';

const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });
const socketUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function apiMessage(error: unknown, fallback: string) {
  return (error as { response?: { data?: { message?: string } } }).response?.data?.message ?? fallback;
}

export function CustomerMenu() {
  const [tableId, setTableId] = useState(new URLSearchParams(window.location.search).get('tableId') ?? '');
  const [lang, setLang] = useState<'vi' | 'en'>(() => new URLSearchParams(window.location.search).get('lang') === 'en' ? 'en' : 'vi');
  const [menu, setMenu] = useState<PublicMenu | null>(null);
  const [sharedCart, setSharedCart] = useState<SharedCart | null>(null);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedDish, setSelectedDish] = useState<PublicDish | null>(null);
  const [dishNote, setDishNote] = useState('');
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [waiterConfirmOpen, setWaiterConfirmOpen] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isOrdering, setIsOrdering] = useState(false);
  const [orderMessage, setOrderMessage] = useState('');
  const [paymentSummary, setPaymentSummary] = useState<SessionPaymentSummary | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [isCallingWaiter, setIsCallingWaiter] = useState(false);
  const [promotionCode, setPromotionCode] = useState('');
  const [promotionPreview, setPromotionPreview] = useState<PromotionPreview | null>(null);
  const [promotionError, setPromotionError] = useState('');
  const [isApplyingPromotion, setIsApplyingPromotion] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const cartDialogRef = useRef<HTMLElement | null>(null);
  const menuLoadRef = useRef<{ key: string; request: Promise<void> } | null>(null);
  const paymentSummaryRequestRef = useRef<{ key: string; request: Promise<SessionPaymentSummary> } | null>(null);
  const queuedPaymentRefreshRef = useRef<{ sessionId: string; tableId: string } | null>(null);

  const refreshPaymentSummary = useCallback((sessionId: string, ownerTableId = tableId, queueIfBusy = false): Promise<SessionPaymentSummary> => {
    const key = `${sessionId}:${ownerTableId}`;
    const existing = paymentSummaryRequestRef.current;
    if (existing?.key === key) {
      if (queueIfBusy) queuedPaymentRefreshRef.current = { sessionId, tableId: ownerTableId };
      return existing.request;
    }
    const request = paymentApi.getSessionSummary(sessionId, ownerTableId)
      .then((summary) => { setPaymentSummary(summary); return summary; })
      .finally(() => {
        if (paymentSummaryRequestRef.current?.request !== request) return;
        paymentSummaryRequestRef.current = null;
        const queued = queuedPaymentRefreshRef.current;
        queuedPaymentRefreshRef.current = null;
        if (queued) void refreshPaymentSummary(queued.sessionId, queued.tableId);
      });
    paymentSummaryRequestRef.current = { key, request };
    return request;
  }, [tableId]);

  const loadMenu = useCallback((nextLang = lang) => {
    const normalizedTableId = tableId.trim();
    if (!normalizedTableId) return Promise.resolve();
    const requestKey = `${normalizedTableId}:${nextLang}`;
    if (menuLoadRef.current?.key === requestKey) return menuLoadRef.current.request;
    setIsLoading(true); setError(''); setSharedCart(null); setPaymentSummary(null);
    const request = Promise.all([menuApi.get(normalizedTableId, nextLang), menuApi.getActiveSession(normalizedTableId)])
      .then(async ([result, cart]) => {
        setMenu(result); setSharedCart(cart);
        await refreshPaymentSummary(cart.sessionId, normalizedTableId);
        window.history.replaceState(null, '', `/menu?tableId=${encodeURIComponent(normalizedTableId)}&lang=${nextLang}`);
      })
      .catch(() => { setMenu(null); setError('Không tìm thấy bàn hoặc chưa thể tải menu. Kiểm tra mã bàn rồi thử lại.'); })
      .finally(() => {
        setIsLoading(false);
        if (menuLoadRef.current?.request === request) menuLoadRef.current = null;
      });
    menuLoadRef.current = { key: requestKey, request };
    return request;
  }, [tableId, lang, refreshPaymentSummary]);

  // QR entry is loaded once; later language/table submissions call loadMenu explicitly.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadMenu(); }, []);

  useEffect(() => {
    if (!sharedCart?.sessionId) return;
    const socket = io(socketUrl);
    socketRef.current = socket;
    socket.on('connect', () => { socket.emit('cart:join', { sessionId: sharedCart.sessionId }); socket.emit('join', { room: `table:${tableId}` }); });
    socket.on('cart:synced', (cart: SharedCart) => { setSharedCart(cart); setIsSyncing(false); });
    socket.on('session:table-added', () => void loadMenu());
    socket.on('session:merged', () => void loadMenu());
    socket.on('session:merged_or_moved', () => void loadMenu());
    socket.on('session:unmerged', () => void loadMenu());
    socket.on('cart:error', (message: string) => { setError(message); setIsSyncing(false); });
    socket.on('waiter:call:accepted', () => { setIsCallingWaiter(false); setWaiterConfirmOpen(false); setOrderMessage('Yêu cầu đã gửi. Nhân viên phục vụ sẽ đến bàn sớm.'); });
    socket.on('waiter:call:error', (message: string) => { setIsCallingWaiter(false); setError(message); });
    socket.on('order:updated', () => void refreshPaymentSummary(sharedCart.sessionId, tableId, true));
    socket.on('session:payment-updated', (payment: { sessionId?: string; status?: string }) => {
      if (payment.sessionId !== sharedCart.sessionId) return;
      if (payment.status === 'succeeded') setOrderMessage('VNPAY đã xác nhận thanh toán cho các lượt gọi món trong hóa đơn.');
      void refreshPaymentSummary(sharedCart.sessionId, tableId);
    });
    return () => { socket.removeAllListeners(); socket.disconnect(); socketRef.current = null; };
  }, [sharedCart?.sessionId, tableId, loadMenu, refreshPaymentSummary]);

  useEffect(() => {
    if (!isCartOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const handleCartKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return setIsCartOpen(false);
      if (event.key !== 'Tab' || !cartDialogRef.current) return;
      const focusable = Array.from(cartDialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]'));
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleCartKeys);
    window.setTimeout(() => cartDialogRef.current?.focus(), 0);
    return () => { document.body.style.overflow = ''; document.removeEventListener('keydown', handleCartKeys); previous?.focus(); };
  }, [isCartOpen]);

  const dishes = useMemo(() => menu?.categories.flatMap((category) => category.dishes.map((dish) => ({ ...dish, categoryId: category.id }))) ?? [], [menu]);
  const visibleDishes = dishes.filter((dish) => (selectedCategory === 'all' || dish.categoryId === selectedCategory) && dish.name.toLowerCase().includes(search.trim().toLowerCase()));
  const cart = sharedCart?.cart ?? [];
  const cartTotal = cart.reduce((total, item) => total + item.unitPrice * item.quantity, 0);
  const cartCount = cart.reduce((total, item) => total + item.quantity, 0);

  useEffect(() => {
    setPromotionPreview(null);
    setPromotionError('');
  }, [cartTotal]);

  const emitCart = (event: string, payload: Record<string, unknown>) => {
    if (!sharedCart || !socketRef.current?.connected) return setError('Giỏ hàng đang kết nối lại. Vui lòng thử sau ít giây.');
    setIsSyncing(true); setPromotionPreview(null); setPromotionError('');
    socketRef.current.emit(event, { sessionId: sharedCart.sessionId, ...payload });
  };
  const openDish = (dish: PublicDish) => { setSelectedDish(dish); setDishNote(''); };
  const closeDish = () => { setSelectedDish(null); setDishNote(''); };
  const addDish = (dish: PublicDish, note?: string) => emitCart('cart:add', { dishId: dish._id, quantity: 1, note });
  const changeQuantity = (cartItemId: string, dishId: string, quantity: number) => quantity <= 0
    ? emitCart('cart:remove', { cartItemId, dishId })
    : emitCart('cart:update-quantity', { cartItemId, dishId, quantity });

  const applyPromotion = async () => {
    setIsApplyingPromotion(true); setPromotionError('');
    try { setPromotionPreview(await promotionApi.preview(promotionCode, tableId)); }
    catch (requestError) { setPromotionPreview(null); setPromotionError(apiMessage(requestError, 'Mã giảm giá chưa thể áp dụng.')); }
    finally { setIsApplyingPromotion(false); }
  };
  const submitOrder = async () => {
    if (!tableId || cart.length === 0) return;
    setIsOrdering(true); setError('');
    try {
      const order = await menuApi.createOrder({ tableId, promotionCode: promotionPreview?.code });
      await refreshPaymentSummary(order.sessionId, tableId);
      setIsCartOpen(false);
      setOrderMessage('Đơn đã được gửi đến bếp. Bạn có thể theo dõi tiến độ ngay bên dưới.');
    } catch (requestError) { setError(apiMessage(requestError, 'Không thể gửi đơn. Vui lòng kiểm tra giỏ hàng và thử lại.')); }
    finally { setIsOrdering(false); }
  };
  const startPayment = async () => {
    if (!sharedCart?.sessionId || !paymentSummary?.canPay) return;
    setIsPaying(true); setError('');
    try { window.location.assign((await paymentApi.createPaymentUrl(sharedCart.sessionId, tableId)).paymentUrl); }
    catch (requestError) { setError(apiMessage(requestError, 'Không thể tạo liên kết thanh toán VNPAY. Vui lòng thử lại.')); }
    finally { setIsPaying(false); }
  };
  const callWaiter = () => {
    if (!tableId || !socketRef.current?.connected) return setError('Đang kết nối lại. Vui lòng gọi phục vụ sau ít giây.');
    setError(''); setIsCallingWaiter(true); socketRef.current.emit('waiter:call', { tableId });
  };

  const canPay = Boolean(paymentSummary?.canPay);

  return <main id="main-content" tabIndex={-1} className={`min-h-dvh bg-[#f8f5ef] text-stone-900 ${cartCount > 0 ? 'pb-24 sm:pb-8' : 'pb-8'}`}>
    <header className="sticky top-0 z-30 border-b border-stone-200 bg-[#fffdfa]/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <span className="grid h-10 w-10 place-items-center rounded-lg bg-accent-600 text-white"><UtensilsCrossed aria-hidden="true" className="h-5 w-5" /></span>
        <div className="min-w-0"><h1 className="truncate text-base font-bold text-stone-950">SmartOrder Dining</h1><p className="truncate text-xs text-stone-500">{menu ? `Đang gọi món tại bàn ${menu.table.tableCode}` : 'Menu gọi món tại bàn'}{isSyncing ? ' · Đang đồng bộ' : ''}</p></div>
        <div className="ml-auto flex items-center gap-2">
          <label className="relative"><span className="sr-only">Ngôn ngữ menu</span><Languages aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500" /><select aria-label="Ngôn ngữ menu" value={lang} onChange={(event) => { const next = event.target.value as 'vi' | 'en'; setLang(next); setSelectedCategory('all'); setSearch(''); void loadMenu(next); }} className="h-11 rounded-lg border border-stone-300 bg-white pl-9 pr-7 text-sm font-semibold text-stone-700"><option value="vi">VI</option><option value="en">EN</option></select></label>
          <button onClick={() => setIsCartOpen(true)} aria-label={`Mở giỏ hàng, ${cartCount} món`} className="relative grid h-11 w-11 place-items-center rounded-lg bg-stone-900 text-white transition hover:bg-stone-800"><ShoppingBag aria-hidden="true" className="h-5 w-5" />{cartCount > 0 && <span aria-hidden="true" className="absolute -right-1 -top-1 grid min-h-5 min-w-5 place-items-center rounded-full bg-accent-500 px-1 text-[11px] font-bold text-white">{cartCount}</span>}</button>
        </div>
      </div>
    </header>

    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-7">
      {!menu && <section className="mx-auto mt-8 max-w-lg rounded-xl border border-stone-200 bg-white p-5 sm:p-7"><div className="flex items-start gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-accent-50 text-accent-600"><UtensilsCrossed aria-hidden="true" className="h-5 w-5" /></span><div><h2 className="text-lg font-bold text-stone-950">Mở menu theo bàn</h2><p className="mt-1 text-sm leading-6 text-stone-600">Quét QR đặt trên bàn. Khi thử nghiệm, bạn có thể nhập mã định danh bàn bên dưới.</p></div></div><label htmlFor="table-id" className="mt-5 block text-sm font-semibold text-stone-700">Mã định danh bàn</label><div className="mt-1.5 flex flex-col gap-2 sm:flex-row"><input id="table-id" value={tableId} onChange={(event) => setTableId(event.target.value)} placeholder="Nhập tableId" className={`${controlClass} min-w-0 flex-1`} /><button onClick={() => void loadMenu()} disabled={isLoading || !tableId.trim()} className={primaryButtonClass}>{isLoading && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}{isLoading ? 'Đang tải…' : 'Xem menu'}</button></div></section>}

      <div className="space-y-3">{error && <Feedback tone="danger">{error}</Feedback>}{orderMessage && <Feedback tone="success">{orderMessage}</Feedback>}</div>

      {menu && <>
        <section className="mb-5 mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
          <div><p className="text-sm font-semibold text-stone-950">Bạn cần hỗ trợ tại bàn?</p><p className="text-xs leading-5 text-stone-500">Yêu cầu sẽ được gửi trực tiếp đến màn hình của nhân viên phục vụ.</p></div>
          <button onClick={() => setWaiterConfirmOpen(true)} className={`${secondaryButtonClass} border-amber-300 text-amber-900 hover:bg-amber-50`}><BellRing aria-hidden="true" className="h-4 w-4" />Gọi phục vụ</button>
        </section>

        {paymentSummary && paymentSummary.orders.length > 0 && <section aria-labelledby="session-payment-title" className="mb-6 overflow-hidden rounded-xl border border-stone-200 bg-white">
          <div className="border-b border-stone-200 bg-stone-50 p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-accent-700">Hóa đơn cuối bữa</p><h2 id="session-payment-title" className="mt-1 text-xl font-bold text-stone-950">Thanh toán bàn {paymentSummary.tableCode}</h2><p className="mt-1 text-sm text-stone-600">{paymentSummary.orderCount} lượt gọi món chưa thanh toán · {paymentSummary.itemCount} món</p></div><StatusBadge status={paymentSummary.fullyPaid ? 'Paid' : paymentSummary.canPay ? 'Served' : 'Preparing'} label={paymentSummary.fullyPaid ? 'Đã thanh toán' : paymentSummary.canPay ? 'Sẵn sàng thanh toán' : 'Đang phục vụ'} /></div></div>
          <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.72fr)]">
            <div><h3 className="text-sm font-bold text-stone-950">Tiến độ các lượt gọi món</h3><ul className="mt-3 divide-y divide-stone-200 rounded-lg border border-stone-200">{paymentSummary.orders.map((order) => <li key={order.orderId} className="flex items-center gap-3 px-3 py-3"><div className="min-w-0 flex-1"><p className="font-semibold text-stone-900">Lượt gọi món #{order.orderNumber}</p><p className="truncate text-xs text-stone-500">{order.itemCount} món · {order.orderId}</p></div><StatusBadge status={order.status} /></li>)}</ul></div>
            <div className="rounded-lg border border-stone-200 bg-[#fffdfa] p-4"><h3 className="flex items-center gap-2 font-bold text-stone-950"><CreditCard aria-hidden="true" className="h-4 w-4 text-accent-700" />Tổng thanh toán Session</h3>{paymentSummary.payableOrders.length > 0 ? <><ul className="mt-3 space-y-2 border-b border-stone-200 pb-3 text-sm">{paymentSummary.payableOrders.map((order) => <li key={order.orderId} className="flex justify-between gap-3 text-stone-600"><span>Lượt gọi món #{order.orderNumber}</span><span className="tabular-nums font-medium text-stone-900">{currency.format(order.totalAmount)}</span></li>)}</ul><dl className="mt-3 space-y-2 text-sm"><div className="flex justify-between gap-3 text-stone-600"><dt>Tạm tính</dt><dd className="tabular-nums">{currency.format(paymentSummary.subtotalAmount)}</dd></div><div className="flex justify-between gap-3 text-emerald-700"><dt>Giảm giá</dt><dd className="tabular-nums">-{currency.format(paymentSummary.discountAmount)}</dd></div><div className="flex justify-between gap-3 border-t border-stone-200 pt-3 text-base font-bold text-stone-950"><dt>Tổng thanh toán</dt><dd className="tabular-nums">{currency.format(paymentSummary.payableTotal)}</dd></div></dl><button onClick={() => void startPayment()} disabled={isPaying || !canPay} aria-describedby="payment-eligibility" className={`${primaryButtonClass} mt-4 w-full disabled:cursor-not-allowed disabled:opacity-50`}>{isPaying ? <><LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />Đang chuyển…</> : <><CreditCard aria-hidden="true" className="h-4 w-4" />Thanh toán VNPAY</>}</button><p id="payment-eligibility" role="status" className="mt-2 text-xs leading-5 text-stone-500">{paymentSummary.eligibilityMessage}</p></> : <p role="status" className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm font-medium leading-6 text-emerald-800">{paymentSummary.eligibilityMessage} Bàn vẫn được giữ cho đến khi nhân viên xác nhận dọn bàn.</p>}</div>
          </div>
        </section>}

        {sharedCart?.sessionId && paymentSummary?.orders.some((order) => order.status === 'Paid') && <section aria-labelledby="reviews-title" className="mb-6"><h2 id="reviews-title" className="mb-3 text-lg font-bold text-stone-950">Đánh giá món đã thanh toán</h2><div className="space-y-4">{paymentSummary.orders.filter((order) => order.status === 'Paid').map((order) => <div key={order.orderId}><p className="mb-2 text-sm font-semibold text-stone-600">Lượt gọi món #{order.orderNumber}</p><ReviewFeedback orderId={order.orderId} sessionId={sharedCart.sessionId} /></div>)}</div></section>}

        <section aria-labelledby="menu-title"><div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.15em] text-accent-600">Thực đơn tại bàn</p><h2 id="menu-title" className="mt-1 text-2xl font-bold tracking-tight text-stone-950">Chọn món bạn thích</h2></div><label className="relative block w-full sm:max-w-xs"><span className="sr-only">Tìm món ăn</span><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm trong thực đơn" className={`${controlClass} border-stone-300 pl-10`} /></label></div>
          <div className="scrollbar-subtle -mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-2 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Lọc theo danh mục"><button onClick={() => setSelectedCategory('all')} aria-pressed={selectedCategory === 'all'} className={`min-h-11 shrink-0 rounded-full border px-4 text-sm font-semibold transition ${selectedCategory === 'all' ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-300 bg-white text-stone-700 hover:border-stone-500'}`}>Tất cả</button>{menu.categories.map((category) => <button key={category.id} onClick={() => setSelectedCategory(category.id)} aria-pressed={selectedCategory === category.id} className={`min-h-11 shrink-0 rounded-full border px-4 text-sm font-semibold transition ${selectedCategory === category.id ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-300 bg-white text-stone-700 hover:border-stone-500'}`}>{category.name}</button>)}</div>

          {visibleDishes.length === 0 ? <div className="mt-5"><EmptyState icon={Search} title="Không tìm thấy món phù hợp" description="Thử từ khóa khác hoặc chọn lại danh mục." /></div> : <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{visibleDishes.map((dish) => <article key={dish._id} className="grid min-h-36 grid-cols-[7rem_1fr] overflow-hidden rounded-xl border border-stone-200 bg-white sm:flex sm:h-full sm:flex-col">
            <button onClick={() => openDish(dish)} className="relative block h-full min-h-36 w-full bg-stone-100 text-left transition-colors hover:bg-stone-200 sm:aspect-[16/10] sm:h-auto sm:min-h-0" aria-label={`Xem chi tiết ${dish.name}`}>{dish.imageUrl ? <img src={dish.imageUrl} alt={dish.name} loading="lazy" className="absolute inset-0 m-auto block h-auto w-auto max-h-full max-w-full object-contain" /> : <span className="grid h-full place-items-center text-stone-400"><ImageOff aria-hidden="true" className="h-7 w-7" /></span>}</button>
            <div className="flex min-w-0 flex-1 flex-col p-3.5 sm:p-4"><button onClick={() => openDish(dish)} className="min-w-0 text-left"><h3 className="line-clamp-2 font-bold leading-5 text-stone-950">{dish.name}</h3><p className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500 sm:min-h-10">{dish.description || 'Xem thông tin chi tiết món ăn.'}</p></button><div className="mt-auto flex items-center justify-between gap-3 pt-3"><strong className="whitespace-nowrap text-base font-bold tabular-nums text-accent-700 sm:text-lg">{currency.format(dish.price)}</strong><button onClick={() => openDish(dish)} disabled={isSyncing || !dish.isAvailable} aria-label={`Tùy chọn và thêm ${dish.name} vào giỏ`} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-accent-600 text-white transition hover:bg-accent-500 disabled:opacity-50"><Plus aria-hidden="true" className="h-5 w-5" /></button></div></div>
          </article>)}</div>}
        </section>
      </>}
    </div>

    {menu && cartCount > 0 && <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-white/96 px-4 py-3 backdrop-blur-sm sm:hidden"><button onClick={() => setIsCartOpen(true)} className="flex min-h-12 w-full items-center gap-3 rounded-lg bg-stone-900 px-4 text-white"><span className="grid h-7 min-w-7 place-items-center rounded-full bg-accent-500 px-1 text-xs font-bold">{cartCount}</span><span className="text-sm font-semibold">Xem giỏ hàng</span><span className="tabular-nums ml-auto text-sm font-bold">{currency.format(cartTotal)}</span></button></div>}

    <Modal open={waiterConfirmOpen} onClose={() => !isCallingWaiter && setWaiterConfirmOpen(false)} title="Gọi nhân viên phục vụ?" description={`Yêu cầu sẽ được gửi cho bàn ${menu?.table.tableCode ?? ''}.`} size="sm" footer={<><button type="button" onClick={() => setWaiterConfirmOpen(false)} disabled={isCallingWaiter} className={secondaryButtonClass}>Quay lại</button><button type="button" onClick={callWaiter} disabled={isCallingWaiter} className={`${primaryButtonClass} bg-amber-700 hover:bg-amber-800`}>{isCallingWaiter && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}Xác nhận gọi</button></>}><p className="text-sm leading-6 text-slate-600">Chỉ sử dụng khi bạn cần hỗ trợ gọi món, dụng cụ ăn uống hoặc có vấn đề tại bàn.</p></Modal>

    <Modal open={Boolean(selectedDish)} onClose={closeDish} title={selectedDish?.name ?? 'Chi tiết món'} size="md" footer={<div className="space-y-3"><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium text-stone-600">Giá món</span><strong className="tabular-nums text-lg font-bold text-accent-600">{selectedDish ? currency.format(selectedDish.price) : ''}</strong></div><button onClick={() => { if (selectedDish) addDish(selectedDish, dishNote.trim() || undefined); closeDish(); }} disabled={isSyncing || !selectedDish?.isAvailable} className={`${primaryButtonClass} w-full bg-accent-600 hover:bg-accent-500`}><Plus aria-hidden="true" className="h-4 w-4" />Thêm vào giỏ</button></div>}>
      {selectedDish && <div><div className="relative aspect-[4/3] w-full rounded-lg bg-stone-100">{selectedDish.imageUrl ? <img src={selectedDish.imageUrl} alt={selectedDish.name} className="absolute inset-0 m-auto block h-auto w-auto max-h-full max-w-full object-contain" /> : <span className="grid h-full place-items-center"><ImageOff aria-hidden="true" className="h-8 w-8 text-stone-400" /></span>}</div><p className="mt-4 text-sm leading-6 text-stone-600">{selectedDish.description || 'Món ăn hiện chưa có mô tả chi tiết.'}</p><label htmlFor="dish-note" className="mt-5 flex items-center gap-2 text-sm font-semibold text-stone-800"><StickyNote aria-hidden="true" className="h-4 w-4 text-amber-700" />Bạn có nhắn gì với nhà hàng không?</label><textarea id="dish-note" rows={3} maxLength={250} value={dishNote} onChange={(event) => setDishNote(event.target.value)} aria-describedby="dish-note-help dish-note-count" placeholder="Ví dụ: Ít cay, không hành, cho thêm nước chấm" className={`${controlClass} mt-2 resize-y`} /><div className="mt-1.5 flex items-start justify-between gap-3 text-xs leading-5 text-stone-500"><p id="dish-note-help">Không bắt buộc. Ghi chú này chỉ áp dụng cho món đang chọn.</p><span id="dish-note-count" className="shrink-0 tabular-nums">{dishNote.length}/250</span></div></div>}
    </Modal>

    {isCartOpen && <div className="fixed inset-0 z-50 bg-slate-950/55" onMouseDown={(event) => event.target === event.currentTarget && setIsCartOpen(false)}><aside ref={cartDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="cart-title" className="safe-bottom ml-auto flex h-full w-full max-w-md flex-col bg-white shadow-2xl"><div className="flex items-center justify-between border-b border-stone-200 px-5 py-4"><div><h2 id="cart-title" className="text-lg font-bold text-stone-950">Giỏ hàng tại bàn</h2><p className="text-xs text-stone-500">{isSyncing ? 'Đang đồng bộ với mọi người tại bàn…' : `${cartCount} món đã chọn`}</p></div><button onClick={() => setIsCartOpen(false)} className="grid h-11 w-11 place-items-center rounded-lg border border-stone-200 text-stone-600" aria-label="Đóng giỏ hàng"><X aria-hidden="true" className="h-5 w-5" /></button></div>
      <div className="scrollbar-subtle flex-1 overflow-y-auto px-5 py-4">{cart.length === 0 ? <EmptyState icon={ShoppingBag} title="Giỏ hàng đang trống" description="Chọn món trong thực đơn để bắt đầu gọi món." /> : <ul className="divide-y divide-stone-200">{cart.map((item) => <li key={item.cartItemId} className="flex items-center gap-3 py-4"><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-stone-950">{item.dishName}</p>{item.note && <p className="overflow-wrap-anywhere mt-1.5 flex items-start gap-1.5 whitespace-pre-wrap text-xs leading-5 text-amber-800"><StickyNote aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{item.note}</span></p>}<p className="tabular-nums mt-1 text-sm font-medium text-accent-600">{currency.format(item.unitPrice)}</p></div><div className="flex items-center gap-2" aria-label={`Số lượng ${item.dishName}`}><button onClick={() => changeQuantity(item.cartItemId, item.dishId, item.quantity - 1)} disabled={isSyncing} aria-label={`Giảm ${item.dishName}`} className="grid h-11 w-11 place-items-center rounded-lg border border-stone-300 text-stone-700 hover:bg-stone-50 disabled:opacity-50"><Minus aria-hidden="true" className="h-4 w-4" /></button><span className="tabular-nums w-6 text-center text-sm font-bold">{item.quantity}</span><button onClick={() => changeQuantity(item.cartItemId, item.dishId, item.quantity + 1)} disabled={isSyncing} aria-label={`Tăng ${item.dishName}`} className="grid h-11 w-11 place-items-center rounded-lg border border-stone-300 text-stone-700 hover:bg-stone-50 disabled:opacity-50"><Plus aria-hidden="true" className="h-4 w-4" /></button></div></li>)}</ul>}
        {cart.length > 0 && <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4"><label htmlFor="promotion" className="flex items-center gap-2 text-sm font-semibold text-stone-700"><Tag aria-hidden="true" className="h-4 w-4" />Mã giảm giá</label><div className="mt-2 flex gap-2"><input id="promotion" value={promotionCode} onChange={(event) => { setPromotionCode(event.target.value.toUpperCase()); setPromotionPreview(null); setPromotionError(''); }} aria-describedby={promotionError ? 'promotion-error' : undefined} aria-invalid={Boolean(promotionError)} placeholder="Nhập mã" className={`${controlClass} min-w-0 flex-1 uppercase`} /><button onClick={() => void applyPromotion()} disabled={!promotionCode.trim() || isApplyingPromotion} className={secondaryButtonClass}>{isApplyingPromotion ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : 'Áp dụng'}</button></div>{promotionError && <p id="promotion-error" role="alert" className="mt-2 text-sm font-medium text-red-700">{promotionError}</p>}{promotionPreview && <div role="status" className="mt-3 space-y-2 border-t border-stone-200 pt-3 text-sm"><div className="flex justify-between gap-3 text-stone-600"><span>Mã đã áp dụng</span><strong className="text-stone-900">{promotionPreview.code}</strong></div><div className="flex justify-between gap-3 text-stone-600"><span>Tạm tính</span><span className="tabular-nums">{currency.format(promotionPreview.subtotalAmount)}</span></div><div className="flex justify-between gap-3 text-emerald-700"><span>Giảm giá</span><span className="tabular-nums">-{currency.format(promotionPreview.discountAmount)}</span></div><div className="flex justify-between gap-3 border-t border-stone-200 pt-2 font-bold text-stone-950"><span>Tổng thanh toán</span><span className="tabular-nums">{currency.format(promotionPreview.totalAmount)}</span></div></div>}</div>}
      </div>
      <div className="border-t border-stone-200 bg-white px-5 py-4"><div className="mb-4 flex items-end justify-between"><span className="text-sm text-stone-600">Tổng thanh toán</span><strong className="tabular-nums text-xl text-stone-950">{currency.format(promotionPreview?.totalAmount ?? cartTotal)}</strong></div><button onClick={() => void submitOrder()} disabled={cart.length === 0 || isOrdering || isSyncing} className={`${primaryButtonClass} w-full bg-accent-600 hover:bg-accent-500`}>{isOrdering ? <><LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />Đang gửi đơn…</> : <><ChefHat aria-hidden="true" className="h-4 w-4" />Gửi đơn đến bếp</>}</button><p className="mt-2 text-center text-xs text-stone-500">Giỏ hàng được chia sẻ với mọi người tại cùng bàn.</p></div>
    </aside></div>}
  </main>;
}
