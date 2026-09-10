import 'dotenv/config';
import * as dns from 'dns';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { MenuSearchAiModule } from '../src/modules/ai/menu-search/menu-search-ai.module';
import { emptyMenuIntent } from '../src/modules/ai/menu-search/menu-search.golden';
import type { MenuSearchIntent } from '../src/modules/ai/menu-search/menu-search.dto';
import { AiError } from '../src/modules/ai/ai.errors';
import { AI_PROVIDER } from '../src/modules/ai/providers/ai-provider.interface';
import { AiInteraction } from '../src/modules/ai/schemas/ai-interaction.schema';
import {
  MockAiProvider,
  type MockAiStep,
} from '../src/modules/ai/testing/mock-ai-provider';
import { validAiEnv } from '../src/modules/ai/testing/ai-test.fixture';
import { Category } from '../src/modules/category/category.schema';
import { Dish } from '../src/modules/dish/dish.schema';
import { Table } from '../src/modules/table/table.schema';
import { buildCatalog } from '../scripts/ai-demo/catalog';
import type { MenuSearchFilters } from '../src/modules/menu/menu-search';

if (process.env.CUSTOM_DNS_SERVERS)
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
jest.setTimeout(60000);
type Body = {
  result: {
    dishes: (Dish & { _id: string })[];
    appliedFilters: MenuSearchFilters;
  };
  warnings: string[];
  fallbackUsed: boolean;
  modelVersion: string;
};
const body = (res: { body: unknown }) => res.body as Body;

