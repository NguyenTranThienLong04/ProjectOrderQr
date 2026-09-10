import { useEffect, useRef, useState } from 'react';
import { aiApi, type OrderNoteResponse } from '../../services/api/ai';
import { secondaryButtonClass } from '../../components/ui';

export function OrderNotePreview({ sessionId, tableId, dishId, note, acceptedToken, onAccept }: {
  sessionId: string; tableId: string; dishId: string; note: string;
  acceptedToken?: string; onAccept: (token?: string) => void;
}) {
  const [preview, setPreview] = useState<OrderNoteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const ignore = () => { request.current?.abort(); request.current = null; setLoading(false); setPreview(null); setError(false); onAccept(undefined); };
  const analyze = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(false); setPreview(null); onAccept(undefined);
    try {
      const result = await aiApi.analyzeOrderNote({ sessionId, tableId, dishId, note }, controller.signal);
      if (!controller.signal.aborted) setPreview(result);
    } catch { if (!controller.signal.aborted) setError(true); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  return <section aria-label="Phân tích ghi chú bằng AI" className="mt-4 space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm leading-6">
    <p>AI hỗ trợ hiểu ghi chú. Bạn vẫn có thể thêm món ngay bằng ghi chú gốc.</p>
    <button type="button" disabled={!note.trim() || !sessionId || loading} onClick={() => void analyze()} className={secondaryButtonClass}>{loading ? 'Đang phân tích…' : 'Analyze with AI'}</button>
    {loading && <p role="status">Đang phân tích ghi chú…</p>}
    {error && <p role="alert" className="text-red-800">Chưa thể phân tích bằng AI. Bạn có thể thử lại hoặc thêm món bằng ghi chú gốc.</p>}
    {preview && <div aria-live="polite" className="space-y-2">
      <p className="font-semibold">Ghi chú gốc:</p><p className="whitespace-pre-wrap break-words font-semibold text-stone-950">{note}</p>
      <p className="font-semibold">AI hiểu:</p><p>{preview.result.summary}</p>
      {preview.result.allergyMentioned && <p className="font-bold text-red-800">Có đề cập dị ứng — cần xác minh với nhân viên</p>}
      {preview.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-amber-900">{preview.warnings.map(warning => <li key={warning}>{warning === 'AI_AUDIT_UNAVAILABLE' ? 'Không thể lưu lịch sử phân tích AI.' : warning}</li>)}</ul>}
      {acceptedToken ? <p role="status" className="font-semibold text-emerald-800">Đã chọn phân tích. Ghi chú gốc vẫn được gửi nguyên văn.</p> : <button type="button" onClick={() => onAccept(preview.analysisToken)} className={secondaryButtonClass}>Use analysis</button>}
    </div>}
    {(loading || preview || error) && <button type="button" onClick={ignore} className={secondaryButtonClass}>Ignore</button>}
  </section>;
}
