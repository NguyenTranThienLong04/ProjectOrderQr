/** Backend-owned vocabulary. Adding a value requires an explicit catalog decision. */
export const DISH_METADATA_OPTIONS = {
  allergens: [
    { value: 'peanut', label: 'Đậu phộng' },
    { value: 'tree-nut', label: 'Hạt cây' },
    { value: 'shellfish', label: 'Giáp xác / nhuyễn thể' },
    { value: 'fish', label: 'Cá' },
    { value: 'egg', label: 'Trứng' },
    { value: 'milk', label: 'Sữa' },
    { value: 'soy', label: 'Đậu nành' },
    { value: 'gluten', label: 'Ngũ cốc chứa gluten' },
    { value: 'sesame', label: 'Mè / vừng' },
  ],
  dietaryTags: [
    { value: 'vegetarian', label: 'Chay' },
    { value: 'vegan', label: 'Thuần chay' },
    { value: 'lacto-ovo-vegetarian', label: 'Chay có trứng / sữa' },
    { value: 'contains-meat', label: 'Có thịt / cá / hải sản' },
  ],
  modifiers: [
    { value: 'NO_ONION', label: 'Không hành' },
    { value: 'LESS_SPICY', label: 'Ít cay' },
    { value: 'NO_SPICE', label: 'Không cay' },
    { value: 'NO_CHILI', label: 'Không ớt' },
    { value: 'NO_PEPPER', label: 'Không tiêu' },
    { value: 'NO_PEANUT', label: 'Không thêm đậu phộng' },
    { value: 'EXTRA_NOODLES', label: 'Thêm bánh / bún / mì' },
    { value: 'NO_ICE', label: 'Không đá' },
    { value: 'LESS_ICE', label: 'Ít đá' },
    { value: 'LESS_SUGAR', label: 'Ít đường' },
    { value: 'NO_SUGAR', label: 'Không đường' },
  ],
  spiceLevels: [
    { value: 0, label: '0 — Không cay' },
    { value: 1, label: '1 — Nhẹ' },
    { value: 2, label: '2 — Vừa' },
    { value: 3, label: '3 — Cay' },
    { value: 4, label: '4 — Rất cay' },
    { value: 5, label: '5 — Cực cay' },
  ],
  limits: {
    ingredients: 40,
    ingredientLength: 80,
    descriptionEn: 2000,
    servingSize: 100,
  },
} as const;

export const ALLERGEN_TAGS = DISH_METADATA_OPTIONS.allergens.map(
  ({ value }) => value,
);
export const DIETARY_TAGS = DISH_METADATA_OPTIONS.dietaryTags.map(
  ({ value }) => value,
);
export const DISH_MODIFIERS = DISH_METADATA_OPTIONS.modifiers.map(
  ({ value }) => value,
);

export function consistentDietaryTags(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    !(value.includes('contains-meat') && value.length > 1)
  );
}

/** Multer fields are strings; JSON requests already contain arrays. Invalid input
 * is retained for DTO validation, never coerced into a valid/empty array. */
export function parseMetadataArray(value: unknown): unknown {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return Array.isArray(parsed)
    ? parsed.map((item: unknown) => trimMetadata(item))
    : parsed;
}

export function trimMetadata(value: unknown): unknown {
  return typeof value === 'string' ? value.normalize('NFC').trim() : value;
}

export function parseSpiceLevel(value: unknown): unknown {
  if (value === '') return null; // Explicit clear; omitted fields remain unchanged.
  return typeof value === 'string' && /^[0-5]$/.test(value)
    ? Number(value)
    : value;
}
