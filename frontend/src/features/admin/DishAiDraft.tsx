import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import {
  aiApi,
  dishDraftFields,
  type DishDraftField,
  type DishDraftInput,
  type DishDraftResponse,
  type DishDraftResult,
} from "../../services/api/ai";
import {
  controlClass,
  Feedback,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "../../components/ui";

const labels: Record<DishDraftField, string> = {
  nameEn: "Tên tiếng Anh",
  description: "Mô tả tiếng Việt",
  descriptionEn: "Mô tả tiếng Anh",
};
const limits: Record<DishDraftField, number> = {
  nameEn: 200,
  description: 1000,
  descriptionEn: 1000,
};
const errorMessages: Record<string, string> = {
  AI_DISABLED: "AI hiện đang tắt.",
  AI_NOT_CONFIGURED: "AI chưa được cấu hình.",
  AI_PROVIDER_AUTH_ERROR: "Chưa thể kết nối dịch vụ AI.",
  AI_TIMEOUT: "AI phản hồi quá lâu. Bạn có thể thử lại.",
  AI_RATE_LIMIT: "Đã đạt giới hạn yêu cầu AI. Vui lòng thử lại sau một phút.",
  AI_INVALID_OUTPUT: "Bản nháp AI không hợp lệ. Bạn có thể tạo lại.",
  AI_PROVIDER_UNAVAILABLE: "Dịch vụ AI tạm thời không khả dụng.",
  AI_REFUSED: "AI chưa thể xử lý nội dung này. Hãy chỉnh nội dung và thử lại.",
};

export function DishAiDraft({
  input,
  onUse,
  disabled = false,
}: {
  input: Omit<DishDraftInput, "generateFields">;
  onUse: (draft: DishDraftResult) => void;
  disabled?: boolean;
}) {
  const [fields, setFields] = useState<DishDraftField[]>([...dishDraftFields]);
  const [preview, setPreview] = useState<DishDraftResponse | null>(null);
  const [snapshot, setSnapshot] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const signature = JSON.stringify(input);
  const stale = preview !== null && snapshot !== signature;
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );

  const discard = () => {
    pending.current?.abort();
    pending.current = null;
    setLoading(false);
    setPreview(null);
    setError(null);
    setNotice(null);
  };
  const generate = async () => {
    if (pending.current || disabled) return;
    if (!input.name.trim() || !fields.length) {
      setError("Nhập tên món và chọn ít nhất một trường cần tạo.");
      return;
    }
    if (
      input.name.trim().length > 200 ||
      (input.nameEn?.trim().length ?? 0) > 200 ||
      (input.description?.trim().length ?? 0) > 2000 ||
      (input.descriptionEn?.trim().length ?? 0) > 2000
    ) {
      setError(
        "AI nhận tên tối đa 200 ký tự, mô tả tối đa 2.000 ký tự. Hãy rút gọn nội dung để tạo bản nháp.",
      );
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    setSnapshot(signature);
    try {
      const response = await aiApi.dishDraft(
        { ...input, generateFields: fields },
        controller.signal,
      );
      if (pending.current !== controller || controller.signal.aborted) return;
      setPreview(response);
    } catch (requestError) {
      if (pending.current !== controller || controller.signal.aborted) return;
      const code = (requestError as { response?: { data?: { code?: string } } })
        .response?.data?.code;
      setError(
        errorMessages[code ?? ""] ??
          "Không thể tạo bản nháp AI. Kiểm tra nội dung hoặc thử lại.",
      );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setLoading(false);
      }
    }
  };
  const resultFields = dishDraftFields.filter(
    (field) => preview?.result[field] !== undefined,
  );
  const invalidPreview =
    !resultFields.length ||
    resultFields.some((field) => {
      const value = preview?.result[field] ?? "";
      return !value.trim() || value.length > limits[field];
    });

  return (
    <section
      aria-label="AI suggestion"
      className="space-y-3 rounded-lg border border-brand-200 bg-brand-50 p-4"
    >
      <div>
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Sparkles aria-hidden="true" className="h-4 w-4" />
          AI suggestion
        </h3>
        <p className="mt-1 text-sm text-slate-700">
          Xem và sửa bản nháp trước khi dùng. Kiểm tra tên và mô tả; AI có thể
          viết sai thông tin món. Món chỉ được lưu khi bạn bấm nút lưu của form.
        </p>
      </div>
      <fieldset disabled={loading || disabled} className="space-y-1">
        <legend className={labelClass}>Trường cần tạo</legend>
        <div className="flex flex-wrap gap-x-4">
          {dishDraftFields.map((field) => (
            <label
              key={field}
              className="flex min-h-11 items-center gap-2 text-sm text-slate-700"
            >
              <input
                type="checkbox"
                checked={fields.includes(field)}
                onChange={(event) =>
                  setFields((current) =>
                    event.target.checked
                      ? [...current, field]
                      : current.filter((item) => item !== field),
                  )
                }
                className="h-4 w-4 accent-brand-600"
              />
              {labels[field]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void generate()}
          disabled={loading || disabled}
          className={secondaryButtonClass}
        >
          {loading
            ? "Đang tạo bản nháp…"
            : error
              ? "Thử lại với AI"
              : preview
                ? "Regenerate"
                : "Generate with AI"}
        </button>
        {(loading || preview || error) && (
          <button
            type="button"
            onClick={discard}
            className={secondaryButtonClass}
          >
            {loading ? "Hủy tạo bản nháp" : "Bỏ bản nháp"}
          </button>
        )}
      </div>
      {loading && (
        <p role="status" className="text-sm text-slate-700">
          AI đang xử lý. Bạn vẫn có thể nhập hoặc lưu món thủ công.
        </p>
      )}
      {error && (
        <Feedback tone="danger">
          {error} Bạn vẫn có thể nhập và lưu món thủ công.
        </Feedback>
      )}
      {notice && (
        <p role="status" className="text-sm text-slate-700">
          {notice}
        </p>
      )}
      {preview && (
        <div className="space-y-3 border-t border-brand-200 pt-3">
          <p role="status" className="text-sm font-semibold text-slate-800">
            Bản nháp đã sẵn sàng. Use Draft sẽ thay các trường bên dưới trong
            form.
          </p>
          {preview.warnings.length > 0 && (
            <Feedback tone="warning">
              {preview.warnings.includes("AI_AUDIT_UNAVAILABLE")
                ? "Chưa ghi được nhật ký AI cho bản nháp này."
                : "AI trả về cảnh báo. Hãy kiểm tra kỹ bản nháp."}
            </Feedback>
          )}
          {resultFields.map((field) => (
            <div key={field}>
              <p className="mb-1 whitespace-pre-wrap break-words text-sm text-slate-600">
                Hiện tại — {labels[field]}: {input[field] || "(Trống)"}
              </p>
              <label className={labelClass}>
                Bản nháp — {labels[field]}
                <textarea
                  rows={field === "nameEn" ? 2 : 3}
                  maxLength={limits[field]}
                  value={preview.result[field]}
                  onChange={(event) =>
                    setPreview({
                      ...preview,
                      result: {
                        ...preview.result,
                        [field]: event.target.value,
                      },
                    })
                  }
                  className={`${controlClass} mt-1.5 resize-y`}
                />
              </label>
            </div>
          ))}
          {stale && (
            <Feedback tone="warning">
              Nội dung form đã thay đổi từ lúc yêu cầu AI. Hãy tạo lại bản nháp
              từ nội dung mới.
            </Feedback>
          )}
          <button
            type="button"
            disabled={stale || invalidPreview || disabled}
            className={primaryButtonClass}
            onClick={() => {
              if (!preview || stale || invalidPreview || disabled) return;
              const approved: DishDraftResult = {};
              for (const field of resultFields)
                approved[field] = preview.result[field]!.trim();
              onUse(approved);
              setPreview(null);
              setNotice(
                "Đã đưa bản nháp vào form. Kiểm tra và bấm lưu món khi sẵn sàng.",
              );
            }}
          >
            Use Draft
          </button>
        </div>
      )}
    </section>
  );
}
