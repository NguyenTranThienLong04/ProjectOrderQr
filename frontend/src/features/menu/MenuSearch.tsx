import { LoaderCircle, Search } from 'lucide-react';
import type { MenuSearchFilters } from '../../services/api/ai';
import type { useMenuSearch } from './use-menu-search';
import { controlClass, secondaryButtonClass } from '../../components/ui';


function filterLabels(filters: MenuSearchFilters, lang: 'vi' | 'en') {
  const vi = lang === 'vi';
  const labels: string[] = [];
  const money = (value: number) => new Intl.NumberFormat(vi ? 'vi-VN' : 'en-US', { style: 'currency', currency: 'VND' }).format(value);
  if (filters.minPrice !== undefined) labels.push(`≥ ${money(filters.minPrice)}`);
  if (filters.maxPrice !== undefined) labels.push(`≤ ${money(filters.maxPrice)}`);
  if (filters.minSpiceLevel !== undefined) labels.push(`${vi ? 'Độ cay' : 'Spice'} ≥ ${filters.minSpiceLevel}`);
  if (filters.maxSpiceLevel !== undefined) labels.push(filters.maxSpiceLevel === 0 ? (vi ? 'Không cay' : 'Not spicy') : `${vi ? 'Độ cay' : 'Spice'} ≤ ${filters.maxSpiceLevel}`);
  const groups: [string[] | undefined, string][] = [
    [filters.categories, vi ? 'Danh mục' : 'Category'],
    [filters.requiredIngredients, vi ? 'Có thành phần' : 'Ingredients include'],
    [filters.excludedIngredients, vi ? 'Loại thành phần' : 'Ingredients exclude'],
    [filters.requiredDietaryTags, vi ? 'Nhãn món' : 'Dietary tags'],
    [filters.excludedDietaryTags, vi ? 'Loại nhãn' : 'Excluded tags'],
    [filters.excludedAllergens, vi ? 'Loại nhãn dị ứng' : 'Excluded allergen tags'],
    [filters.keywords, vi ? 'Từ khóa' : 'Keywords'],
  ];
  for (const [values, label] of groups) if (values?.length) labels.push(`${label}: ${values.join(', ')}`);
  return labels;
}

export function MenuSearch({ search, lang, onSubmit }: { search: ReturnType<typeof useMenuSearch>; lang: 'vi' | 'en'; onSubmit: () => void }) {
  const vi = lang === 'vi';
  const labels = filterLabels(search.response?.result.appliedFilters ?? {}, lang);
  return <div className="mt-4 space-y-3">
    <form role="search" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <label htmlFor="menu-search" className="mb-1.5 block text-sm font-semibold text-stone-700">{vi ? 'Tìm món ăn' : 'Find dishes'}</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1"><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500" /><input id="menu-search" value={search.query} maxLength={500} onChange={(event) => search.reset(event.target.value)} aria-describedby="menu-search-hint" placeholder={vi ? 'Ví dụ: món chay dưới 80k, không cay' : 'E.g. vegetarian dishes under 80k, not spicy'} className={`${controlClass} border-stone-300 pl-10`} /></div>
        <button type="submit" disabled={search.loading || !search.query.trim()} className={secondaryButtonClass}>{search.loading && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />}{search.loading ? (vi ? 'Đang tìm…' : 'Searching…') : (vi ? 'Tìm bằng AI' : 'Search with AI')}</button>
        {(search.query || search.response) && <button type="button" onClick={() => search.reset()} className={secondaryButtonClass}>{vi ? 'Xóa tìm kiếm' : 'Clear search'}</button>}
      </div>
      <p id="menu-search-hint" className="mt-2 text-sm text-stone-600">{vi ? 'Gõ để tìm theo tên. Bấm Tìm bằng AI hoặc Enter để tìm theo yêu cầu (tối đa 500 ký tự).' : 'Type to search names. Use Search with AI or Enter to search by conditions (up to 500 characters).'}</p>
    </form>
    <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2">
      {search.loading && <p className="text-sm text-stone-700">{vi ? 'Đang tìm món theo yêu cầu… Giỏ hàng vẫn sử dụng được.' : 'Searching your conditions… Your cart is still available.'}</p>}
      {search.response?.fallbackUsed && <p className="text-sm font-semibold text-stone-700">{vi ? 'Đang dùng tìm kiếm thường' : 'Using normal search'}</p>}
      {labels.length > 0 && <div><p className="text-sm font-semibold text-stone-700">{vi ? 'Đang áp dụng' : 'Applied filters'}</p><ul className="mt-2 flex flex-wrap gap-2">{labels.map((label) => <li key={label} className="max-w-full break-words rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-700">{label}</li>)}</ul></div>}
      {search.response?.warnings.map((warning) => <p key={warning} className="break-words rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950">{warning === 'AI_AUDIT_UNAVAILABLE' ? (vi ? 'Chưa ghi nhận được nhật ký AI cho lượt tìm này.' : 'The AI audit log is unavailable for this search.') : warning}</p>)}
    </div>
  </div>;
}
