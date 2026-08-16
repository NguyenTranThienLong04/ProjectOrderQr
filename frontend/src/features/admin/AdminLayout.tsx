import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import {
  ChartNoAxesCombined,
  ChevronRight,
  Grid2X2,
  LogOut,
  Menu,
  Percent,
  Soup,
  Tags,
  Users,
  X,
} from 'lucide-react';
import { handleLogout } from '../../services/api/axios-client';
import { LoadingState } from '../../components/ui';

interface User {
  id: string;
  email: string;
  role: 'admin' | 'kitchen' | 'waiter';
  fullName: string;
}

const menuItems = [
  { name: 'Tổng quan', path: '/admin/analytics', icon: ChartNoAxesCombined },
  { name: 'Bàn & QR', path: '/admin/tables', icon: Grid2X2 },
  { name: 'Danh mục', path: '/admin/categories', icon: Tags },
  { name: 'Món ăn', path: '/admin/dishes', icon: Soup },
  { name: 'Khuyến mãi', path: '/admin/promotions', icon: Percent },
  { name: 'Người dùng', path: '/admin/users', icon: Users },
];

export function AdminLayout() {
  const location = useLocation();
  const [user, setUser] = useState<User | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    const userData = localStorage.getItem('user');
    if (!token || !userData) return handleLogout();
    try { setUser(JSON.parse(userData)); } catch { handleLogout(); }
  }, []);

  useEffect(() => setNavOpen(false), [location.pathname]);

  if (!user) return <div className="grid min-h-dvh place-items-center bg-ink-950"><LoadingState label="Đang mở không gian quản trị…" dark /></div>;

  const activeItem = menuItems.find((item) => location.pathname.startsWith(item.path));
  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-20 items-center justify-between border-b border-white/10 px-5">
        <Link to="/admin/analytics" className="flex items-center gap-3" aria-label="SmartOrder — trang tổng quan">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-brand-500 text-lg font-black text-white">S</span>
          <span><span className="block font-bold tracking-tight text-white">SmartOrder</span><span className="block text-[11px] font-medium uppercase tracking-[0.16em] text-slate-400">Restaurant OS</span></span>
        </Link>
        <button onClick={() => setNavOpen(false)} aria-label="Đóng điều hướng" className="grid h-11 w-11 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white lg:hidden"><X aria-hidden="true" className="h-5 w-5" /></button>
      </div>

      <nav aria-label="Điều hướng quản trị" className="flex-1 overflow-y-auto px-3 py-5">
        <p className="px-3 pb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Quản lý nhà hàng</p>
        <div className="space-y-1">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const active = location.pathname.startsWith(item.path);
            return <Link key={item.path} to={item.path} aria-current={active ? 'page' : undefined} className={`group flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition ${active ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-300 hover:bg-white/8 hover:text-white'}`}>
              <Icon aria-hidden="true" className={`h-[18px] w-[18px] ${active ? 'text-brand-700' : 'text-slate-400 group-hover:text-white'}`} />
              <span className="flex-1">{item.name}</span>
              {active && <ChevronRight aria-hidden="true" className="h-4 w-4 text-slate-400" />}
            </Link>;
          })}
        </div>
      </nav>

      <div className="border-t border-white/10 p-4">
        <div className="mb-3 flex min-w-0 items-center gap-3 px-1">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-500/20 font-bold text-brand-200">{user.fullName.charAt(0).toUpperCase()}</span>
          <div className="min-w-0"><p className="truncate text-sm font-semibold text-white">{user.fullName}</p><p className="truncate text-xs text-slate-400">Quản trị viên</p></div>
        </div>
        <button onClick={handleLogout} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-white/10 text-sm font-semibold text-slate-300 transition hover:border-red-400/30 hover:bg-red-400/10 hover:text-red-200"><LogOut aria-hidden="true" className="h-4 w-4" />Đăng xuất</button>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh bg-canvas text-slate-900">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 bg-ink-950 lg:block">{sidebar}</aside>
      {navOpen && <div className="fixed inset-0 z-50 lg:hidden"><button aria-label="Đóng điều hướng" className="absolute inset-0 bg-slate-950/55" onClick={() => setNavOpen(false)} /><aside className="relative h-full w-[min(84vw,18rem)] bg-ink-950 shadow-2xl">{sidebar}</aside></div>}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur-sm sm:px-6 lg:px-8">
          <button onClick={() => setNavOpen(true)} aria-label="Mở điều hướng" aria-expanded={navOpen} className="grid h-11 w-11 place-items-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 lg:hidden"><Menu aria-hidden="true" className="h-5 w-5" /></button>
          <div className="min-w-0"><p className="text-xs font-medium text-slate-500">Không gian quản trị</p><p className="truncate text-sm font-semibold text-slate-900">{activeItem?.name ?? 'SmartOrder'}</p></div>
          <span className="ml-auto hidden items-center gap-2 text-xs font-medium text-slate-500 sm:flex"><span className="h-2 w-2 rounded-full bg-emerald-500" />Hệ thống đang trực tuyến</span>
        </header>
        <main id="main-content" tabIndex={-1} className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8"><div className="mx-auto max-w-[90rem]"><Outlet /></div></main>
      </div>
    </div>
  );
}
