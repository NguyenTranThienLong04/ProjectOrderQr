import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalog, DATASET_ID, INGREDIENTS } from './catalog';
import {
  buildDataset,
  COLLECTIONS,
  fingerprint,
  validateDataset,
} from './dataset';
import type { Basket, DemoReview } from './dataset';
import { requireDemoConfig, runDemo } from './store';

describe('Phase 16 deterministic synthetic dataset', () => {
  const dataset = buildDataset();
  it('passes current Dish DTO/Mongoose contract and fixture references/arithmetic', async () => {
    await expect(validateDataset(dataset)).resolves.toBeUndefined();
    expect(dataset.categories).toHaveLength(8);
    expect(dataset.dishes).toHaveLength(40);
    expect(dataset.ai_demo_baskets).toHaveLength(640);
    expect(dataset.ai_demo_reviews).toHaveLength(240);
    expect(fingerprint(buildDataset())).toBe(fingerprint(dataset));
  });

  it('covers taxonomy, consistent recipes and meaningful availability/modifiers', () => {
    const { dishes } = buildCatalog();
    const allergens = new Set<string>();
    for (const dish of dishes) {
      const ingredients = dish.recipeIngredients.map((key) => INGREDIENTS[key]);
      expect(dish.allergenTags).toEqual(
        [...new Set(ingredients.flatMap((item) => item.allergens))].sort(),
      );
      for (const tag of dish.allergenTags) allergens.add(tag);
      if (dish.dietaryTags.includes('vegan')) {
        expect(ingredients.some((item) => item.animal)).toBe(false);
        expect(
          dish.allergenTags.some((tag) =>
            ['fish', 'shellfish', 'egg', 'milk'].includes(tag),
          ),
        ).toBe(false);
      }
      if (dish.spiceLevel! > 0)
        expect(
          dish.recipeIngredients.some((key) =>
            ['chili', 'pepper'].includes(key),
          ),
        ).toBe(true);
      const modifierIngredient = {
        NO_ONION: 'onion',
        NO_CHILI: 'chili',
        NO_PEPPER: 'pepper',
        NO_PEANUT: 'peanut',
        NO_ICE: 'ice',
        LESS_ICE: 'ice',
        LESS_SUGAR: 'sugar',
        NO_SUGAR: 'sugar',
      };
      for (const modifier of dish.availableModifiers) {
        if (modifier in modifierIngredient)
          expect(dish.recipeIngredients).toContain(
            modifierIngredient[modifier as keyof typeof modifierIngredient],
          );
      }
    }
    expect(allergens.size).toBe(9);
    expect(new Set(dishes.map((dish) => dish.spiceLevel)).size).toBe(6);
    expect(dishes.filter((dish) => !dish.isAvailable)).toHaveLength(3);
    expect(
      dishes.find((dish) => dish.recipeKey === 'ca-phe-sua')!
        .availableModifiers,
    ).not.toContain('NO_SUGAR');
    expect(
      dishes.find((dish) => dish.recipeKey === 'goi-cuon')!.availableModifiers,
    ).not.toContain('NO_PEANUT');
  });

  it('has varied, dated baskets and repeatable co-occurrence without fake orders/payments', () => {
    const baskets = dataset.ai_demo_baskets as Basket[];
    const patterns = new Set(
      baskets.map((basket) =>
        basket.items
          .map((item) => String(item.dishId))
          .sort()
          .join(','),
      ),
    );
    expect(patterns.size).toBeGreaterThan(200);
    expect(
      new Set(
        baskets.map((basket) => basket.occurredAt.toISOString().slice(0, 10)),
      ).size,
    ).toBeGreaterThan(60);
    for (const dish of dataset.dishes)
      expect(
        baskets.filter((basket) =>
          basket.items.some((item) => item.dishId.equals(dish._id)),
        ).length,
      ).toBeGreaterThanOrEqual(16);
    const { dishes } = buildCatalog();
    const pho = dishes.find((dish) => dish.recipeKey === 'pho-bo')!;
    const rolls = dishes.find((dish) => dish.recipeKey === 'goi-cuon')!;
    const support = baskets.filter((basket) =>
      [pho._id, rolls._id].every((id) =>
        basket.items.some((item) => item.dishId.equals(id)),
      ),
    ).length;
    expect(support).toBeGreaterThan(15);
    expect(Object.keys(dataset)).toEqual([...COLLECTIONS]);
    for (const docs of Object.values(dataset))
      for (const doc of docs) {
        expect(doc.demoDataset).toBe(DATASET_ID);
        for (const key of [
          'status',
          'paidAt',
          'txnRef',
          'orderId',
          'sessionId',
          'tableId',
          'paymentIntentId',
        ])
          expect(doc).not.toHaveProperty(key);
      }
  });

  it('provides varied review sources, mixed/negative/positive/VI slang and small samples', () => {
    const reviews = dataset.ai_demo_reviews as DemoReview[];
    expect(
      new Set(reviews.map((review) => review.comment)).size,
    ).toBeGreaterThan(180);
    expect(new Set(reviews.map((review) => review.scenario))).toEqual(
      new Set([
        'taste',
        'saltiness',
        'temperature',
        'portion',
        'presentation',
        'service-speed',
        'value',
        'mixed',
        'negation',
        'slang',
        'other',
        'spiciness',
      ]),
    );
    expect(reviews.some((review) => review.rating <= 2)).toBe(true);
    expect(reviews.some((review) => review.rating === 5)).toBe(true);
    expect(reviews.some((review) => review.rating === 3)).toBe(true);
    for (const dish of dataset.dishes)
      expect(
        reviews.filter((review) => review.dishId.equals(dish._id)),
      ).toHaveLength(6);
  });

  it.each(['metadata', 'price', 'reference', 'provenance', 'review-source'])(
    'rejects corrupt %s before DB access',
    async (kind) => {
      const invalid = buildDataset();
      if (kind === 'metadata') invalid.dishes[0].allergenTags = ['invented'];
      if (kind === 'price') invalid.dishes[0].price = -1;
      if (kind === 'reference')
        (invalid.ai_demo_baskets as Basket[])[0].items[0].unitPrice = 1;
      if (kind === 'provenance') invalid.dishes[0].demoDataset = 'real';
      if (kind === 'review-source')
        (invalid.ai_demo_reviews as DemoReview[])[0].basketId =
          invalid.dishes[0]._id;
      await expect(validateDataset(invalid)).rejects.toThrow();
    },
  );

  it('has no import or command from backend startup', () => {
    for (const file of ['src/main.ts', 'src/app.module.ts'])
      expect(readFileSync(join(__dirname, '../..', file), 'utf8')).not.toMatch(
        /ai-demo|seed-ai-demo/,
      );
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    for (const [key, command] of Object.entries(pkg.scripts))
      if (/^(pre|post)?start/.test(key)) expect(command).not.toMatch(/ai-demo/);
  });
});

