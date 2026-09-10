import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { recommendationsApi, type RecommendationConstraints, type RecommendationResponse } from '../../services/api/recommendations';
import type { PublicDish, SharedCart } from '../../services/api/menu';
import { secondaryButtonClass } from '../../components/ui';

const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });
type State = { key: string; response?: RecommendationResponse; error?: boolean };

export function MenuRecommendations({ cart, tableId, lang, constraints = {}, paused = false, onSelect }: {
  cart: SharedCart; tableId: string; lang: 'vi' | 'en'; constraints?: RecommendationConstraints;
  paused?: boolean; onSelect: (dish: PublicDish) => void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [retry, setRetry] = useState(0);
  // Quantity, note variants and duplicate Socket echoes do not change basket identity.
  const dishIds = [...new Set(cart.cart.map((item) => item.dishId))].sort();
  const key = JSON.stringify({ sessionId: cart.sessionId, tableId, lang, constraints, dishIds });
  useEffect(() => {
    if (paused) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const { sessionId, tableId: owner, lang: language, constraints: filters } = JSON.parse(key) as {
        sessionId: string; tableId: string; lang: 'vi' | 'en'; constraints: RecommendationConstraints;
      };
      void recommendationsApi.get({ sessionId, tableId: owner, lang: language, constraints: filters }, controller.signal)
        .then(response => { if (!controller.signal.aborted) setState({ key, response }); })
        .catch(() => { if (!controller.signal.aborted) setState({ key, error: true }); });
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key, paused, retry]);

  if (paused) return null;
  const active = state?.key === key ? state : null;
  const loading = !active;
  const en = lang === 'en';
  return <section aria-labelledby="recommendation-title" aria-busy={loading} className="mt-5 rounded-xl border border-stone-200 bg-white p-4">
    <h3 id="recommendation-title" className="font-bold text-stone-950">{en ? 'Suggestions for your basket' : 'Gợi ý ăn kèm'}</h3>
    <div role="status" className="mt-2 text-sm text-stone-600">
      {loading ? (en ? 'Loading suggestions…' : 'Đang tải gợi ý…') : active.error ?
        (en ? 'Suggestions are temporarily unavailable. Your cart is still usable.' : 'Chưa thể tải gợi ý. Bạn vẫn có thể dùng giỏ hàng.') :
        !active.response?.result.recommendations.length ? (en ? 'No suitable suggestions yet.' : 'Chưa có gợi ý phù hợp.') : null}
    </div>
    {active?.error && <button type="button" className={`${secondaryButtonClass} mt-3`} onClick={() => { setState(null); setRetry(value => value + 1); }}>{en ? 'Retry suggestions' : 'Thử lại gợi ý'}</button>}
    {!!active?.response?.result.recommendations.length && <ul className="mt-3 grid gap-3 sm:grid-cols-2">
      {active.response.result.recommendations.filter(item => item.dish.isAvailable && !dishIds.includes(item.dish._id)).map(({ dish, reason }) => <li key={dish._id} className="flex items-center gap-3 rounded-lg border border-stone-200 p-3">
        <div className="min-w-0 flex-1"><p className="break-words font-semibold text-stone-950">{dish.name}</p>
          <p className="mt-1 text-sm text-stone-600">{reason === 'popular' ? (en ? 'Popular' : 'Phổ biến') : (en ? 'Often ordered with selected dishes' : 'Thường được gọi cùng món đã chọn')}</p>
          <p className="mt-1 text-sm font-semibold text-accent-600">{currency.format(dish.price)}</p></div>
        <button type="button" className={`${secondaryButtonClass} min-h-11 shrink-0 scroll-mt-28 scroll-mb-28`} aria-label={`${en ? 'Choose' : 'Chọn'} ${dish.name}`} onClick={() => onSelect(dish)}><Plus aria-hidden="true" className="h-4 w-4" />{en ? 'Choose' : 'Chọn'}</button>
      </li>)}
    </ul>}
    {active?.response?.warnings.map(warning => <p key={warning} className="mt-3 text-sm leading-6 text-amber-800">{warning}</p>)}
  </section>;
}
