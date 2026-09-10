export const RECOMMENDATION_POLICY = {
  minBaskets: 20,
  minAnchorCount: 10,
  minPairCount: 5,
  minSupport: 0.01,
  minPopularCount: 5,
  limit: 4,
  historyLimit: 5000,
  historyDays: 90,
  ttlMs: 30000,
} as const;

export interface BasketEvidence {
  sampleSize: number;
  anchorCount: number;
  pairCount: number;
  confidence: number;
  support: number;
  basketCount: number;
}
export interface RankedRecommendation {
  dishId: string;
  reason: 'frequently_bought_together' | 'popular';
  evidence: BasketEvidence;
}

/** Each basket votes once per dish, regardless of quantity or note variants.
 * For multiple anchors, count baskets containing ANY anchor once (union).
 */
export function rankRecommendations(
  baskets: readonly (readonly string[])[],
  cartDishIds: readonly string[],
): RankedRecommendation[] {
  const cart = new Set(cartDishIds);
  const normalized = baskets
    .map((basket) => new Set(basket))
    .filter((b) => b.size);
  const sampleSize = normalized.length;
  if (sampleSize < RECOMMENDATION_POLICY.minBaskets) return [];
  const counts = new Map<string, { basketCount: number; pairCount: number }>();
  let anchorCount = 0;
  for (const basket of normalized) {
    const matches = [...cart].some((id) => basket.has(id));
    if (matches) anchorCount++;
    for (const id of basket) {
      if (cart.has(id)) continue;
      const count = counts.get(id) ?? { basketCount: 0, pairCount: 0 };
      count.basketCount++;
      if (matches) count.pairCount++;
      counts.set(id, count);
    }
  }
  const ranked: RankedRecommendation[] = [];
  for (const [dishId, count] of counts) {
    const support = count.pairCount / sampleSize;
    const paired =
      anchorCount >= RECOMMENDATION_POLICY.minAnchorCount &&
      count.pairCount >= RECOMMENDATION_POLICY.minPairCount &&
      support >= RECOMMENDATION_POLICY.minSupport;
    if (!paired && count.basketCount < RECOMMENDATION_POLICY.minPopularCount)
      continue;
    ranked.push({
      dishId,
      reason: paired ? 'frequently_bought_together' : 'popular',
      evidence: {
        ...count,
        sampleSize,
        anchorCount,
        support,
        confidence: anchorCount ? count.pairCount / anchorCount : 0,
      },
    });
  }
  return ranked.sort(
    (a, b) =>
      Number(b.reason === 'frequently_bought_together') -
        Number(a.reason === 'frequently_bought_together') ||
      (a.reason === 'frequently_bought_together'
        ? b.evidence.confidence - a.evidence.confidence
        : 0) ||
      b.evidence.basketCount - a.evidence.basketCount ||
      (a.dishId < b.dishId ? -1 : a.dishId > b.dishId ? 1 : 0),
  );
}
