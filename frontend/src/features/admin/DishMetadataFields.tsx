import { Plus, X } from 'lucide-react';
import { Feedback, controlClass, labelClass, secondaryButtonClass } from '../../components/ui';
import type { DishMetadataOptions } from '../../services/api/dish';

import type { DishMetadataForm } from './dish-metadata-form';

function MultiSelect({ label, options, values, onChange }: {
  label: string;
  options: { value: string; label: string }[];
  values: string[];
  onChange: (values: string[]) => void;
}) {
  return <fieldset>
    <legend className={labelClass}>{label}</legend>
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {options.map((option) => <label key={option.value} className="flex min-h-11 items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
        <input type="checkbox" checked={values.includes(option.value)} className="h-5 w-5 shrink-0 accent-brand-600"
          onChange={(event) => onChange(event.target.checked ? [...values, option.value] : values.filter((value) => value !== option.value))} />
        <span>{option.label}</span>
      </label>)}
    </div>
  </fieldset>;
}

export function DishMetadataFields({ value, onChange, options, error, onRetry }: {
  value: DishMetadataForm;
  onChange: (value: DishMetadataForm) => void;
  options: DishMetadataOptions | null;
  error: string | null;
  onRetry: () => void;
}) {
  if (!options) return <div className="space-y-2">
    <Feedback tone={error ? 'warning' : 'info'}>{error ?? 'Đang tải lựa chọn thông tin món…'}</Feedback>
    {error && <button type="button" onClick={onRetry} className={secondaryButtonClass}>Tải lại lựa chọn</button>}
  </div>;

  const set = <K extends keyof DishMetadataForm>(key: K, next: DishMetadataForm[K]) => onChange({ ...value, [key]: next });
  return <section aria-label="Thông tin chi tiết món ăn" className="space-y-4 border-t border-slate-200 pt-4">
    <label className={labelClass}>Mô tả tiếng Anh
      <textarea rows={3} maxLength={options.limits.descriptionEn} value={value.descriptionEn} onChange={(event) => set('descriptionEn', event.target.value)} className={`${controlClass} mt-1.5 resize-y`} />
    </label>
    <p className="text-sm leading-6 text-slate-600">Chỉ nhập thông tin đã được nhà hàng xác minh. Để trống nếu chưa rõ; chưa chọn chất gây dị ứng không có nghĩa là món an toàn cho người dị ứng.</p>
    <fieldset>
      <legend className={labelClass}>Nguyên liệu</legend>
      <p className="mt-1 text-sm text-slate-600">Mỗi dòng một nguyên liệu, tối đa {options.limits.ingredients} nguyên liệu.</p>
      <div className="mt-2 space-y-2">{value.ingredients.map((ingredient, index) => <div key={index} className="flex items-center gap-2">
        <label className="min-w-0 flex-1"><span className="sr-only">Nguyên liệu {index + 1}</span>
          <input required maxLength={options.limits.ingredientLength} value={ingredient} className={controlClass}
            onChange={(event) => set('ingredients', value.ingredients.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} />
        </label>
        <button type="button" aria-label={`Xóa nguyên liệu ${index + 1}`} onClick={() => set('ingredients', value.ingredients.filter((_, itemIndex) => itemIndex !== index))} className={secondaryButtonClass}><X aria-hidden="true" className="h-4 w-4" /></button>
      </div>)}</div>
      <button type="button" disabled={value.ingredients.length >= options.limits.ingredients} onClick={() => set('ingredients', [...value.ingredients, ''])} className={`${secondaryButtonClass} mt-2`}><Plus aria-hidden="true" className="h-4 w-4" />Thêm nguyên liệu</button>
    </fieldset>
    <MultiSelect label="Chất gây dị ứng đã ghi nhận" options={options.allergens} values={value.allergenTags} onChange={(next) => set('allergenTags', next)} />
    <MultiSelect label="Chế độ ăn" options={options.dietaryTags} values={value.dietaryTags} onChange={(next) => set('dietaryTags', next)} />
    <div className="grid gap-4 sm:grid-cols-2">
      <label className={labelClass}>Độ cay<select value={value.spiceLevel} onChange={(event) => set('spiceLevel', event.target.value)} className={`${controlClass} mt-1.5`}>
        <option value="">Chưa xác định</option>{options.spiceLevels.map((level) => <option key={level.value} value={level.value}>{level.label}</option>)}
      </select></label>
      <label className={labelClass}>Khẩu phần<input value={value.servingSize} maxLength={options.limits.servingSize} placeholder="Ví dụ: 1 tô / 1 người" onChange={(event) => set('servingSize', event.target.value)} className={`${controlClass} mt-1.5`} /></label>
    </div>
    <MultiSelect label="Yêu cầu chế biến có thể phục vụ" options={options.modifiers} values={value.availableModifiers} onChange={(next) => set('availableModifiers', next)} />
    <p className="text-sm text-slate-600">Khả năng bỏ một nguyên liệu không bảo đảm loại bỏ nguy cơ dị ứng hoặc nhiễm chéo. Nhân viên cần xác minh trực tiếp.</p>
  </section>;
}