describe('Phase 16 environment guard (before network)', () => {
  const env = {
    NODE_ENV: 'development',
    AI_DEMO_ALLOW_WRITE: 'I_UNDERSTAND_SYNTHETIC_DATA',
    AI_DEMO_DB_NAME: 'smartorder_ai_demo',
    AI_DEMO_MONGODB_URI: 'mongodb://localhost:27017/smartorder_ai_demo',
  };
  it.each(['production', 'Production', 'staging', '', undefined])(
    'blocks NODE_ENV %s for seed and reset',
    async (NODE_ENV) => {
      for (const action of ['seed', 'reset'] as const)
        await expect(runDemo(action, { ...env, NODE_ENV })).rejects.toThrow(
          'explicit NODE_ENV',
        );
    },
  );
  it.each([
    { AI_DEMO_ALLOW_WRITE: undefined },
    { AI_DEMO_DB_NAME: 'OrderFood' },
    { AI_DEMO_MONGODB_URI: 'mongodb://localhost:27017/OrderFood' },
    { AI_DEMO_MONGODB_URI: 'mongodb://localhost:27017/' },
    { AI_DEMO_MONGODB_URI: undefined, MONGODB_URI: env.AI_DEMO_MONGODB_URI },
    {
      AI_DEMO_MONGODB_URI:
        'mongodb://localhost:27017/smartorder_ai_demo%2fOrderFood',
    },
  ])('fails closed for missing opt-in/unsafe database %#', (change) => {
    expect(() => requireDemoConfig({ ...env, ...change })).toThrow();
  });
  it('accepts only explicit development/test dedicated database config', () => {
    expect(requireDemoConfig(env).database).toBe('smartorder_ai_demo');
    expect(
      requireDemoConfig({
        ...env,
        NODE_ENV: 'test',
        AI_DEMO_DB_NAME: 'smartorder_ai_demo_test_abc',
        AI_DEMO_MONGODB_URI:
          'mongodb+srv://example.invalid/smartorder_ai_demo_test_abc?retryWrites=true',
      }).database,
    ).toBe('smartorder_ai_demo_test_abc');
  });
  it('requires an explicit stopped-application acknowledgement for reset', async () => {
    await expect(runDemo('reset', env)).rejects.toThrow(
      'AI_DEMO_APP_STOPPED=yes',
    );
  });
});
