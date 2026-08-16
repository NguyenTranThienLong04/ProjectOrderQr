import { useEffect, useState } from 'react';
import { CheckCircle2, LoaderCircle, MessageSquareText, Star } from 'lucide-react';
import { reviewApi, type ReviewableItem } from '../../services/api/review';
import { Feedback, controlClass, primaryButtonClass } from '../../components/ui';

export function ReviewFeedback({ orderId, sessionId }: { orderId: string; sessionId: string }) {
  const [items, setItems] = useState<ReviewableItem[]>([]);
  const [rating, setRating] = useState<Record<string, number>>({});
  const [comment, setComment] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [submittingId, setSubmittingId] = useState('');
  useEffect(() => { void reviewApi.getReviewable(orderId, sessionId).then((result) => setItems(result.items)).catch(() => setMessage('Chưa thể tải danh sách đánh giá.')); }, [orderId, sessionId]);
  const submit = async (dishId: string) => {
    if (!rating[dishId]) return setMessage('Chọn từ 1 đến 5 sao trước khi gửi.');
    setSubmittingId(dishId); setMessage('');
    try {
      await reviewApi.create({ orderId, sessionId, dishId, rating: rating[dishId], comment: comment[dishId] });
      setItems((current) => current.map((item) => item.dishId === dishId ? { ...item, reviewed: true } : item));
      setMessage('Cảm ơn bạn! Đánh giá đã được ghi nhận.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Không thể gửi đánh giá. Vui lòng thử lại.'); }
    finally { setSubmittingId(''); }
  };
  if (items.length === 0 && !message) return null;
  return <section aria-labelledby="review-title" className="rounded-xl border border-stone-200 bg-white p-4 sm:p-5"><div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-700"><MessageSquareText aria-hidden="true" className="h-5 w-5" /></span><div><h2 id="review-title" className="font-bold text-stone-950">Trải nghiệm món ăn thế nào?</h2><p className="mt-1 text-xs leading-5 text-stone-500">Đánh giá từng món giúp nhà hàng phục vụ tốt hơn.</p></div></div>{message && <div className="mt-4"><Feedback tone={message.startsWith('Cảm ơn') ? 'success' : 'warning'}>{message}</Feedback></div>}<div className="mt-4 divide-y divide-stone-200">{items.map((item) => <div key={item.dishId} className="py-4 first:pt-0 last:pb-0"><div className="flex items-center justify-between gap-3"><p className="font-semibold text-stone-950">{item.dishName}</p>{item.reviewed && <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700"><CheckCircle2 aria-hidden="true" className="h-4 w-4" />Đã đánh giá</span>}</div>{!item.reviewed && <><div className="mt-2 flex gap-2" role="group" aria-label={`Chấm điểm ${item.dishName}`}>{[1, 2, 3, 4, 5].map((star) => <button key={star} onClick={() => setRating((current) => ({ ...current, [item.dishId]: star }))} aria-label={`${star} sao cho ${item.dishName}`} aria-pressed={star === rating[item.dishId]} className="grid h-11 w-11 place-items-center rounded-lg hover:bg-amber-50"><Star aria-hidden="true" className={`h-6 w-6 ${star <= (rating[item.dishId] ?? 0) ? 'fill-amber-400 text-amber-500' : 'text-stone-300'}`} /></button>)}</div><label className="mt-3 block text-sm font-semibold text-stone-700">Nhận xét <span className="font-normal text-stone-500">(không bắt buộc)</span><textarea rows={2} value={comment[item.dishId] ?? ''} onChange={(event) => setComment((current) => ({ ...current, [item.dishId]: event.target.value }))} maxLength={500} placeholder="Điều bạn thích hoặc muốn nhà hàng cải thiện" className={`${controlClass} mt-1.5 resize-y`} /></label><button onClick={() => void submit(item.dishId)} disabled={submittingId === item.dishId} className={`${primaryButtonClass} mt-3`}>{submittingId === item.dishId && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}Gửi đánh giá</button></>}</div>)}</div></section>;
}
