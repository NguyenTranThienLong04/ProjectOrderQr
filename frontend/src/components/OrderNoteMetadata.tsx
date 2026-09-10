import type { OrderNoteAnalysis } from '../services/api/ai';

export function OrderNoteMetadata({ analysis }: { analysis?: OrderNoteAnalysis }) {
  if (!analysis?.confirmedByCustomer) return null;
  return <section aria-label="AI hỗ trợ ghi chú" className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-700">
    <p className="font-semibold">AI hỗ trợ · Khách đã xác nhận</p>
    <p className="break-words">{analysis.summary}</p>
    {analysis.allergyMentioned && <p className="font-bold text-red-800">Có đề cập dị ứng — cần xác minh trực tiếp</p>}
    {analysis.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-amber-900">{analysis.warnings.map((warning) => <li key={warning}>{warning === 'AI_AUDIT_UNAVAILABLE' ? 'Không thể lưu lịch sử phân tích AI.' : warning}</li>)}</ul>}
    <p className="text-xs">Luôn xử lý theo ghi chú gốc và xác nhận với khách khi cần.</p>
  </section>;
}
