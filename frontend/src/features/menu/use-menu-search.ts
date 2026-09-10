import { useEffect, useRef, useState } from 'react';
import { aiApi, type MenuSearchResponse } from '../../services/api/ai';

export function useMenuSearch(tableId: string, lang: 'vi' | 'en') {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<{ key: string; loading: boolean; response?: MenuSearchResponse } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const key = JSON.stringify([tableId, lang, query]);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => () => { pending.current?.abort(); }, [tableId, lang]);
  const reset = (value = '') => { pending.current?.abort(); pending.current = null; setState(null); setQuery(value); };
  const submit = async () => {
    if (!query.trim() || query.length > 500 || !tableId) return;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setState({ key, loading: true });
    try {
      const response = await aiApi.searchMenu({ tableId, query: query.trim(), lang }, controller.signal);
      if (!controller.signal.aborted && currentKey.current === key) setState({ key, loading: false, response });
    } catch {
      if (!controller.signal.aborted && currentKey.current === key) setState({ key, loading: false, response: {
        result: { dishes: [], appliedFilters: {} }, modelVersion: 'text-search', fallbackUsed: true,
        warnings: [lang === 'vi' ? 'AI chưa khả dụng. Đang tìm theo tên như bình thường; các điều kiện yêu cầu chưa được xác minh.' : 'AI search is unavailable. Showing normal name search; requested conditions have not been verified.'],
      } });
    }
  };
  const active = state?.key === key ? state : null;
  return { query, reset, submit, loading: active?.loading ?? false, response: active?.response };
}

