import 'dotenv/config';
import { setServers } from 'node:dns';
import { createConnection, Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import { buildDataset, fingerprint } from '../scripts/ai-demo/dataset';
import { DATASET_ID } from '../scripts/ai-demo/catalog';
import { runDemo } from '../scripts/ai-demo/store';
import {
  Category,
  CategorySchema,
} from '../src/modules/category/category.schema';
import { Dish, DishSchema } from '../src/modules/dish/dish.schema';
import { Table, TableSchema } from '../src/modules/table/table.schema';
import { Order, OrderSchema } from '../src/modules/order/order.schema';
import { Review, ReviewSchema } from '../src/modules/review/review.schema';
import { Session, SessionSchema } from '../src/modules/session/session.schema';
import { MenuService } from '../src/modules/menu/menu.service';
import { AdminService } from '../src/modules/admin/admin.service';

jest.setTimeout(90000);

/** Real MongoDB in a unique dedicated database; never boots AppModule. All
 * created records are removed by exact IDs. No Paid, IPN, payment or live Review
 * fixtures. Existing analytics and legacy menu are compared before/after. */
describe('Phase 16 seed/reset + real MongoDB menu/analytics regression', () => {
  let connection: Connection;
  let env: NodeJS.ProcessEnv;
  let categories: Model<Category>;
  let dishes: Model<Dish>;
  let tables: Model<Table>;
  let orders: Model<Order>;
  let sessions: Model<Session>;
  let menu: MenuService;
  let admin: AdminService;
  const dataset = buildDataset();
  const ids = {
    category: new Types.ObjectId(),
    dish: new Types.ObjectId(),
    table: new Types.ObjectId(),
    order: new Types.ObjectId(),
    session: new Types.ObjectId(),
    collision: dataset.dishes[0]._id,
    foreignDish: new Types.ObjectId(),
  };
  let baseline: string;
  let baselineAnalytics: string;
  const analytics = async () =>
    fingerprint(
      await Promise.all([
        admin.getRevenue(),
        admin.getTopDishes(),
        admin.getTopRatedDishes(),
        admin.getOverview(),
      ]),
    );
  const protectedData = async () =>
    fingerprint(
      await Promise.all([
        categories.findById(ids.category).lean(),
        dishes.findById(ids.dish).lean(),
        tables.findById(ids.table).lean(),
        orders.findById(ids.order).lean(),
        sessions.findById(ids.session).lean(),
      ]),
    );

  beforeAll(async () => {
    if (process.env.NODE_ENV === 'production')
      throw new Error('Forbidden in production');
    const base = process.env.AI_DEMO_TEST_MONGODB_URI;
    if (!base)
      throw new Error(
        'Explicit AI_DEMO_TEST_MONGODB_URI is required (host used only with unique demo DB override).',
      );
    const dbName = `smartorder_ai_demo_test_${Date.now().toString(36)}`;
    const uri = base.replace(
      /^(mongodb(?:\+srv)?:\/\/[^/]+)\/[^?]*(\?.*)?$/,
      `$1/${dbName}$2`,
    );
    env = {
      NODE_ENV: 'test',
      AI_DEMO_ALLOW_WRITE: 'I_UNDERSTAND_SYNTHETIC_DATA',
      AI_DEMO_APP_STOPPED: 'yes',
      AI_DEMO_DB_NAME: dbName,
      AI_DEMO_MONGODB_URI: uri,
    };
    if (process.env.CUSTOM_DNS_SERVERS)
      setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
    connection = await createConnection(uri, {
      dbName,
      serverSelectionTimeoutMS: 15000,
    }).asPromise();
    categories = connection.model(Category.name, CategorySchema);
    dishes = connection.model(Dish.name, DishSchema);
    tables = connection.model(Table.name, TableSchema);
    orders = connection.model(Order.name, OrderSchema);
    sessions = connection.model(Session.name, SessionSchema);
    const reviews = connection.model(Review.name, ReviewSchema);
    menu = new MenuService(tables, categories, dishes);
    admin = new AdminService(orders, tables, dishes, reviews);
    await Promise.all([
      categories.init(),
      dishes.init(),
      tables.init(),
      orders.init(),
      sessions.init(),
      reviews.init(),
    ]);
    await categories.create({
      _id: ids.category,
      name: 'Existing test category',
    });
    await dishes.collection.insertOne({
      _id: ids.dish,
      categoryId: ids.category,
      name: 'Món cũ',
      price: 40000,
      description: 'Mô tả cũ',
      isAvailable: true,
    });
    await tables.create({
      _id: ids.table,
      tableCode: `P16_${ids.table.toString()}`,
      qrCodeUrl: 'data:image/png;base64,test',
    });
    await sessions.create({ _id: ids.session, tableId: ids.table });
    // Initial Pending with schema defaults; never a fake paid history.
    await orders.create({
      _id: ids.order,
      tableId: ids.table,
      sessionId: ids.session,
      items: [
        { dishId: ids.dish, dishName: 'Món cũ', unitPrice: 40000, quantity: 1 },
      ],
      subtotalAmount: 40000,
      totalAmount: 40000,
    });
    baseline = await protectedData();
    baselineAnalytics = await analytics();
  });

  afterAll(async () => {
    if (!connection?.db) return;
    try {
      // Cleanup only harness-owned IDs even if a refusal test failed mid-step.
      await orders.deleteOne({ _id: ids.order });
      await sessions.deleteOne({ _id: ids.session });
      await dishes.deleteMany({ _id: { $in: [ids.dish, ids.foreignDish] } });
      const demoDish = await connection.db
        .collection('dishes')
        .findOne({ _id: ids.collision });
      if (demoDish && demoDish.demoDataset !== DATASET_ID)
        await connection.db
          .collection('dishes')
          .deleteOne({ _id: ids.collision });
      if (demoDish?.demoDataset === DATASET_ID)
        await connection.db
          .collection('dishes')
          .replaceOne({ _id: ids.collision }, dataset.dishes[0]);
      await runDemo('reset', env);
      await categories.deleteOne({ _id: ids.category });
      await tables.deleteOne({ _id: ids.table });
      await connection.db
        .collection('ai_demo_control')
        .deleteOne({ _id: DATASET_ID });
      const names = await connection.db.listCollections().toArray();
      for (const { name } of names)
        expect(await connection.db.collection(name).countDocuments()).toBe(0);
    } finally {
      await connection.close();
    }
  });

  it('seeds atomically, preserves legacy/core records and leaves analytics unchanged', async () => {
    expect(await runDemo('seed', env)).toEqual({
      categories: 8,
      dishes: 40,
      ai_demo_baskets: 640,
      ai_demo_reviews: 240,
    });
    expect(await protectedData()).toBe(baseline);
    expect(await analytics()).toBe(baselineAnalytics);
    expect(
      await connection.db!.collection('paymentintents').countDocuments(),
    ).toBe(0);
    expect(await connection.db!.collection('reviews').countDocuments()).toBe(0);
    expect(await orders.countDocuments()).toBe(1);
  });

  it('serves seeded VI/EN catalog via unchanged MenuService and legacy fallback', async () => {
    for (const lang of ['vi', 'en'] as const) {
      const result = await menu.getPublicMenu(ids.table.toString(), lang);
      const demoCategories = result.categories.filter((category) =>
        category.name.startsWith('[DEMO]'),
      );
      expect(demoCategories).toHaveLength(8);
      const visible = demoCategories.flatMap((category) => category.dishes);
      expect(visible).toHaveLength(37);
      for (const dish of visible) {
        const original = dataset.dishes.find((entry) =>
          entry._id.equals(dish._id),
        )!;
        expect(dish.name).toBe(lang === 'en' ? original.nameEn : original.name);
        expect(dish.description).toBe(
          lang === 'en' ? original.descriptionEn : original.description,
        );
        expect(dish.ingredients).toEqual(original.ingredients);
        expect(dish.allergenTags).toEqual(original.allergenTags);
      }
      const legacy = result.categories
        .flatMap((category) => category.dishes)
        .find((dish) => dish._id.equals(ids.dish))!;
      expect(legacy).toMatchObject({
        name: 'Món cũ',
        description: 'Mô tả cũ',
        ingredients: [],
        allergenTags: [],
      });
    }
    expect(await protectedData()).toBe(baseline);
  });

  it('repeated/concurrent seed is idempotent', async () => {
    const results = await Promise.all([
      runDemo('seed', env),
      runDemo('seed', env),
    ]);
    for (const result of results)
      expect(Object.values(result)).toEqual([0, 0, 0, 0]);
    expect(await protectedData()).toBe(baseline);
  });

  it('refuses both seed and reset after manual edits without partial writes', async () => {
    await connection
      .db!.collection('dishes')
      .updateOne({ _id: ids.collision }, { $set: { price: 12345 } });
    for (const action of ['seed', 'reset'] as const)
      await expect(runDemo(action, env)).rejects.toThrow(
        'differs from the versioned fixture',
      );
    expect(
      await connection
        .db!.collection('categories')
        .countDocuments({ demoDataset: DATASET_ID }),
    ).toBe(8);
    expect(
      (
        await connection
          .db!.collection('dishes')
          .findOne({ _id: ids.collision })
      )?.price,
    ).toBe(12345);
    await connection
      .db!.collection('dishes')
      .replaceOne({ _id: ids.collision }, dataset.dishes[0]);
  });

  it('refuses reset with cart/order/category references, preserving the referenced data', async () => {
    const item = {
      dishId: ids.collision,
      dishName: String(dataset.dishes[0].name),
      unitPrice: Number(dataset.dishes[0].price),
      quantity: 1,
    };
    await sessions.updateOne({ _id: ids.session }, { $push: { cart: item } });
    await expect(runDemo('reset', env)).rejects.toThrow(
      'sessions contains a reference',
    );
    await sessions.updateOne({ _id: ids.session }, { $set: { cart: [] } });
    await sessions.updateOne(
      { _id: ids.session },
      { $set: { preMergeCart: [item] } },
    );
    await expect(runDemo('reset', env)).rejects.toThrow(
      'sessions contains a reference',
    );
    await sessions.updateOne(
      { _id: ids.session },
      { $set: { preMergeCart: [] } },
    );
    await sessions.updateOne(
      { _id: ids.session },
      { $set: { postMergeRootCart: [item] } },
    );
    await expect(runDemo('reset', env)).rejects.toThrow(
      'sessions contains a reference',
    );
    await sessions.updateOne(
      { _id: ids.session },
      { $unset: { postMergeRootCart: 1 } },
    );
    await orders.updateOne({ _id: ids.order }, { $push: { items: item } });
    await expect(runDemo('reset', env)).rejects.toThrow(
      'orders contains a reference',
    );
    await orders.updateOne(
      { _id: ids.order },
      { $pull: { items: { dishId: ids.collision } } },
    );
    await dishes.create({
      _id: ids.foreignDish,
      categoryId: dataset.categories[0]._id,
      name: 'Manually added dish',
      price: 42000,
    });
    await expect(runDemo('reset', env)).rejects.toThrow(
      'dishes contains a reference',
    );
    expect(await dishes.findById(ids.foreignDish)).not.toBeNull();
    await dishes.deleteOne({ _id: ids.foreignDish });
    // updatedAt intentionally changed by the harness, establish new baseline.
    baseline = await protectedData();
  });

  it('preserves other fixture namespaces and refuses dangling foreign basket/review references', async () => {
    const foreignId = new Types.ObjectId();
    for (const [name, reference] of [
      ['ai_demo_baskets', { items: [{ dishId: ids.collision }] }],
      ['ai_demo_reviews', { dishId: ids.collision }],
    ] as const) {
      try {
        await connection.db!.collection(name).insertOne({
          _id: foreignId,
          demoDataset: 'another-dataset',
          ...reference,
        });
        await expect(runDemo('reset', env)).rejects.toThrow(
          `${name} contains a reference`,
        );
        expect(
          await connection.db!.collection(name).findOne({ _id: foreignId }),
        ).not.toBeNull();
      } finally {
        await connection.db!.collection(name).deleteOne({ _id: foreignId });
      }
    }
  });

  it('resets only owned records; repeated reset is harmless and reseed deterministic', async () => {
    expect(await runDemo('reset', env)).toEqual({
      categories: 8,
      dishes: 40,
      ai_demo_baskets: 640,
      ai_demo_reviews: 240,
    });
    expect(Object.values(await runDemo('reset', env))).toEqual([0, 0, 0, 0]);
    expect(await protectedData()).toBe(baseline);
    expect(await analytics()).toBe(baselineAnalytics);
    await runDemo('seed', env);
    for (const [name, records] of Object.entries(dataset)) {
      const stored = await connection
        .db!.collection(name)
        .find({ demoDataset: DATASET_ID })
        .toArray();
      expect(stored.map(fingerprint).sort()).toEqual(
        records.map(fingerprint).sort(),
      );
    }
  });

  it('rejects an existing unowned ID collision before inserting any fixture', async () => {
    await runDemo('reset', env);
    await connection
      .db!.collection('dishes')
      .insertOne({ _id: ids.collision, name: 'Unowned collision', price: 777 });
    await expect(runDemo('seed', env)).rejects.toThrow('collides with');
    expect(
      await connection
        .db!.collection('categories')
        .countDocuments({ demoDataset: DATASET_ID }),
    ).toBe(0);
    expect(
      (
        await connection
          .db!.collection('dishes')
          .findOne({ _id: ids.collision })
      )?.price,
    ).toBe(777);
    await connection.db!.collection('dishes').deleteOne({ _id: ids.collision });
  });
});
