import {
  candidate,
  evaluationCases,
  evaluationHarness,
  offlineConfig,
} from './harness';

describe('Golden evaluator negative controls (not model scores)', () => {
  it.each([
    [
      'dish-pho',
      {
        nameEn: 'Phở bò tái with peanuts',
        descriptionEn: 'Discover Phở bò tái.',
      },
    ],
    [
      'note-1',
      {
        modifierTags: ['LESS_SPICY'],
        allergyMentioned: false,
        forChildren: false,
        needsStaffReview: false,
      },
    ],
    [
      'search-beef-allergy',
      {
        minPrice: null,
        maxPrice: null,
        categories: [],
        requiredIngredients: ['beef'],
        excludedIngredients: [],
        requiredDietaryTags: [],
        excludedDietaryTags: [],
        excludedAllergens: [],
        minSpiceLevel: null,
        maxSpiceLevel: null,
        keywords: [],
        unsupportedCriteria: [],
      },
    ],
    [
      'analytics-revenue',
      {
        metric: 'orders',
        operation: 'value',
        currentPeriod: { preset: 'selected', from: '', to: '' },
        comparisonPeriod: { preset: 'selected', from: '', to: '' },
        limit: 5,
      },
    ],
    [
      'review-1',
      {
        sentiment: 'positive',
        topics: [{ topic: 'taste', sentiment: 'positive' }],
      },
    ],
  ])('rejects schema-valid semantic regression for %s', async (id, output) => {
    const entry = evaluationCases.find((c) => c.id === id)!;
    const h = evaluationHarness(
      {
        generateStructured: (req) =>
          Promise.resolve(
            req.schemaName.includes('answer') ? candidate(req) : { output },
          ),
      },
      offlineConfig(),
    );
    await expect(entry.run(h)).rejects.toThrow();
  });
  it('rejects invented summary sample size', async () => {
    const entry = evaluationCases.find(
      (c) => c.id === 'review-summary-grounding',
    )!;
    const h = evaluationHarness(
      {
        generateStructured: () =>
          Promise.resolve({
            output: { answer: 'Đã phân tích 999/999 comment.' },
          }),
      },
      offlineConfig(),
    );
    await expect(entry.run(h)).rejects.toThrow();
  });
});
