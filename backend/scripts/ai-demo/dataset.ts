import { createHash } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Mongoose, Types } from 'mongoose';
import type { Dish } from '../../src/modules/dish/dish.schema';
import type { Category } from '../../src/modules/category/category.schema';
import { CreateDishDto } from '../../src/modules/dish/dto/create-dish.dto';
import { DishSchema } from '../../src/modules/dish/dish.schema';
import { CategorySchema } from '../../src/modules/category/category.schema';
import {
  ANCHOR,
  buildCatalog,
  DATASET_ID,
  DEMO_LABEL,
  fixtureId,
} from './catalog';

export const COLLECTIONS = [
  'categories',
  'dishes',
  'ai_demo_baskets',
  'ai_demo_reviews',
] as const;
export type DemoCollection = (typeof COLLECTIONS)[number];
export type DemoDocument = {
  _id: Types.ObjectId;
  demoDataset: string;
  dataLabel: string;
  [key: string]: unknown;
};
export type DemoDataset = Record<DemoCollection, DemoDocument[]>;
const validationMongoose = new Mongoose();

export function canonical(value: unknown): string {
  if (value instanceof Types.ObjectId)
    return JSON.stringify(value.toHexString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
const mark = <T extends { _id: Types.ObjectId }>(
  value: T,
): T & DemoDocument => ({
  ...value,
  demoDataset: DATASET_ID,
  dataLabel: DEMO_LABEL,
});

export type BasketItem = {
  dishId: Types.ObjectId;
  dishName: string;
  unitPrice: number;
  quantity: number;
};
export type Basket = DemoDocument & {
  items: BasketItem[];
  occurredAt: Date;
  basketValueVnd: number;
};
export type DemoReview = DemoDocument & {
  basketId: Types.ObjectId;
  dishId: Types.ObjectId;
  rating: number;
  comment: string;
  createdAt: Date;
  scenario: string;
};

// Variety is authored, not inferred by an AI classifier. Scenario labels are
// fixture provenance, NOT predictions or statistically validated ground truth.
const FOOD_COMMENTS: [number, string, string][] = [
  [5, 'taste', 'Vị vừa miệng, {dish} thơm và dễ ăn.'],
  [2, 'saltiness', '{dish} hơi mặn so với khẩu vị của mình.'],
  [4, 'saltiness', '{dish} không mặn như mình lo, nêm khá vừa.'],
  [2, 'temperature', '{dish} lúc mang ra nguội hơn mong đợi.'],
  [3, 'portion', 'Phần {dish} hơi ít, ăn một người vẫn muốn gọi thêm.'],
  [5, 'portion', '{dish} phần khá đầy đặn, cả bàn chia nhau ăn vừa.'],
  [4, 'presentation', '{dish} bày gọn gàng, nhìn ngon mắt.'],
  [2, 'service-speed', 'Đợi {dish} hơn 25 phút, mong lần sau nhanh hơn.'],
  [4, 'service-speed', '{dish} ra nhanh dù bàn mình gọi nhiều món.'],
  [2, 'value', 'Với giá này, phần {dish} chưa đáng tiền lắm.'],
  [5, 'value', '{dish} giá hợp lý, mình sẽ gọi lại.'],
  [3, 'mixed', '{dish} ngon nhưng hơi ít, phục vụ thì nhanh.'],
  [3, 'negation', 'Không phải {dish} dở, chỉ là chưa hợp khẩu vị mình.'],
  [4, 'slang', '{dish} ngon nha, lên món hơi lâu xíu :))'],
  [3, 'other', 'Mình gọi {dish} lần đầu, chưa có gì thêm để nhận xét.'],
];
const DRINK_COMMENTS: [number, string, string][] = [
  [5, 'taste', '{dish} thơm, vị cân bằng và dễ uống.'],
  [2, 'taste', '{dish} ngọt quá so với khẩu vị của mình.'],
  [3, 'temperature', '{dish} quá nhiều đá, uống một lúc bị nhạt.'],
  [4, 'temperature', '{dish} mát vừa, không bị buốt răng.'],
  [2, 'portion', 'Ly {dish} hơi nhỏ so với mong đợi.'],
  [4, 'presentation', 'Ly {dish} bày đẹp, sạch sẽ.'],
  [2, 'service-speed', 'Gọi {dish} mà phải chờ lâu hơn món ăn.'],
  [5, 'service-speed', '{dish} mang ra rất nhanh.'],
  [3, 'value', '{dish} uống ổn nhưng giá hơi cao.'],
  [4, 'mixed', '{dish} thơm nhưng đá hơi nhiều, nhân viên dễ thương.'],
];

export function buildDataset(): DemoDataset {
  const { categories, dishes } = buildCatalog();
  let state = 16092026;
  const random = (max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
  // Meal anchors deliberately encode repeatable co-occurrence signals, plus
  // substitutions/noise. No persistent customer identities or production Orders.
  const meals = [
    [0, 15, 35],
    [1, 16, 38],
    [2, 17, 35],
    [5, 20, 36],
    [6, 4, 37],
    [10, 15, 38],
    [13, 19, 35],
    [9, 22, 39],
    [25, 3, 20, 5],
    [26, 27, 20, 6],
    [11, 16, 36],
    [12, 18, 37],
  ];
  const baskets: Basket[] = Array.from({ length: 640 }, (_, index) => {
    const meal = meals[random(meals.length)];
    const chosen = new Set<number>([meal[0], index % dishes.length]);
    for (const item of meal.slice(1)) if (random(100) < 78) chosen.add(item);
    if (random(100) < 35) chosen.add(30 + random(5));
    if (random(100) < 16) chosen.add(random(dishes.length));
    const partySize = 1 + random(5);
    const items = [...chosen].map((dishIndex) => ({
      dishId: dishes[dishIndex]._id,
      dishName: dishes[dishIndex].name,
      unitPrice: dishes[dishIndex].price,
      quantity: 1 + random(Math.min(partySize, 3)),
    }));
    const occurredAt = new Date(
      ANCHOR.getTime() -
        (1 + random(90)) * 86400000 +
        (4 + random(10)) * 3600000 +
        random(60) * 60000,
    );
    return mark({
      _id: fixtureId(`basket:${index}`),
      kind: 'historical-basket-fixture',
      occurredAt,
      partySize,
      mealPeriod: occurredAt.getUTCHours() < 8 ? 'lunch' : 'dinner',
      items,
      basketValueVnd: items.reduce(
        (sum, item) => sum + item.unitPrice * item.quantity,
        0,
      ),
    });
  });
  const reviews: DemoReview[] = Array.from({ length: 240 }, (_, index) => {
    const dish = dishes[index % dishes.length];
    const candidates = baskets.filter((basket) =>
      basket.items.some((item) => item.dishId.equals(dish._id)),
    );
    const basket =
      candidates[Math.floor(index / dishes.length) % candidates.length];
    const drink = dishes.indexOf(dish) >= 35;
    const templates = drink ? DRINK_COMMENTS : FOOD_COMMENTS;
    let [rating, scenario, template] =
      templates[(index + Math.floor(index / 40) * 7) % templates.length];
    if (dish.spiceLevel! >= 2 && index % 3 === 0) {
      [rating, scenario, template] =
        index % 2 === 0
          ? [
              2,
              'spiciness',
              '{dish} cay hơn mình tưởng, lần sau sẽ hỏi nhân viên trước.',
            ]
          : [4, 'spiciness', '{dish} cay rõ nhưng mình thích mức này.'];
    }
    return mark({
      _id: fixtureId(`review:${index}`),
      kind: 'review-comment-fixture',
      basketId: basket._id,
      dishId: dish._id,
      rating,
      comment: template.replace('{dish}', dish.name),
      scenario,
      createdAt: new Date(
        basket.occurredAt.getTime() + (45 + random(90)) * 60000,
      ),
    });
  });
  return {
    categories: categories.map(mark),
    dishes: dishes.map(({ recipeKey, recipeIngredients, ...dish }) => {
      void recipeKey;
      void recipeIngredients;
      return mark(dish);
    }),
    ai_demo_baskets: baskets,
    ai_demo_reviews: reviews,
  };
}

/** Validate through CURRENT production DTO + Mongoose schema before any I/O.
 * Metadata provenance belongs to the fixture wrapper; never add fields to DTOs. */
export async function validateDataset(dataset: DemoDataset): Promise<void> {
  const DishModel = validationMongoose.model<Dish>(
    'AiDemoValidationDish',
    DishSchema,
  );
  const CategoryModel = validationMongoose.model<Category>(
    'AiDemoValidationCategory',
    CategorySchema,
  );
  const fail = (condition: boolean, reason: string) => {
    if (!condition) throw new Error(`Invalid demo dataset: ${reason}`);
  };
  fail(
    dataset.dishes.length >= 30 && dataset.dishes.length <= 50,
    'dish count',
  );
  fail(
    dataset.categories.length >= 6 && dataset.categories.length <= 10,
    'category count',
  );
  fail(dataset.ai_demo_baskets.length >= 500, 'basket count');
  fail(
    dataset.ai_demo_reviews.length >= 150 &&
      dataset.ai_demo_reviews.length <= 300,
    'review count',
  );
  for (const collection of COLLECTIONS) {
    fail(
      new Set(dataset[collection].map((doc) => doc._id.toString())).size ===
        dataset[collection].length,
      `${collection} duplicate IDs`,
    );
    for (const doc of dataset[collection])
      fail(
        doc.demoDataset === DATASET_ID && doc.dataLabel === DEMO_LABEL,
        'missing provenance',
      );
  }
  for (const category of dataset.categories)
    await new CategoryModel(category).validate();
  for (const dish of dataset.dishes) {
    const { _id, demoDataset, dataLabel, ...payload } = dish;
    const errors = await validate(
      plainToInstance(CreateDishDto, {
        ...payload,
        categoryId: String(payload.categoryId),
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    fail(errors.length === 0, `Dish DTO ${String(dish.name)}`);
    await new DishModel(dish).validate();
    fail(
      dataset.categories.some((category) =>
        category._id.equals(dish.categoryId as Types.ObjectId),
      ),
      'category reference',
    );
    fail(
      ['name', 'nameEn', 'description', 'descriptionEn', 'servingSize'].every(
        (key) => typeof dish[key] === 'string' && dish[key].length > 0,
      ),
      'bilingual metadata',
    );
    fail(
      Array.isArray(dish.ingredients) &&
        dish.ingredients.length > 0 &&
        Number.isInteger(dish.spiceLevel),
      'recipe metadata',
    );
    void _id;
    void demoDataset;
    void dataLabel;
  }
  const baskets = dataset.ai_demo_baskets as Basket[];
  for (const basket of baskets) {
    fail(
      basket.items.length >= 2 &&
        new Set(basket.items.map((item) => String(item.dishId))).size ===
          basket.items.length,
      'basket items',
    );
    for (const item of basket.items) {
      const dish = dataset.dishes.find((entry) =>
        entry._id.equals(item.dishId),
      );
      fail(
        !!dish && dish.name === item.dishName && dish.price === item.unitPrice,
        'snapshot reference',
      );
      fail(
        Number.isInteger(item.quantity) &&
          item.quantity >= 1 &&
          item.quantity <= 3,
        'quantity',
      );
    }
    fail(
      basket.basketValueVnd ===
        basket.items.reduce(
          (sum, item) => sum + item.unitPrice * item.quantity,
          0,
        ),
      'basket arithmetic',
    );
    fail(basket.occurredAt < ANCHOR, 'historical date');
  }
  const pairs = new Set<string>();
  for (const review of dataset.ai_demo_reviews as DemoReview[]) {
    const basket = baskets.find((entry) => entry._id.equals(review.basketId));
    fail(
      !!basket?.items.some((item) => item.dishId.equals(review.dishId)),
      'review source',
    );
    fail(
      review.createdAt > basket!.occurredAt && review.createdAt < ANCHOR,
      'review chronology',
    );
    fail(
      Number.isInteger(review.rating) &&
        review.rating >= 1 &&
        review.rating <= 5 &&
        review.comment.length > 0 &&
        review.comment.length <= 500,
      'review content',
    );
    const key = `${review.basketId.toString()}:${review.dishId.toString()}`;
    fail(!pairs.has(key), 'duplicate basket/dish review');
    pairs.add(key);
  }
}
