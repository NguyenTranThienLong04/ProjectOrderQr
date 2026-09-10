import { useEffect, useRef, useState } from 'react';
import { controlClass, labelClass, primaryButtonClass } from '../../components/ui';
import { dishApi, type Dish } from '../../services/api/dish';
import { reviewIntelligenceApi as api, type ReviewReport, type ReviewSources, type ReviewTopic, type ReviewSentiment } from '../../services/api/review-intelligence';

const sentiments: Record<ReviewSentiment, string> = { positive: 'Tích cực', negative: 'Tiêu cực', neutral: 'Trung tính', mixed: 'Trái chiều' };
const buttonClass = 'min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700 disabled:opacity-50';
export default function ReviewIntelligence({ fromDate, toDate }: { fromDate: string; toDate: string }) {
  const [dishId, setDishId] = useState('');
  const [dishes, setDishes] = useState<Dish[]>([]);
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [sources, setSources] = useState<ReviewSources | null>(null);
  const [sourceFilter, setSourceFilter] = useState<{ topic?: ReviewTopic; sentiment?: ReviewSentiment }>({});
  const [sourceLabel, setSourceLabel] = useState('Tất cả đánh giá');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef<AbortController | null>(null);
  const filter = { ...(dishId ? { dishId } : {}), ...(fromDate ? { fromDate } : {}), ...(toDate ? { toDate } : {}) };
  useEffect(() => {
    pending.current?.abort(); pending.current = null;
    setReport(null); setSources(null); setBusy(''); setError(''); setNotice('');
    return () => { pending.current?.abort(); pending.current = null; };
  }, [fromDate, toDate, dishId]);

  async function run(action: 'load' | 'analyze' | 'summary' | 'sources', page = 1, selection = sourceFilter, label = sourceLabel) {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(action); setError(''); setNotice('');
    if (action === 'sources') { setSources(null); setSourceFilter(selection); setSourceLabel(label); }
    try {
      if (action === 'sources') {
        const result = await api.sources({ ...filter, ...selection, page }, controller.signal);
        if (pending.current === controller) setSources(result);
      } else {
        if (action === 'analyze') {
          setSources(null);
          const batch = await api.analyze(filter, controller.signal);
          if (pending.current !== controller) return;
          setNotice(`Đã phân tích thêm ${batch.analyzed}/${batch.attempted} comment. ${batch.outcomes.some(o => o.status === 'failed') ? 'Một số comment chưa phân tích được; có thể thử lại.' : batch.attempted ? 'Bấm phân tích tiếp nếu còn comment.' : 'Không còn comment chờ phân tích.'}${batch.outcomes.some(o => o.warnings.length) ? ' Nhật ký AI tạm thời không khả dụng.' : ''}`);
        }
        const result = action === 'summary' ? await api.summary(filter, controller.signal) : await api.get(filter, controller.signal);
        if (pending.current !== controller) return;
        setReport(result);
        if (result.summaryStatus === 'unavailable') setError('AI chưa thể tạo tóm tắt. Số liệu và review nguồn vẫn xem được.');
        if (action === 'load' && !dishes.length) {
          try { const list = await dishApi.findAll(undefined, true); if (pending.current === controller) setDishes(list); }
          catch { if (pending.current === controller) setNotice('Chưa tải được danh sách món; vẫn xem được tổng hợp tất cả món.'); }
        }
      }
    } catch {
      if (pending.current === controller && !controller.signal.aborted) setError('Chưa thể tải Review Intelligence. Kiểm tra kết nối và bộ lọc ngày (đủ hai ngày, tối đa 366 ngày), rồi thử lại.');
    } finally { if (pending.current === controller) { pending.current = null; setBusy(''); } }
  }

  return <section aria-labelledby="review-intelligence-title" className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
    <h2 id="review-intelligence-title" className="text-lg font-bold text-slate-950">Review Intelligence</h2>
    <p className="mt-1 text-sm text-slate-600">Phân tích nội dung đánh giá theo bộ lọc ngày phía trên (UTC). Bỏ trống ngày để xem toàn bộ thời gian.</p>
    <div className="mt-4 flex flex-wrap items-end gap-3">
      <label className={`${labelClass} min-w-0 flex-1`}>Món cần phân tích<select className={`${controlClass} mt-1.5`} value={dishId} onChange={e => setDishId(e.target.value)}><option value="">Tất cả món</option>{dishes.map(dish => <option key={dish._id} value={dish._id}>{dish.name}</option>)}</select></label>
      <button className={`${primaryButtonClass} min-h-11`} disabled={!!busy} onClick={() => void run('load')}>Xem số liệu đánh giá</button>
    </div>
    <p role="status" aria-live="polite" className="mt-3 text-sm text-slate-600">{busy ? busy === 'analyze' ? 'Đang phân tích tối đa 5 comment…' : busy === 'summary' ? 'Đang tạo tóm tắt từ số liệu…' : 'Đang tải dữ liệu đánh giá…' : notice}</p>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {!report && !busy && <p className="mt-3 text-sm text-slate-600">Mẫu phân tích: chưa tải. Chọn “Xem số liệu đánh giá” để bắt đầu.</p>}
    {report && <div className="mt-4 space-y-4 text-sm text-slate-700">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[
        ['Tổng đánh giá', report.facts.totalReviews], ['Có comment', report.facts.commentCount], ['Comment đã phân tích (mẫu)', report.facts.sampleSize], ['Điểm gốc trung bình / 5', report.facts.averageRating ?? '—'],
      ].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-3"><dt>{label}</dt><dd className="mt-1 text-xl font-bold text-slate-950">{value}</dd></div>)}</dl>
      <p>Độ phủ phân tích: {report.facts.analysisCoveragePercentage}%. Cập nhật {new Date(report.generatedAt).toLocaleString('vi-VN')}.</p>
      {report.warnings.length > 0 && <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950">{report.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
      {!report.facts.totalReviews ? <p>Chưa có đánh giá trong bộ lọc này.</p> : <>
        {!report.facts.commentCount && <p>Các đánh giá chỉ có điểm số; không có comment để phân tích bằng AI.</p>}
        <div className="flex flex-wrap gap-2">
          <button className={buttonClass} disabled={!!busy || report.facts.analyzedCommentCount >= report.facts.commentCount} onClick={() => void run('analyze')}>Phân tích thêm tối đa 5 comment</button>
          <button className={buttonClass} disabled={!!busy || !report.facts.sampleSize} onClick={() => void run('summary')}>Tạo tóm tắt AI</button>
          <button className={buttonClass} disabled={!!busy} onClick={() => void run('sources', 1, {}, 'Tất cả đánh giá')}>Xem review nguồn</button>
        </div>
        {report.facts.sampleSize > 0 && <>
          <div className="flex flex-wrap gap-2">{(Object.keys(sentiments) as ReviewSentiment[]).map(s => <button key={s} disabled={!!busy} className={buttonClass} onClick={() => void run('sources', 1, { sentiment: s }, sentiments[s])}>{sentiments[s]}: {report.facts.sentimentCounts[s]} ({report.facts.sentimentPercentages[s]}%)</button>)}</div>
          <div className="grid gap-4 sm:grid-cols-2">{(['positive', 'negative'] as const).map(s => <div key={s}><h3 className="font-semibold text-slate-950">{s === 'positive' ? 'Chủ đề tích cực' : 'Vấn đề được đề cập'}</h3><ul className="mt-2 space-y-2">{report.facts.topics.filter(t => t.sentiments[s] > 0).map(t => <li key={t.topic}><button disabled={!!busy} className={`${buttonClass} w-full text-left`} onClick={() => void run('sources', 1, { topic: t.topic, sentiment: s }, `${t.label} · ${sentiments[s]}`)}>{t.label}: {t.sentiments[s]} comment</button></li>)}</ul>{!report.facts.topics.some(t => t.sentiments[s] > 0) && <p className="mt-2">Chưa có đề cập {sentiments[s].toLowerCase()} trong mẫu.</p>}</div>)}</div>
          <details className="rounded-lg border border-slate-200 p-3"><summary className="min-h-11 cursor-pointer font-medium">Tất cả chủ đề và số lượt đề cập</summary><p className="mb-2">Tỷ lệ trên {report.facts.sampleSize} comment đã phân tích. Một comment có thể đề cập nhiều chủ đề nên tổng tỷ lệ có thể vượt 100%.</p><ul className="space-y-2">{report.facts.topics.map(t => <li key={t.topic}><button disabled={!!busy} className={buttonClass} onClick={() => void run('sources', 1, { topic: t.topic }, t.label)}>{t.label}: {t.count} ({t.percentage}%)</button><p className="mt-1">{(Object.keys(sentiments) as ReviewSentiment[]).map(s => `${sentiments[s]}: ${t.sentiments[s]}`).join(' · ')}</p></li>)}</ul></details>
        </>}
      </>}
      {report.summary && <div><h3 className="font-semibold text-slate-950">Tóm tắt AI</h3><p className="mt-2 leading-6">{report.summary}</p><p className="mt-2 break-words text-xs text-slate-600">{report.modelVersion}</p></div>}
      {sources && <div aria-live="polite"><h3 className="font-semibold text-slate-950">Review nguồn · {sourceLabel}</h3><p className="mt-1">{sources.total} đánh giá khớp · Trang {sources.page}</p><ul className="mt-3 space-y-3">{sources.reviews.map(review => <li key={review._id} className="rounded-lg border border-slate-200 p-3 [overflow-wrap:anywhere]"><p className="font-medium">{dishes.find(d => d._id === review.dishId)?.name ?? `Món ${review.dishId}`} · {review.rating}/5</p><p className="mt-2 whitespace-pre-wrap">{review.comment || 'Không có comment.'}</p><p className="mt-2 text-xs text-slate-600">Review {review._id} · {new Date(review.createdAt).toLocaleString('vi-VN')}</p><p className="mt-1 text-xs text-slate-600">{review.aiInsight ? `${sentiments[review.aiInsight.sentiment]} · ${review.aiInsight.modelVersion} · ${review.aiInsight.taxonomyVersion} · Phân tích ${new Date(review.aiInsight.analyzedAt).toLocaleString('vi-VN')}` : 'Chưa có phân tích AI.'}</p></li>)}</ul>{!sources.total && <p className="mt-2">Không có review nguồn khớp bộ lọc.</p>}<div className="mt-3 flex gap-2"><button className={buttonClass} disabled={!!busy || sources.page <= 1} onClick={() => void run('sources', sources.page - 1)}>Trang trước</button><button className={buttonClass} disabled={!!busy || sources.page * sources.pageSize >= sources.total} onClick={() => void run('sources', sources.page + 1)}>Trang sau</button></div></div>}
    </div>}
  </section>;
}
