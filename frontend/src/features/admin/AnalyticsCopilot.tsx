import { useEffect, useRef, useState } from 'react';
import { aiApi, type AnalyticsCopilotResponse } from '../../services/api/ai';
import { controlClass, labelClass, primaryButtonClass } from '../../components/ui';

const units = { VND: 'VND', orders: 'đơn', items: 'phần', reviews: 'đánh giá', stars: 'điểm', percent: '%', rank: 'hạng' };
export default function AnalyticsCopilot({ fromDate, toDate }: { fromDate: string; toDate: string }) {
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<AnalyticsCopilotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const clear = () => { pending.current?.abort(); pending.current = null; setLoading(false); setResponse(null); setError(''); };
  useEffect(() => {
    pending.current?.abort(); pending.current = null;
    setResponse(null); setLoading(false); setError('');
    return () => { pending.current?.abort(); pending.current = null; };
  }, [fromDate, toDate]);

  async function submit() {
    if (!query.trim() || loading) return;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(''); setResponse(null);
    try {
      const result = await aiApi.queryAnalytics({ query: query.trim(), ...(fromDate ? { fromDate } : {}), ...(toDate ? { toDate } : {}) }, controller.signal);
      if (pending.current === controller) setResponse(result);
    } catch {
      if (pending.current === controller && !controller.signal.aborted) setError('Chưa thể trả lời bằng AI. Kiểm tra khoảng ngày (cần đủ ngày đầu và cuối, tối đa một năm) rồi thử lại. Báo cáo vẫn sử dụng bình thường.');
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }

  return <section aria-labelledby="copilot-title" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
    <h2 id="copilot-title" className="text-lg font-bold text-slate-950">Ask Analytics</h2>
    <p id="copilot-hint" className="mt-1 text-sm text-slate-600">Hỏi về doanh thu, đơn đã thanh toán, món bán chạy hoặc đánh giá. Ngày báo cáo theo UTC; nếu không nêu kỳ trong câu hỏi, dùng bộ lọc ngày hoặc tháng hiện tại.</p>
    <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label className={labelClass}>Câu hỏi phân tích<input value={query} onChange={event => { clear(); setQuery(event.target.value); }} maxLength={500} required aria-describedby="copilot-hint" placeholder="Doanh thu tuần này so với tuần trước thế nào?" className={`${controlClass} mt-1.5`} /></label>
      <button type="submit" disabled={loading || !query.trim()} className={`${primaryButtonClass} min-h-11`}>{loading ? 'Đang phân tích…' : error ? 'Thử lại' : 'Hỏi phân tích'}</button>
    </form>
    <div role="status" aria-live="polite" className="mt-3 text-sm text-slate-600">{loading ? 'Đang lấy dữ liệu và kiểm tra câu trả lời…' : ''}</div>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {response && <div className="mt-4 space-y-4 break-words" aria-live="polite">
      <div><h3 className="font-semibold text-slate-950">Câu trả lời</h3><p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-700">{response.result.answer}</p></div>
      <div><h3 className="font-semibold text-slate-950">Dữ liệu sử dụng</h3>{response.facts.length ? <ul className="mt-2 space-y-3 text-sm text-slate-700">{response.facts.map(fact => <li key={fact.id} className="rounded-lg bg-slate-50 p-3">
        <p><span className="font-medium">{fact.label}{fact.dishName ? ` · ${fact.dishName}` : ''}:</span> {fact.value === null ? 'Chưa xác định' : `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(fact.value)} ${units[fact.unit]}`}</p>
        <p className="mt-1 text-slate-600">Kỳ: {fact.period.from.slice(0, 10)} – {fact.period.to.slice(0, 10)} ({fact.period.timezone})</p>
        {fact.comparisonPeriod && <p className="mt-1 text-slate-600">Đối chiếu: {fact.comparisonPeriod.from.slice(0, 10)} – {fact.comparisonPeriod.to.slice(0, 10)}</p>}
      </li>)}</ul> : <p className="mt-2 text-sm text-slate-600">Không có dữ liệu hỗ trợ câu hỏi này.</p>}</div>
      {response.warnings.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"><h3 className="font-semibold">Lưu ý</h3><ul className="mt-2 list-disc space-y-1 pl-5">{response.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div>}
    </div>}
  </section>;
}
