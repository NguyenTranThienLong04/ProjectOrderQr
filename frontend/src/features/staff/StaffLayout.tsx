import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { ChefHat, LogOut, UtensilsCrossed } from 'lucide-react';
import { handleLogout } from '../../services/api/axios-client';
import { LoadingState } from '../../components/ui';

interface User { id: string; email: string; role: 'admin' | 'kitchen' | 'waiter'; fullName: string; }

export function StaffLayout() {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    const userData = localStorage.getItem('user');
    if (!token || !userData) return handleLogout();
    try { setUser(JSON.parse(userData)); } catch { handleLogout(); }
  }, []);
  if (!user) return <div className="grid min-h-dvh place-items-center bg-slate-950"><LoadingState label="Đang mở màn hình vận hành…" dark /></div>;
  const Icon = user.role === 'kitchen' ? ChefHat : UtensilsCrossed;
  return <div className="min-h-dvh bg-slate-100">
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-[100rem] items-center gap-3 px-4 sm:px-6">
        <span className="grid h-10 w-10 place-items-center rounded-lg bg-brand-600 text-white"><Icon aria-hidden="true" className="h-5 w-5" /></span>
        <div><p className="text-sm font-bold text-slate-950">SmartOrder</p><p className="text-xs text-slate-500">{user.role === 'kitchen' ? 'Điều phối bếp' : 'Điều phối phục vụ'}</p></div>
        <div className="ml-auto min-w-0 text-right"><p className="max-w-32 truncate text-sm font-semibold text-slate-900 sm:max-w-none">{user.fullName}</p><p className="hidden text-xs text-slate-500 sm:block">{user.role === 'kitchen' ? 'Nhân viên bếp' : 'Nhân viên phục vụ'}</p></div>
        <button onClick={handleLogout} aria-label="Đăng xuất" className="grid h-11 w-11 place-items-center rounded-lg border border-slate-200 text-slate-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700 sm:flex sm:w-auto sm:px-3"><LogOut aria-hidden="true" className="h-4 w-4" /><span className="hidden text-sm font-semibold sm:inline">Đăng xuất</span></button>
      </div>
    </header>
    <Outlet />
  </div>;
}
