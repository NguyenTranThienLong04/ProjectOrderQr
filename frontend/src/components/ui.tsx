import {
  AlertCircle,
  BellRing,
  CheckCircle2,
  ChefHat,
  CircleDot,
  Clock3,
  CreditCard,
  EyeOff,
  Info,
  LoaderCircle,
  type LucideIcon,
  UsersRound,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'brand';

const toneClasses: Record<Tone, string> = {
  neutral: 'border-slate-200 bg-slate-100 text-slate-700',
  info: 'border-blue-200 bg-blue-50 text-blue-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  danger: 'border-red-200 bg-red-50 text-red-800',
  brand: 'border-brand-200 bg-brand-50 text-brand-800',
};

const statusPresentation: Record<string, { label: string; tone: Tone; icon: LucideIcon }> = {
  Pending: { label: 'Chờ xác nhận', tone: 'warning', icon: Clock3 },
  Preparing: { label: 'Đang chế biến', tone: 'info', icon: ChefHat },
  Ready: { label: 'Sẵn sàng phục vụ', tone: 'success', icon: BellRing },
  Served: { label: 'Đã phục vụ', tone: 'brand', icon: CheckCircle2 },
  Paid: { label: 'Đã thanh toán', tone: 'success', icon: CreditCard },
  Cancelled: { label: 'Đã hủy', tone: 'danger', icon: XCircle },
  available: { label: 'Bàn trống', tone: 'success', icon: CheckCircle2 },
  occupied: { label: 'Đang phục vụ', tone: 'warning', icon: UsersRound },
  waiting_payment: { label: 'Chờ thanh toán', tone: 'info', icon: CreditCard },
  hidden: { label: 'Tạm ẩn', tone: 'neutral', icon: EyeOff },
  active: { label: 'Đang hoạt động', tone: 'success', icon: CircleDot },
  inactive: { label: 'Tạm ngừng', tone: 'neutral', icon: CircleDot },
  merged: { label: 'Bàn ghép', tone: 'brand', icon: UsersRound },
  waiter_call: { label: 'Khách gọi phục vụ', tone: 'warning', icon: BellRing },
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const presentation = statusPresentation[status] ?? {
    label: status,
    tone: 'neutral' as Tone,
    icon: CircleDot,
  };
  const Icon = presentation.icon;
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClasses[presentation.tone]}`}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span>{label ?? presentation.label}</span>
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-xs font-bold uppercase tracking-[0.16em] text-brand-700">{eyebrow}</p>}
        <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-[1.75rem]">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Feedback({
  tone = 'info',
  children,
}: {
  tone?: Exclude<Tone, 'neutral' | 'brand'>;
  children: ReactNode;
}) {
  const Icon = tone === 'danger' ? AlertCircle : tone === 'success' ? CheckCircle2 : tone === 'warning' ? BellRing : Info;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} aria-live="polite" className={`flex items-start gap-3 rounded-lg border p-3.5 text-sm leading-5 ${toneClasses[tone]}`}>
      <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function LoadingState({ label = 'Đang tải dữ liệu…', dark = false }: { label?: string; dark?: boolean }) {
  return (
    <div role="status" className={`flex min-h-40 items-center justify-center gap-3 text-sm ${dark ? 'text-slate-300' : 'text-slate-600'}`}>
      <LoaderCircle aria-hidden="true" className="h-5 w-5 animate-spin text-brand-500" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  icon: Icon = Info,
  title,
  description,
  action,
  dark = false,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  dark?: boolean;
}) {
  return (
    <div className={`rounded-xl border border-dashed px-5 py-10 text-center ${dark ? 'border-slate-700 bg-slate-900 text-slate-300' : 'border-slate-300 bg-white text-slate-600'}`}>
      <Icon aria-hidden="true" className="mx-auto h-7 w-7 text-slate-400" />
      <h2 className={`mt-3 text-base font-semibold ${dark ? 'text-white' : 'text-slate-900'}`}>{title}</h2>
      {description && <p className="mx-auto mt-1 max-w-md text-sm leading-6">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    window.setTimeout(() => dialog?.querySelector<HTMLElement>('input, select, textarea, button')?.focus(), 0);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/55 p-0 sm:items-center sm:p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} className={`safe-bottom max-h-[92dvh] w-full overflow-y-auto rounded-t-xl border border-slate-200 bg-white shadow-2xl sm:rounded-xl ${widths[size]}`}>
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4">
          <div>
            <h2 id={titleId} className="text-lg font-bold text-slate-950">{title}</h2>
            {description && <p id={descriptionId} className="mt-1 text-sm text-slate-600">{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Đóng hộp thoại" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900">
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
        <div className="px-5 py-5">{children}</div>
        {footer && <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-slate-200 bg-white px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Xác nhận',
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return <Modal open={open} title={title} description={description} onClose={onClose} size="sm" footer={<><button type="button" disabled={busy} onClick={onClose} className={secondaryButtonClass}>Hủy</button><button type="button" disabled={busy} onClick={onConfirm} className={dangerButtonClass}>{busy && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}{confirmLabel}</button></>}><Feedback tone="warning">Hành động này có thể ảnh hưởng tới dữ liệu đang sử dụng. Hãy kiểm tra đúng đối tượng trước khi tiếp tục.</Feedback></Modal>;
}

export const controlClass = 'min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition hover:border-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-100 disabled:text-slate-500';
export const labelClass = 'block text-sm font-semibold text-slate-700';
export const primaryButtonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50';
export const secondaryButtonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 disabled:opacity-50';
export const dangerButtonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50';
