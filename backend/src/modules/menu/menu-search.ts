import { Dish } from '../dish/dish.schema';

/** Search constraints refer only to existing catalog fields. */
export interface MenuSearchFilters {
  minPrice?: number;
  maxPrice?: number;
  categories?: string[];
  requiredIngredients?: string[];
  excludedIngredients?: string[];
  requiredDietaryTags?: string[];
  excludedDietaryTags?: string[];
  excludedAllergens?: string[];
  minSpiceLevel?: number;
  maxSpiceLevel?: number;
  keywords?: string[];
}

export const normalizeSearchText = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Language equivalences only; never derive ingredients from dish names or prose.
const ingredientAliases: string[][] = [
  ['beef', 'bò', 'thịt bò'],
  ['chicken', 'gà', 'thịt gà'],
  ['pork', 'heo', 'lợn', 'thịt heo', 'thịt lợn'],
  [
    'peanut',
    'peanuts',
    'đậu phộng',
    'lạc',
    'roasted peanuts',
    'đậu phộng rang',
  ],
  [
    'onion',
    'onions',
    'hành',
    'hành lá',
    'hành tây',
    'hành tím',
    'hành phi',
    'spring onion',
    'shallot',
    'fried shallot',
  ],
  ['egg', 'eggs', 'trứng', 'trứng gà'],
  ['milk', 'sữa', 'sữa đặc', 'condensed milk'],
  ['tofu', 'đậu hũ', 'đậu phụ'],
  ['shrimp', 'prawn', 'tôm'],
  ['chili', 'chilli', 'ớt', 'ớt tươi', 'fresh chili'],
  ['pepper', 'tiêu', 'tiêu đen', 'black pepper'],
].map((group) => [
  ...new Set(group.flatMap((term) => [term, normalizeSearchText(term)])),
]);
// Keep recorded Vietnamese accents: bơ (butter) must not become bò (beef).
const ingredientText = (text: string) =>
  text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export function ingredientMatches(
  recorded: string,
  requested: string,
): boolean {
  const values = recorded.split(/[/;,]/).map(ingredientText);
  const term = ingredientText(requested);
  if (!term) return false;
  const aliases = ingredientAliases.find((group) => group.includes(term)) ?? [
    term,
  ];
  return aliases.some((alias) => values.includes(alias));
}

export function matchesMenuFilters(
  dish: Dish,
  categoryNames: string[],
  filters: MenuSearchFilters,
): boolean {
  if (!dish.isAvailable) return false;
  if (filters.minPrice !== undefined && dish.price < filters.minPrice)
    return false;
  if (filters.maxPrice !== undefined && dish.price > filters.maxPrice)
    return false;
  if (
    filters.categories?.length &&
    !filters.categories.some((name) =>
      categoryNames.some(
        (label) => normalizeSearchText(label) === normalizeSearchText(name),
      ),
    )
  )
    return false;
  const ingredients = dish.ingredients ?? [];
  if (
    filters.requiredIngredients?.some(
      (term) => !ingredients.some((value) => ingredientMatches(value, term)),
    )
  )
    return false;
  // Missing ingredients cannot establish an exclusion, even in otherwise new dishes.
  if (
    filters.excludedIngredients?.length &&
    (!ingredients.length ||
      filters.excludedIngredients.some((term) =>
        ingredients.some((value) => ingredientMatches(value, term)),
      ))
  )
    return false;
  if (
    filters.excludedAllergens?.some((tag) => dish.allergenTags?.includes(tag))
  )
    return false;
  if (
    filters.requiredDietaryTags?.some((tag) => !dish.dietaryTags?.includes(tag))
  )
    return false;
  if (
    filters.excludedDietaryTags?.length &&
    (!dish.dietaryTags?.length ||
      filters.excludedDietaryTags.some((tag) => dish.dietaryTags.includes(tag)))
  )
    return false;
  if (
    filters.minSpiceLevel !== undefined &&
    (dish.spiceLevel == null || dish.spiceLevel < filters.minSpiceLevel)
  )
    return false;
  if (
    filters.maxSpiceLevel !== undefined &&
    (dish.spiceLevel == null || dish.spiceLevel > filters.maxSpiceLevel)
  )
    return false;
  return true;
}

export function menuSearchScore(
  dish: Pick<Dish, 'name' | 'nameEn' | 'description' | 'descriptionEn'>,
  keywords: string[],
): number {
  const names = [dish.name, dish.nameEn ?? ''].map(normalizeSearchText);
  const descriptions = [dish.description ?? '', dish.descriptionEn ?? ''].map(
    normalizeSearchText,
  );
  return keywords.reduce((score, word) => {
    const term = normalizeSearchText(word);
    if (!term) return score;
    return (
      score +
      (names.includes(term)
        ? 100
        : names.some((name) => name.includes(term))
          ? 20
          : descriptions.some((description) => description.includes(term))
            ? 5
            : 0)
    );
  }, 0);
}

export function searchWarnings(lang: 'vi' | 'en') {
  return lang === 'en'
    ? {
        allergy:
          'Allergy conditions cannot be fully verified from current data. Listed allergens are excluded; ask staff to verify ingredients and cross-contact.',
        metadata:
          'Some dishes lack the metadata needed to verify these filters and have been omitted.',
        unsupported:
          'Current menu data cannot verify the requested health, nutrition or other unsupported condition. That condition has not been applied.',
        fallback:
          'AI search is unavailable or could not interpret this query. Showing normal name search; requested conditions have not been verified.',
      }
    : {
        allergy:
          'Không thể xác minh đầy đủ điều kiện dị ứng từ dữ liệu hiện có. Đã loại món có nhãn dị ứng được yêu cầu; hãy nhờ nhân viên kiểm tra thành phần và nguy cơ tiếp xúc chéo.',
        metadata:
          'Một số món thiếu metadata để xác minh bộ lọc và đã được bỏ qua.',
        unsupported:
          'Dữ liệu menu hiện không đủ để xác minh điều kiện sức khỏe, dinh dưỡng hoặc điều kiện chưa hỗ trợ. Điều kiện đó chưa được áp dụng.',
        fallback:
          'AI chưa khả dụng hoặc chưa hiểu được câu tìm kiếm. Đang tìm theo tên như bình thường; các điều kiện yêu cầu chưa được xác minh.',
      };
}
