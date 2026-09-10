import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { io } from 'socket.io-client';
import {
  ArrowRightLeft,
  BellRing,
  CheckCircle2,
  CircleDollarSign,
  Combine,
  LoaderCircle,
  RefreshCw,
  Split,
  Sparkles,
  Utensils,
} from 'lucide-react';
import { orderApi, type KitchenOrder, type TablePaymentSummary } from '../../services/api/order';
import { sessionApi, type TableOperationOptions } from '../../services/api/session';
import { tableApi, type Table } from '../../services/api/table';
import { EmptyState, Feedback, PageHeader, StatusBadge, controlClass, labelClass, primaryButtonClass, secondaryButtonClass } from '../../components/ui';

import { API_URL as socketUrl } from '../../config/api-url';
interface WaiterCall { tableId: string; timestamp: string; }
const getErrorMessage = (error: unknown) => (error as { response?: { data?: { message?: string } } }).response?.data?.message ?? (error instanceof Error ? error.message : 'Vui lòng thử lại.');

export default function WaiterDashboard() {
  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [tableOperations, setTableOperations] = useState<TableOperationOptions>({ moveSources: [], moveDestinations: [], mergeCandidates: [], unmergeGroups: [] });
  const [updatingItemId, setUpdatingItemId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [moveSessionId, setMoveSessionId] = useState('');
  const [newTableId, setNewTableId] = useState('');
  const [mergeSourceId, setMergeSourceId] = useState('');
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [unmergeChildSessionId, setUnmergeChildSessionId] = useState('');
  const [operation, setOperation] = useState<'move' | 'merge' | 'unmerge'>('move');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState('');
  const [paymentSummaries, setPaymentSummaries] = useState<TablePaymentSummary[]>([]);
  const [clearingTableId, setClearingTableId] = useState<string | null>(null);
  const [waiterCalls, setWaiterCalls] = useState<WaiterCall[]>([]);
  const [loading, setLoading] = useState(true);
  const loadPromiseRef = useRef<Promise<void> | null>(null);

  const load = useCallback(() => {
    if (loadPromiseRef.current) return loadPromiseRef.current;
    const request = Promise.all([orderApi.listForWaiter(), tableApi.findAll(), orderApi.listPaymentSummariesForWaiter(), sessionApi.getTableOperationOptions()])
      .then(([readyOrders, allTables, summaries, operationOptions]) => {
        setOrders(readyOrders); setTables(allTables); setPaymentSummaries(summaries); setTableOperations(operationOptions); setError(null);
      })
      .catch((loadError: unknown) => { setError(`Không thể tải dữ liệu phục vụ: ${getErrorMessage(loadError)}`); })
      .finally(() => {
        setLoading(false);
        if (loadPromiseRef.current === request) loadPromiseRef.current = null;
      });
    loadPromiseRef.current = request;
    return request;
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const socket = io(socketUrl);
    socket.on('connect', () => socket.emit('join', { room: 'waiter' }));
    socket.on('order:updated', () => void load());
    socket.on('order:paid', () => void load());
    socket.on('tables:updated', () => void load());
    socket.on('table:grouped', () => void load());
    socket.on('waiter:called', (call: WaiterCall) => { if (call?.tableId && call.timestamp) setWaiterCalls((calls) => calls.some((item) => item.tableId === call.tableId) ? calls : [call, ...calls]); });
    return () => { socket.removeAllListeners(); socket.disconnect(); };
  }, [load]);

  const activeTables = useMemo(() => tables.filter((table) => table.currentSessionId), [tables]);
  const waitingTables = useMemo(() => tables.filter((table) => table.status === 'waiting_payment'), [tables]);
  const readyItems = orders.reduce((sum, order) => sum + order.items.length, 0);
  const resolveTableLabel = (tableId: string) => tables.find((table) => table._id === tableId)?.tableCode ?? tableId;

  const serve = async (orderId: string, itemId: string) => {
    if (updatingItemId) return;
    setUpdatingItemId(itemId); setSuccess('');
    try { await orderApi.transitionItem(orderId, itemId, 'Served'); setSuccess('Đã xác nhận món được phục vụ.'); await load(); }
    catch (transitionError) { setError(`Không thể xác nhận phục vụ: ${getErrorMessage(transitionError)}`); }
    finally { setUpdatingItemId(null); }
  };
  const clearTable = async (tableId: string) => {
    setClearingTableId(tableId); setSuccess('');
    try { await tableApi.clear(tableId); setSuccess(`Đã dọn bàn ${resolveTableLabel(tableId)} và chuyển về trạng thái trống.`); await load(); }
    catch (clearError) { setError(`Không thể dọn bàn: ${getErrorMessage(clearError)}`); }
    finally { setClearingTableId(null); }
  };
  const moveTable = async (event: FormEvent) => {
    event.preventDefault(); if (!moveSessionId || !newTableId) return;
    setActionLoading(true); setSuccess('');
    try { await sessionApi.moveTable(moveSessionId, newTableId); setMoveSessionId(''); setNewTableId(''); setSuccess('Chuyển bàn thành công. Đơn và giỏ hàng đã đi theo bàn mới.'); await load(); }
    catch (moveError) { setError(`Không thể chuyển bàn: ${getErrorMessage(moveError)}`); }
    finally { setActionLoading(false); }
  };
  const mergeSessions = async (event: FormEvent) => {
    event.preventDefault(); if (!mergeSourceId || !mergeTargetId || mergeSourceId === mergeTargetId) return;
    setActionLoading(true); setSuccess('');
    try { await sessionApi.mergeTables(mergeSourceId, mergeTargetId); setMergeSourceId(''); setMergeTargetId(''); setSuccess('Ghép bàn thành công. Dữ liệu phiên đã được đồng bộ.'); await load(); }
    catch (mergeError) { setError(`Không thể ghép bàn: ${getErrorMessage(mergeError)}`); }
    finally { setActionLoading(false); }
  };
  const unmerge = async (event: FormEvent) => {
    event.preventDefault(); if (!unmergeChildSessionId) return;
    setActionLoading(true); setSuccess('');
    const [kind, id] = unmergeChildSessionId.split(':');
    try { await sessionApi.unmerge(kind === 'session' ? id : undefined, kind === 'table_group' ? id : undefined); setUnmergeChildSessionId(''); setSuccess('Đã tách nhóm bàn về đúng ownership trước khi ghép.'); await load(); }
    catch (unmergeError) { setError(`Không thể tách bàn: ${getErrorMessage(unmergeError)}`); }
    finally { setActionLoading(false); }
  };

  return <main id="main-content" tabIndex={-1} className="min-h-[calc(100dvh-4rem)] bg-slate-100 px-4 py-5 text-slate-900 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-[100rem] space-y-5">
      <PageHeader eyebrow="Service floor" title="Điều phối phục vụ" description="Xử lý theo thứ tự ưu tiên: khách gọi, món sẵn sàng, bàn đã thanh toán." actions={<button onClick={() => void load()} className={secondaryButtonClass}><RefreshCw aria-hidden="true" className="h-4 w-4" />Tải lại</button>} />
      {error && <Feedback tone="danger">{error}</Feedback>}{success && <Feedback tone="success">{success}</Feedback>}
      <section aria-label="Tổng quan công việc" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className={`rounded-xl border p-4 ${waiterCalls.length ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}><p className="flex items-center gap-2 text-sm font-semibold text-slate-600"><BellRing aria-hidden="true" className="h-4 w-4 text-amber-700" />Khách gọi</p><p className="tabular-nums mt-1 text-3xl font-black text-slate-950">{waiterCalls.length}</p></div>
        <div className={`rounded-xl border p-4 ${readyItems ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'}`}><p className="flex items-center gap-2 text-sm font-semibold text-slate-600"><Utensils aria-hidden="true" className="h-4 w-4 text-emerald-700" />Món Ready</p><p className="tabular-nums mt-1 text-3xl font-black text-slate-950">{readyItems}</p></div>
        <div className={`rounded-xl border p-4 ${waitingTables.length ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white'}`}><p className="flex items-center gap-2 text-sm font-semibold text-slate-600"><CircleDollarSign aria-hidden="true" className="h-4 w-4 text-blue-700" />Chờ thanh toán</p><p className="tabular-nums mt-1 text-3xl font-black text-slate-950">{waitingTables.length}</p></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="flex items-center gap-2 text-sm font-semibold text-slate-600"><Sparkles aria-hidden="true" className="h-4 w-4 text-brand-700" />Bàn đang phục vụ</p><p className="tabular-nums mt-1 text-3xl font-black text-slate-950">{activeTables.length}</p></div>
      </section>

      {loading ? <div className="rounded-xl border border-slate-200 bg-white p-10 text-center"><LoaderCircle aria-hidden="true" className="mx-auto h-6 w-6 animate-spin text-brand-600" /><p className="mt-2 text-sm text-slate-600">Đang tải sàn phục vụ…</p></div> : <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
        <div className="space-y-5">
          <section aria-labelledby="calls-title" className={`rounded-xl border ${waiterCalls.length ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'} p-4 sm:p-5`}><div className="flex items-center justify-between"><h2 id="calls-title" className="flex items-center gap-2 text-lg font-bold text-slate-950"><BellRing aria-hidden="true" className="h-5 w-5 text-amber-700" />Yêu cầu hỗ trợ</h2><span className="text-xs font-semibold text-slate-500">Ưu tiên cao nhất</span></div>{waiterCalls.length === 0 ? <p className="mt-4 text-sm text-slate-600">Không có bàn đang gọi phục vụ.</p> : <ul className="mt-4 grid gap-3 sm:grid-cols-2">{waiterCalls.map((call) => <li key={`${call.tableId}-${call.timestamp}`} className="rounded-lg border border-amber-200 bg-white p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-amber-700">Cần hỗ trợ</p><p className="mt-1 text-2xl font-black text-slate-950">Bàn {resolveTableLabel(call.tableId)}</p><p className="mt-1 text-xs text-slate-500">Gọi lúc {new Date(call.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</p></div><StatusBadge status="waiter_call" label="Mới" /></div><button onClick={() => setWaiterCalls((calls) => calls.filter((item) => item.tableId !== call.tableId || item.timestamp !== call.timestamp))} className={`${primaryButtonClass} mt-4 w-full bg-amber-700 hover:bg-amber-800`}><CheckCircle2 aria-hidden="true" className="h-4 w-4" />Đã hỗ trợ bàn</button></li>)}</ul>}</section>

          <section aria-labelledby="ready-title"><div className="mb-3 flex items-center justify-between"><h2 id="ready-title" className="text-lg font-bold text-slate-950">Món sẵn sàng mang ra</h2><StatusBadge status="Ready" label={`${readyItems} món`} /></div>{orders.length === 0 ? <EmptyState icon={Utensils} title="Không có món chờ phục vụ" description="Món hoàn tất từ bếp sẽ xuất hiện tự động tại đây." /> : <div className="grid gap-3 lg:grid-cols-2">{orders.map((order) => <article key={order.orderId} className="rounded-xl border border-emerald-200 bg-white"><div className="flex items-center justify-between border-b border-emerald-100 bg-emerald-50 px-4 py-3"><div><span className="text-xs font-bold uppercase tracking-[0.14em] text-emerald-800">Mang đến</span><h3 className="text-2xl font-black text-slate-950">Bàn {order.tableDisplayName}</h3></div><StatusBadge status="Ready" /></div><ul className="divide-y divide-slate-200">{order.items.map((item) => <li key={item.itemId} className="p-4"><div className="flex items-start gap-3"><span className="tabular-nums grid h-10 min-w-10 place-items-center rounded-lg bg-slate-950 px-2 font-black text-white">{item.quantity}×</span><div className="min-w-0 flex-1"><p className="font-bold leading-6 text-slate-950">{item.dishName}</p>{item.note && <p className="overflow-wrap-anywhere mt-1 whitespace-pre-wrap text-sm font-semibold leading-5 text-amber-800">Lưu ý: {item.note}</p>}</div></div><button disabled={updatingItemId === item.itemId} onClick={() => void serve(order.orderId, item.itemId)} className={`${primaryButtonClass} mt-3 w-full`}>{updatingItemId === item.itemId ? <><LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />Đang xác nhận…</> : <><CheckCircle2 aria-hidden="true" className="h-4 w-4" />Đã phục vụ món</>}</button></li>)}</ul></article>)}</div>}</section>
        </div>

        <div className="space-y-5">
          <section aria-labelledby="payment-title" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"><h2 id="payment-title" className="text-lg font-bold text-slate-950">Thanh toán & dọn bàn</h2><p className="mt-1 text-sm text-slate-600">Chỉ dọn bàn khi hệ thống đã xác nhận toàn bộ Session không còn đơn chưa thanh toán.</p>{waitingTables.length === 0 ? <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Không có bàn chờ thanh toán.</p> : <ul className="mt-4 space-y-3">{waitingTables.map((table) => { const payment = paymentSummaries.find((summary) => summary.tableId === table._id); const canClear = Boolean(payment?.isPaid); return <li key={table._id} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3"><div className="min-w-0 flex-1"><p className="font-bold text-slate-950">Bàn {table.tableCode}</p><StatusBadge status={canClear ? 'Paid' : 'waiting_payment'} label={canClear ? 'Đã trả · chờ dọn' : 'Còn số dư Session'} /></div><button onClick={() => void clearTable(table._id)} disabled={!canClear || clearingTableId === table._id} className={`${primaryButtonClass} shrink-0 px-3`}>{clearingTableId === table._id ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Sparkles aria-hidden="true" className="h-4 w-4" />}<span className="hidden sm:inline">Dọn bàn</span></button></li>; })}</ul>}</section>

          <section aria-labelledby="table-status-title" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"><div className="flex items-center justify-between"><h2 id="table-status-title" className="text-lg font-bold text-slate-950">Sơ đồ trạng thái bàn</h2><span className="text-xs font-medium text-slate-500">{tables.length} bàn</span></div><div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">{tables.map((table) => <div key={table._id} className="rounded-lg border border-slate-200 p-3"><p className="mb-2 text-lg font-black text-slate-950">{table.tableCode}</p><StatusBadge status={table.status} />{table.groupedWithTableIds && table.groupedWithTableIds.length > 0 && <div className="mt-2"><StatusBadge status="merged" /></div>}</div>)}</div></section>
        </div>
      </div>}

      <section aria-labelledby="table-operations-title" className="rounded-xl border border-slate-200 bg-white"><div className="border-b border-slate-200 p-4 sm:p-5"><h2 id="table-operations-title" className="text-lg font-bold text-slate-950">Nghiệp vụ bàn</h2><p className="mt-1 text-sm text-slate-600">Dữ liệu order, cart và session vẫn được giữ theo nghiệp vụ hiện tại.</p><div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Chọn nghiệp vụ bàn">{([{ key: 'move', label: 'Chuyển bàn', icon: ArrowRightLeft }, { key: 'merge', label: 'Ghép bàn', icon: Combine }, { key: 'unmerge', label: 'Tách bàn', icon: Split }] as const).map((item) => { const Icon = item.icon; return <button key={item.key} role="tab" aria-selected={operation === item.key} onClick={() => setOperation(item.key)} className={`min-h-11 rounded-lg border px-4 text-sm font-semibold transition ${operation === item.key ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}><span className="flex items-center gap-2"><Icon aria-hidden="true" className="h-4 w-4" />{item.label}</span></button>; })}</div></div>
        <div className="p-4 sm:p-5">
          {operation === 'move' && <form onSubmit={moveTable} className="grid gap-4 lg:grid-cols-[1fr_auto_1fr_auto] lg:items-end"><label className={labelClass}>Bàn hiện tại<select required value={moveSessionId} onChange={(event) => setMoveSessionId(event.target.value)} className={`${controlClass} mt-1.5`}><option value="">Chọn bàn cần chuyển</option>{tableOperations.moveSources.map((candidate) => <option key={candidate.groupKey} value={candidate.sessionId}>{`Bàn ${candidate.displayName} · đang phục vụ`}</option>)}</select></label><ArrowRightLeft aria-hidden="true" className="mx-auto mb-3 hidden h-5 w-5 text-slate-400 lg:block" /><label className={labelClass}>Bàn đích trống<select required value={newTableId} onChange={(event) => setNewTableId(event.target.value)} className={`${controlClass} mt-1.5`}><option value="">Chọn bàn đích</option>{tableOperations.moveDestinations.map((candidate) => <option key={candidate.groupKey} value={candidate.tableId}>{`Bàn ${candidate.displayName} · trống`}</option>)}</select></label><button disabled={actionLoading || !moveSessionId || !newTableId} className={primaryButtonClass}>{actionLoading && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}Xác nhận chuyển</button><p className="text-sm leading-6 text-slate-600 lg:col-span-4">Toàn bộ order và giỏ hàng của phiên hiện tại sẽ theo sang bàn đích.</p></form>}
          {operation === 'merge' && <form onSubmit={mergeSessions} className="grid gap-4 lg:grid-cols-[1fr_auto_1fr_auto] lg:items-end"><label className={labelClass}>Bàn/nhóm giữ làm chính<select required value={mergeTargetId} onChange={(event) => { setMergeTargetId(event.target.value); setMergeSourceId(''); }} className={`${controlClass} mt-1.5`}><option value="">Chọn bàn hoặc nhóm chính</option>{tableOperations.mergeCandidates.map((candidate) => <option key={candidate.groupKey} value={candidate.tableId}>{candidate.tableIds.length > 1 ? `Nhóm ${candidate.displayName}` : `Bàn ${candidate.displayName}`}</option>)}</select></label><Combine aria-hidden="true" className="mx-auto mb-3 hidden h-5 w-5 text-slate-400 lg:block" /><label className={labelClass}>Bàn/nhóm nhập vào<select required value={mergeSourceId} onChange={(event) => setMergeSourceId(event.target.value)} className={`${controlClass} mt-1.5`}><option value="">Chọn bàn hoặc nhóm cần nhập</option>{tableOperations.mergeCandidates.filter((candidate) => candidate.tableId !== mergeTargetId).map((candidate) => <option key={candidate.groupKey} value={candidate.tableId}>{candidate.tableIds.length > 1 ? `Nhóm ${candidate.displayName}` : `Bàn ${candidate.displayName}`}</option>)}</select></label><button disabled={actionLoading || !mergeSourceId || !mergeTargetId} className={primaryButtonClass}>{actionLoading && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}Xác nhận ghép</button><p className="text-sm leading-6 text-slate-600 lg:col-span-4">Mỗi nhóm chỉ xuất hiện một lần; member đã ghép không được chọn như bàn độc lập. Giỏ hàng và lịch sử order vẫn được giữ để đối soát.</p></form>}
          {operation === 'unmerge' && <form onSubmit={unmerge} className="grid max-w-3xl gap-4 sm:grid-cols-[1fr_auto] sm:items-end"><label className={labelClass}>Nhóm cần tách<select required value={unmergeChildSessionId} onChange={(event) => setUnmergeChildSessionId(event.target.value)} className={`${controlClass} mt-1.5`}><option value="">Chọn nhóm đã ghép</option>{tableOperations.unmergeGroups.map((group) => { const id = group.kind === 'session' ? group.childSessionId : group.tableId; return <option key={`${group.kind}:${id}`} value={`${group.kind}:${id}`}>{group.displayName}</option>; })}</select></label><button disabled={actionLoading || !unmergeChildSessionId} className={primaryButtonClass}>{actionLoading && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}Xác nhận tách</button><p className="text-sm leading-6 text-slate-600 sm:col-span-2">Chỉ tách tự động khi chưa có order chung sau thời điểm ghép. Nếu Order hoặc Shared Cart làm ownership không còn an toàn, backend sẽ từ chối và hiển thị đúng lý do.</p></form>}
        </div>
      </section>
    </div>
  </main>;
}
