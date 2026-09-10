import { DISH_METADATA_OPTIONS } from '../../dish/dish-metadata';
import type { OrderNoteClassification } from './order-note.dto';

const fold = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/g, 'd');
const allergens: Record<string, RegExp> = {
  peanut: /dau phong|lac\b|peanut/,
  'tree-nut': /hat cay|hat dieu|oc cho|hanh nhan|tree nut/,
  shellfish: /hai san|tom|cua|so\b|oc\b|shellfish/,
  fish: /hai san|\bca\b|fish/,
  egg: /trung|egg/,
  milk: /sua|milk|dairy/,
  soy: /dau nanh|dau tuong|soy/,
  gluten: /gluten|lua mi|wheat/,
  sesame: /\bme\b|vung|sesame/,
};
export function safeOrderNoteResult(
  note: string,
  classified: OrderNoteClassification,
  available: readonly string[],
  storedAllergens?: readonly string[],
) {
  const text = fold(note);
  const allergyMentioned =
    classified.allergyMentioned ||
    /di ung|allerg|khong an (duoc|dc)|khong dung nap|intoleran/.test(text);
  // Conservative vetoes for common contradictory/negated Vietnamese requests.
  // This is not a general language parser: unresolved meaning stays in original note.
  const ambiguousSpice =
    /khong (?:phai|can|muon) (?:khong|it) cay|(?:khong|dung) cay.*(?:nhung|ma).*them cay/.test(
      text,
    );
  const noSpiceRequest = /\b(?:khong|dung) cay\b/.test(text);
  const ambiguousOnion = /khong hanh.*hanh phi|them hanh/.test(text);
  // Preserve understood requests separately from the dish's capability allowlist.
  // Apply semantic vetoes first so summaries never repeat rejected interpretations.
  const requestedTags = classified.modifierTags.filter(
    (tag) =>
      DISH_METADATA_OPTIONS.modifiers.some(({ value }) => value === tag) &&
      !(
        ambiguousSpice && ['NO_SPICE', 'LESS_SPICY', 'NO_CHILI'].includes(tag)
      ) &&
      !(noSpiceRequest && (tag === 'LESS_SPICY' || tag === 'NO_CHILI')) &&
      !(ambiguousOnion && tag === 'NO_ONION'),
  );
  const modifierTags = requestedTags.filter((tag) => available.includes(tag));
  const warnings: string[] = [];
  for (const { value, label } of DISH_METADATA_OPTIONS.modifiers.filter(
    ({ value }) => requestedTags.includes(value) && !available.includes(value),
  ))
    warnings.push(
      `Món chưa có modifier tương ứng cho yêu cầu “${label}” (${value}); dữ liệu hiện chưa hỗ trợ tùy chỉnh này. Nhân viên cần xác minh khả năng đáp ứng.`,
    );
  if (classified.needsStaffReview || ambiguousSpice || ambiguousOnion)
    warnings.push(
      'Yêu cầu có chi tiết cần nhân viên xác minh theo ghi chú gốc.',
    );
  if (allergyMentioned) {
    warnings.push(
      'Khách có đề cập dị ứng hoặc không dung nạp thực phẩm. Nhân viên cần xác minh trực tiếp.',
    );
    const conflicts = DISH_METADATA_OPTIONS.allergens.filter(
      ({ value }) =>
        storedAllergens?.includes(value) && allergens[value].test(text),
    );
    for (const conflict of conflicts)
      warnings.push(
        `Dữ liệu món hiện ghi nhận allergen ${conflict.label.toLowerCase()}. Vui lòng không dựa vào AI và cần xác minh với nhân viên.`,
      );
    warnings.push('Không thể xác minh an toàn dị ứng từ dữ liệu hiện có.');
  }
  const meanings: string[] = DISH_METADATA_OPTIONS.modifiers
    .filter(({ value }) => requestedTags.includes(value))
    .map(({ label }) => label);
  if (classified.forChildren) meanings.push('dành cho trẻ em');
  const summary = meanings.join('; ') || 'Nhân viên vui lòng xem ghi chú gốc.';
  return { result: { summary, modifierTags, allergyMentioned }, warnings };
}