describe('Phase 20 real Mongo/HTTP menu search, synthetic Phase 16 catalog', () => {
  const dbName = `smartorder_p20_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const tableId = new Types.ObjectId();
  const hiddenCategoryId = new Types.ObjectId();
  const hiddenDishId = new Types.ObjectId();
  const legacyDishId = new Types.ObjectId();
  const catalog = buildCatalog();
  const dishIds = [
    ...catalog.dishes.map((dish) => dish._id),
    hiddenDishId,
    legacyDishId,
  ];
  const categoryIds = [
    ...catalog.categories.map((category) => category._id),
    hiddenCategoryId,
  ];
  const config = new ConfigService({ ...validAiEnv, AI_MAX_RETRIES: '0' });
  const steps: MockAiStep[] = [];
  const provider = new MockAiProvider(steps);
  let app: INestApplication<App>;
  let connection: Connection;
  let dishes: Model<Dish>,
    categories: Model<Category>,
    tables: Model<Table>,
    audit: Model<AiInteraction>;
  const post = (
    query: string,
    intent: Partial<MenuSearchIntent>,
    lang: 'vi' | 'en' = 'vi',
  ) => {
    steps.push({
      output: { ...emptyMenuIntent(), ...intent },
      usage: { inputTokens: 50, outputTokens: 30 },
    });
    return request(app.getHttpServer())
      .post('/ai/menu/search')
      .send({ tableId: tableId.toString(), query, lang });
  };
  const snapshot = async () =>
    JSON.stringify({
      dishes: await dishes.find().sort('_id').lean(),
      categories: await categories.find().sort('_id').lean(),
      tables: await tables.find().sort('_id').lean(),
    });
  beforeAll(async () => {
    if (process.env.NODE_ENV === 'production' || !process.env.MONGODB_URI)
      throw new Error(
        'Requires non-production MONGODB_URI; test dbName is always isolated',
      );
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Live provider forbidden'));
    const fixture = await Test.createTestingModule({
      imports: [
        ConfigModule,
        MongooseModule.forRoot(process.env.MONGODB_URI, {
          dbName,
          retryAttempts: 0,
          serverSelectionTimeoutMS: 15000,
        }),
        MenuSearchAiModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(AI_PROVIDER)
      .useValue(provider)
      .compile();
    app = fixture.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    connection = fixture.get(getConnectionToken());
    expect(connection.name).toBe(dbName);
    dishes = fixture.get(getModelToken(Dish.name));
    categories = fixture.get(getModelToken(Category.name));
    tables = fixture.get(getModelToken(Table.name));
    audit = fixture.get(getModelToken(AiInteraction.name));
    await audit.init();
    await categories.insertMany([
      ...catalog.categories,
      { _id: hiddenCategoryId, name: 'Hidden', isActive: false },
    ]);
    await tables.create({
      _id: tableId,
      tableCode: `P20_${tableId.toString()}`,
      qrCodeUrl: 'test-only',
    });
    await dishes.insertMany([
      ...catalog.dishes,
      {
        _id: hiddenDishId,
        name: 'Hidden beef',
        price: 1,
        categoryId: hiddenCategoryId,
        isAvailable: true,
      },
    ]);
    // Raw legacy document has no Phase 15 metadata at all.
    await dishes.collection.insertOne({
      _id: legacyDishId,
      name: 'Legacy beef peanut-free vegan',
      price: 50000,
      categoryId: catalog.categories[0]._id,
      isAvailable: true,
    });
  });
  afterAll(async () => {
    try {
      if (connection?.name === dbName) {
        await dishes?.deleteMany({ _id: { $in: dishIds } });
        await categories?.deleteMany({ _id: { $in: categoryIds } });
        await tables?.deleteOne({ _id: tableId });
        if (audit) {
          const entries = await audit
            .find({ feature: 'menu-search' })
            .select('_id')
            .lean();
          await audit.deleteMany({
            _id: { $in: entries.map(({ _id }) => _id) },
          });
        }
        for (const collection of Object.values(connection.collections))
          expect(await collection.countDocuments()).toBe(0);
      }
    } finally {
      await app?.close();
      jest.restoreAllMocks();
    }
  });
  it('filters price inclusively from actual Mongo and persists private versioned audit without business mutation', async () => {
    const before = await snapshot();
    const result = body(
      await post('món từ 50k đến 120k', {
        minPrice: 50000,
        maxPrice: 120000,
      }).expect(200),
    );
    const expected = catalog.dishes
      .filter(
        (dish) =>
          dish.isAvailable && dish.price >= 50000 && dish.price <= 120000,
      )
      .map((dish) => dish._id.toString());
    expect(result.result.dishes.map((dish) => dish._id).sort()).toEqual(
      [...expected, legacyDishId.toString()].sort(),
    );
    expect(
      result.result.dishes.every(
        (dish) =>
          dish.price >= 50000 && dish.price <= 120000 && dish.isAvailable,
      ),
    ).toBe(true);
    expect(await snapshot()).toBe(before);
    const entry = await audit.findOne({ feature: 'menu-search' }).lean();
    expect(entry).toMatchObject({
      promptVersion: 'menu-search-v2',
      provider: 'openai',
      success: true,
      inputTokens: 50,
      outputTokens: 30,
    });
    expect(JSON.stringify(entry)).not.toContain('món từ');
    expect(JSON.stringify(entry)).not.toContain(tableId.toString());
    expect(await connection.collection('sessions').countDocuments()).toBe(0);
  });
  it('ingredient include/exclude, allergen and spice come from metadata, never names', async () => {
    const filters = {
      requiredIngredients: ['beef'],
      excludedIngredients: ['peanut'],
      excludedAllergens: ['peanut'],
      maxSpiceLevel: 0,
      maxPrice: 100000,
    };
    const result = body(
      await post(
        'Món dưới 100k, không cay, không đậu phộng và có thịt bò',
        filters,
      ).expect(200),
    );
    const expected = catalog.dishes.filter(
      (dish) =>
        dish.isAvailable &&
        dish.price <= 100000 &&
        dish.spiceLevel === 0 &&
        dish.recipeIngredients.includes('beef') &&
        !dish.recipeIngredients.includes('peanut'),
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(result.result.dishes.map((dish) => dish._id).sort()).toEqual(
      expected.map((dish) => dish._id.toString()).sort(),
    );
    expect(result.warnings.join(' ')).toContain('Không thể xác minh đầy đủ');
    expect(result.warnings.join(' ')).toContain('thiếu metadata');
  });
  it('dietary filtering uses recorded lacto-ovo tag', async () => {
    const result = body(
      await post('món chay có trứng sữa', {
        requiredDietaryTags: ['lacto-ovo-vegetarian'],
      }).expect(200),
    );
    expect(result.result.dishes.length).toBeGreaterThan(0);
    expect(
      result.result.dishes.every((dish) =>
        dish.dietaryTags.includes('lacto-ovo-vegetarian'),
      ),
    ).toBe(true);
    expect(
      result.result.dishes.some((dish) => dish._id === legacyDishId.toString()),
    ).toBe(false);
  });
  it('category and EN localization reuse the public catalog', async () => {
    const result = body(
      await post(
        'món nước dưới 80k',
        { categories: [catalog.categories[0].name], maxPrice: 80000 },
        'en',
      ).expect(200),
    );
    expect(result.result.dishes.length).toBeGreaterThan(0);
    const menu = await request(app.getHttpServer())
      .get('/menu')
      .query({ tableId: tableId.toString(), lang: 'en' })
      .expect(200);
    const publicMenu = menu.body as {
      categories: {
        dishes: { _id: string; name: string; description: string }[];
      }[];
    };
    for (const dish of result.result.dishes) {
      const publicDish = publicMenu.categories
        .flatMap((category) => category.dishes)
        .find((item) => item._id === dish._id);
      expect(publicDish?.name).toBe(dish.name);
      expect(publicDish?.description).toBe(dish.description);
      expect(dish.categoryId.toString()).toBe(
        catalog.categories[0]._id.toString(),
      );
    }
  });
  it('rejects arbitrary model Mongo and hallucinated IDs with normal search fallback', async () => {
    steps.push({
      output: {
        ...emptyMenuIntent(),
        $where: 'return true',
        dishIds: [hiddenDishId.toString()],
      },
    });
    const result = body(
      await request(app.getHttpServer())
        .post('/ai/menu/search')
        .send({ tableId: tableId.toString(), query: 'Phở' })
        .expect(200),
    );
    expect(result.fallbackUsed).toBe(true);
    expect(result.result.appliedFilters).toEqual({});
    expect(result.result.dishes.length).toBeGreaterThan(0);
    expect(
      result.result.dishes.every((dish) => dish.name.includes('Phở')),
    ).toBe(true);
    expect(
      await audit.findOne({ errorCode: 'AI_INVALID_OUTPUT' }).lean(),
    ).toMatchObject({ fallbackUsed: true, success: false });
  });
  it('unsupported medical conditions cannot select a plausible substitute', async () => {
    const result = body(
      await post('món tốt cho người tiểu đường', {
        requiredDietaryTags: ['vegan'],
        unsupportedCriteria: ['medical'],
      }).expect(200),
    );
    expect(result.result.appliedFilters).toEqual({});
    expect(result.warnings.join(' ')).toContain('không đủ để xác minh');
    expect(result.fallbackUsed).toBe(true);
    expect(result.result.dishes).toEqual([]);
  });
  it('provider unavailability falls back and leaves public menu usable', async () => {
    steps.push(new AiError('AI_PROVIDER_UNAVAILABLE'));
    const before = await snapshot();
    const result = body(
      await request(app.getHttpServer())
        .post('/ai/menu/search')
        .send({ tableId: tableId.toString(), query: 'Phở' })
        .expect(200),
    );
    expect(result.fallbackUsed).toBe(true);
    expect(result.result.dishes.length).toBeGreaterThan(0);
    await request(app.getHttpServer())
      .get('/menu')
      .query({ tableId: tableId.toString() })
      .expect(200);
    expect(await snapshot()).toBe(before);
  });
  it('checks existing table before provider, and rejects client predicates', async () => {
    const calls = provider.calls.length;
    await request(app.getHttpServer())
      .post('/ai/menu/search')
      .send({ tableId: new Types.ObjectId().toString(), query: 'Phở' })
      .expect(404);
    await request(app.getHttpServer())
      .post('/ai/menu/search')
      .send({ tableId: tableId.toString(), query: 'Phở', filters: {} })
      .expect(400);
    expect(provider.calls).toHaveLength(calls);
  });
});
