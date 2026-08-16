import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChefHat, Eye, EyeOff, LoaderCircle, LockKeyhole, Mail } from 'lucide-react';
import { authApi } from '../../services/api/auth';
import { controlClass, Feedback, primaryButtonClass } from '../../components/ui';

type Role = 'admin' | 'kitchen' | 'waiter';
const getHomePath = (role: Role) => role === 'kitchen' ? '/kitchen' : role === 'waiter' ? '/waiter' : '/admin';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    const userRaw = localStorage.getItem('user');
    if (!token || !userRaw) return;
    try { navigate(getHomePath((JSON.parse(userRaw) as { role: Role }).role), { replace: true }); }
    catch { localStorage.removeItem('accessToken'); }
  }, [navigate]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!email || !password) return setError('Nhập email và mật khẩu để tiếp tục.');
    setError(null); setLoading(true);
    try {
      const data = await authApi.login(email, password);
      localStorage.setItem('accessToken', data.accessToken);
      localStorage.setItem('refreshToken', data.refreshToken);
      localStorage.setItem('user', JSON.stringify(data.user));
      navigate(getHomePath(data.user.role), { replace: true });
    } catch (requestError: unknown) {
      const message = (requestError as { response?: { data?: { message?: string } } }).response?.data?.message;
      setError(message || 'Không thể đăng nhập. Kiểm tra lại thông tin và thử lại.');
    } finally { setLoading(false); }
  };

  return <main id="main-content" tabIndex={-1} className="grid min-h-dvh bg-canvas lg:grid-cols-[minmax(24rem,0.9fr)_1.1fr]">
    <section className="flex items-center justify-center px-5 py-10 sm:px-10 lg:order-2">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-lg bg-brand-600 text-white"><ChefHat aria-hidden="true" className="h-6 w-6" /></span><div><p className="font-bold text-slate-950">SmartOrder</p><p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">Restaurant Operations</p></div></div>
        <p className="text-sm font-bold uppercase tracking-[0.14em] text-brand-700">Cổng nhân viên</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Chào mừng trở lại</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">Đăng nhập để tiếp tục ca làm việc tại bếp, khu vực phục vụ hoặc quản trị.</p>

        <form className="mt-7 space-y-5" onSubmit={handleSubmit} noValidate>
          {error && <Feedback tone="danger">{error}</Feedback>}
          <div><label htmlFor="email" className="block text-sm font-semibold text-slate-700">Email</label><div className="relative mt-1.5"><Mail aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="ten@restaurant.com" className={`${controlClass} pl-10`} /></div></div>
          <div><label htmlFor="password" className="block text-sm font-semibold text-slate-700">Mật khẩu</label><div className="relative mt-1.5"><LockKeyhole aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} className={`${controlClass} px-10`} /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} aria-pressed={showPassword} className="absolute right-0 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-lg text-slate-500 hover:text-slate-900">{showPassword ? <EyeOff aria-hidden="true" className="h-4 w-4" /> : <Eye aria-hidden="true" className="h-4 w-4" />}</button></div></div>
          <button type="submit" disabled={loading} className={`${primaryButtonClass} w-full`}>{loading && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}{loading ? 'Đang xác thực…' : 'Đăng nhập'}</button>
        </form>
        <p className="mt-6 text-center text-xs leading-5 text-slate-500">Tài khoản được cấp theo vai trò. Liên hệ quản trị viên nếu bạn không thể truy cập.</p>
      </div>
    </section>

    <aside className="relative hidden overflow-hidden bg-ink-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
      <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full border border-white/10" /><div className="absolute -bottom-36 -left-24 h-96 w-96 rounded-full border border-brand-500/30" />
      <div className="relative"><p className="text-sm font-bold uppercase tracking-[0.18em] text-brand-200">Một nhịp vận hành</p><h2 className="mt-5 max-w-xl text-4xl font-bold leading-tight tracking-tight">Từ bếp đến bàn ăn, mọi trạng thái đều rõ ràng.</h2><p className="mt-5 max-w-lg text-base leading-7 text-slate-300">Điều phối món, bàn và thanh toán theo thời gian thực — tập trung vào việc cần xử lý ngay trong ca.</p></div>
      <div className="relative grid grid-cols-3 gap-3"><div className="border-l-2 border-amber-400 pl-3"><strong className="block text-lg">Bếp</strong><span className="text-xs text-slate-400">Chế biến đúng nhịp</span></div><div className="border-l-2 border-blue-400 pl-3"><strong className="block text-lg">Phục vụ</strong><span className="text-xs text-slate-400">Ưu tiên đúng bàn</span></div><div className="border-l-2 border-emerald-400 pl-3"><strong className="block text-lg">Quản trị</strong><span className="text-xs text-slate-400">Dữ liệu dễ đọc</span></div></div>
    </aside>
  </main>;
}
