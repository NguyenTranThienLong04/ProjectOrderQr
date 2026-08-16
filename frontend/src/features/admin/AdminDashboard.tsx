import { useCallback, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { BarChart3, CalendarRange, ClipboardList, Grid2X2, RefreshCw, Star, TrendingUp, WalletCards } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { adminApi, type AnalyticsOverview, type RevenuePoint, type TopDishPoint, type TopRatedDishPoint } from '../../services/api/admin';
import { EmptyState, Feedback, LoadingState, PageHeader, controlClass, labelClass, primaryButtonClass } from '../../components/ui';

const socketUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const number = new Intl.NumberFormat('vi-VN');
const money = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 });

export default function AdminDashboard() {
  const [revenue, setRevenue] = useState<RevenuePoint[]>([]);
  const [topDishes, setTopDishes] = useState<TopDishPoint[]>([]);
  const [topRatedDishes, setTopRatedDishes] = useState<TopRatedDishPoint[]>([]);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [groupBy, setGroupBy] = useState<'day' | 'month' | 'year'>('day');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadAnalytics = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [revenueData, topData, overviewData, ratedData] = await Promise.all([
        adminApi.getRevenue({ from: fromDate || undefined, to: toDate || undefined, groupBy }),
        adminApi.getTopDishes({ from: fromDate || undefined, to: toDate || undefined, limit: 10 }),
        adminApi.getOverview(), adminApi.getTopRatedDishes(),
      ]);
      setRevenue(revenueData); setTopDishes(topData); setOverview(overviewData); setTopRatedDishes(ratedData);
    } catch { setError('Không thể tải số liệu phân tích. Kiểm tra kết nối rồi thử lại.'); }
    finally { setLoading(false); }
  }, [fromDate, toDate, groupBy]);

  // Filters are applied explicitly by submit; loading on every date keystroke is intentionally avoided.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadAnalytics(); }, []);
  useEffect(() => {
    const socket = io(socketUrl);
    socket.on('connect', () => { socket.emit('join', { room: 'admin' }); socket.emit('join', { room: 'waiter' }); });
    socket.on('tables:updated', () => void loadAnalytics());
    socket.on('table:grouped', () => void loadAnalytics());
    return () => { socket.disconnect(); };
  }, [loadAnalytics]);

  const cards = [
    { label: 'Tổng đơn hàng', value: overview ? number.format(overview.totalOrders) : '—', icon: ClipboardList, tone: 'bg-blue-50 text-blue-700' },
    { label: 'Đơn hôm nay', value: overview ? number.format(overview.ordersToday) : '—', icon: TrendingUp, tone: 'bg-emerald-50 text-emerald-700' },
    { label: 'Bàn đang dùng', value: overview ? number.format(overview.occupiedTables) : '—', icon: Grid2X2, tone: 'bg-amber-50 text-amber-700' },
    { label: 'Giá trị đơn TB', value: overview ? money.format(Math.round(overview.avgOrderValue)) : '—', icon: WalletCards, tone: 'bg-violet-50 text-violet-700' },
  ];

  return <div className="space-y-6">
    <PageHeader eyebrow="Analytics" title="Tổng quan vận hành" description="Theo dõi doanh thu, đơn hàng và hiệu suất món ăn từ dữ liệu tổng hợp thực tế." />
    <section aria-label="Bộ lọc báo cáo" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"><form onSubmit={(event) => { event.preventDefault(); void loadAnalytics(); }} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end"><label className={labelClass}>Từ ngày<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className={`${controlClass} mt-1.5`} /></label><label className={labelClass}>Đến ngày<input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} className={`${controlClass} mt-1.5`} /></label><label className={labelClass}>Nhóm dữ liệu<select value={groupBy} onChange={(event) => setGroupBy(event.target.value as 'day' | 'month' | 'year')} className={`${controlClass} mt-1.5`}><option value="day">Theo ngày</option><option value="month">Theo tháng</option><option value="year">Theo năm</option></select></label><button type="submit" disabled={loading} className={primaryButtonClass}>{loading ? <RefreshCw aria-hidden="true" className="h-4 w-4 animate-spin" /> : <CalendarRange aria-hidden="true" className="h-4 w-4" />}Áp dụng</button></form></section>
    {error && <Feedback tone="danger">{error}</Feedback>}
    {loading && !overview ? <LoadingState label="Đang tổng hợp số liệu…" /> : <>
      <section aria-label="Chỉ số chính" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(({ label, value, icon: Icon, tone }) => <article key={label} className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-slate-600">{label}</p><p className="tabular-nums mt-2 text-2xl font-black tracking-tight text-slate-950">{value}</p></div><span className={`grid h-10 w-10 place-items-center rounded-lg ${tone}`}><Icon aria-hidden="true" className="h-5 w-5" /></span></div></article>)}</section>

      <section aria-labelledby="revenue-title" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="revenue-title" className="text-lg font-bold text-slate-950">Xu hướng doanh thu</h2><p className="mt-1 text-sm text-slate-600">Biến động theo khoảng thời gian đã chọn, đơn vị VND.</p></div><BarChart3 aria-hidden="true" className="h-5 w-5 text-brand-700" /></div>{revenue.length === 0 ? <div className="mt-4"><EmptyState icon={TrendingUp} title="Chưa có dữ liệu doanh thu" description="Chọn khoảng thời gian khác hoặc chờ các đơn đã thanh toán." /></div> : <><p className="sr-only">Biểu đồ đường doanh thu gồm {revenue.length} mốc, tổng {money.format(revenue.reduce((sum, item) => sum + item.revenue, 0))}.</p><div className="mt-4 h-72 w-full sm:h-80"><ResponsiveContainer width="100%" height="100%"><LineChart data={revenue} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} /><XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 12 }} tickLine={false} axisLine={false} minTickGap={24} /><YAxis tick={{ fill: '#64748b', fontSize: 12 }} tickLine={false} axisLine={false} width={72} tickFormatter={(value: number) => `${number.format(value / 1000000)}tr`} /><Tooltip formatter={(value: number) => money.format(value)} contentStyle={{ border: '1px solid #e2e8f0', borderRadius: 8 }} /><Line type="monotone" dataKey="revenue" name="Doanh thu" stroke="#2f684f" strokeWidth={3} dot={{ r: 3, fill: '#2f684f' }} activeDot={{ r: 5 }} /></LineChart></ResponsiveContainer></div></>}</section>

      <div className="grid gap-5 xl:grid-cols-2">
        <section aria-labelledby="top-dishes-title" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"><h2 id="top-dishes-title" className="text-lg font-bold text-slate-950">Món bán chạy</h2><p className="mt-1 text-sm text-slate-600">So sánh số lượng bán trong kỳ.</p>{topDishes.length === 0 ? <div className="mt-4"><EmptyState title="Chưa có dữ liệu món bán" /></div> : <><p className="sr-only">Món bán nhiều nhất là {topDishes[0]?.dishName}.</p><div className="mt-4 h-80"><ResponsiveContainer width="100%" height="100%"><BarChart data={topDishes.slice(0, 7)} layout="vertical" margin={{ left: 12, right: 16 }}><CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" horizontal={false} /><XAxis type="number" tick={{ fill: '#64748b', fontSize: 12 }} axisLine={false} tickLine={false} /><YAxis dataKey="dishName" type="category" tick={{ fill: '#334155', fontSize: 12 }} width={120} axisLine={false} tickLine={false} /><Tooltip formatter={(value: number) => number.format(value)} contentStyle={{ borderRadius: 8 }} /><Bar dataKey="totalQuantity" fill="#3f7d61" name="Số lượng" radius={[0, 4, 4, 0]} /></BarChart></ResponsiveContainer></div></>}</section>
        <section aria-labelledby="rating-title" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5"><h2 id="rating-title" className="flex items-center gap-2 text-lg font-bold text-slate-950"><Star aria-hidden="true" className="h-5 w-5 text-amber-600" />Món được đánh giá cao</h2><p className="mt-1 text-sm text-slate-600">Điểm trung bình trên thang 5.</p>{topRatedDishes.length === 0 ? <div className="mt-4"><EmptyState icon={Star} title="Chưa có đánh giá" /></div> : <><p className="sr-only">Món được đánh giá cao nhất là {topRatedDishes[0]?.dishName}, {topRatedDishes[0]?.averageRating} trên 5 điểm.</p><div className="mt-4 h-80"><ResponsiveContainer width="100%" height="100%"><BarChart data={topRatedDishes.slice(0, 7)} layout="vertical" margin={{ left: 12, right: 16 }}><CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" horizontal={false} /><XAxis type="number" domain={[0, 5]} tick={{ fill: '#64748b', fontSize: 12 }} axisLine={false} tickLine={false} /><YAxis dataKey="dishName" type="category" tick={{ fill: '#334155', fontSize: 12 }} width={120} axisLine={false} tickLine={false} /><Tooltip formatter={(value: number) => `${Number(value).toFixed(1)} / 5`} contentStyle={{ borderRadius: 8 }} /><Legend /><Bar dataKey="averageRating" fill="#d97706" name="Điểm trung bình" radius={[0, 4, 4, 0]} /></BarChart></ResponsiveContainer></div></>}</section>
      </div>
    </>}
  </div>;
}
