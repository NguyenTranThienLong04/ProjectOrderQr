import { PromotionType } from './promotion-type.enum';

export interface PromotionRule {
  type: PromotionType;
  value: number;
  minOrderAmount: number;
}

export function promotionAmounts(
  rule: PromotionRule | undefined,
  subtotalAmount: number,
) {
  const discountAmount =
    !rule || subtotalAmount < rule.minOrderAmount
      ? 0
      : rule.type === PromotionType.PERCENTAGE
        ? Math.round((subtotalAmount * rule.value) / 100)
        : Math.min(rule.value, subtotalAmount);
  return {
    subtotalAmount,
    discountAmount,
    totalAmount: Math.max(0, subtotalAmount - discountAmount),
  };
}
