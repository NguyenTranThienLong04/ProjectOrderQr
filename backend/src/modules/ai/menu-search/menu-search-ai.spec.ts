import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { model, Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Dish } from '../../dish/dish.schema';
import { Table } from '../../table/table.schema';
import { Category } from '../../category/category.schema';
import { AiError } from '../ai.errors';
import { AI_PROVIDER } from '../providers/ai-provider.interface';
import {
  AiInteraction,
  AiInteractionSchema,
} from '../schemas/ai-interaction.schema';
import { MockAiProvider, type MockAiStep } from '../testing/mock-ai-provider';
import { validAiEnv } from '../testing/ai-test.fixture';
import { MenuSearchAiModule } from './menu-search-ai.module';
import { MENU_SEARCH_GOLDEN_V1, emptyMenuIntent } from './menu-search.golden';
import { MENU_SEARCH_PROMPT } from '../prompts/menu-search.prompt';
import type { MenuSearchIntent } from './menu-search.dto';
import type { MenuSearchFilters } from '../../menu/menu-search';

type Body = {
  result: {
    dishes: { _id: string; name: string; price: number }[];
    appliedFilters: MenuSearchFilters;
  };
  warnings: string[];
  fallbackUsed: boolean;
  modelVersion: string;
};
const body = (res: { body: unknown }) => res.body as Body;
const chain = <T>(value: T) => ({
  sort: jest.fn().mockReturnThis(),
  lean: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(value),
});
describe('Phase 20 real Nest HTTP/orchestrator/filter contract with mock DB/provider', () => {
  let app: INestApplication<App>;
  let config: ConfigService;
  const tableId = new Types.ObjectId().toString();
  const categoryId = new Types.ObjectId();
  const dishId = new Types.ObjectId();
  const auditModel = model('MenuSearchContractAudit', AiInteractionSchema);
  let insert: jest.SpyInstance<unknown, [Record<string, unknown>, unknown?]>;
  let provider: MockAiProvider;
  const steps: MockAiStep[] = [];
  const tableExec = jest.fn();
  const findDish = jest.fn();
  const findCategory = jest.fn();
  const dish = {
    _id: dishId,
    categoryId,
    name: 'Phở bò',
    nameEn: 'Beef pho',
    description: 'Món thật từ catalog',
    price: 70000,
    isAvailable: true,
    ingredients: ['thịt bò / beef', 'bánh phở'],
    allergenTags: ['fish'],
    dietaryTags: ['contains-meat'],
    spiceLevel: 0,
  };
  const post = (query = 'Phở', extras: object = {}) =>
    request(app.getHttpServer())
      .post('/ai/menu/search')
      .send({ tableId, query, ...extras });
  beforeEach(async () => {
    steps.length = 0;
    provider = new MockAiProvider(steps);
    config = new ConfigService({ ...validAiEnv, AI_MAX_RETRIES: '0' });
    tableExec.mockResolvedValue({ id: tableId, tableCode: 'P20' });
    findCategory.mockReturnValue(
      chain([{ _id: categoryId, name: 'Món nước', nameEn: 'Soups' }]),
    );
    findDish.mockReturnValue(chain([dish]));
    insert = jest.spyOn(auditModel.collection, 'insertOne').mockResolvedValue({
      acknowledged: true,
      insertedId: new Types.ObjectId(),
    });
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Live fetch forbidden'));
    const fixture = await Test.createTestingModule({
      imports: [ConfigModule, MenuSearchAiModule],
    })
      .overrideProvider(getModelToken(AiInteraction.name))
      .useValue(auditModel)
      .overrideProvider(getModelToken(Table.name))
      .useValue({ findById: () => ({ exec: tableExec }) })
      .overrideProvider(getModelToken(Category.name))
      .useValue({ find: findCategory })
      .overrideProvider(getModelToken(Dish.name))
      .useValue({ find: findDish })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(AI_PROVIDER)
      .useValue(provider)
      .compile();
    app = fixture.createNestApplication<INestApplication<App>>();
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });
  it.each(MENU_SEARCH_GOLDEN_V1)(
    'versioned VI fixture: $query',
    async ({ query, intent }) => {
      steps.push({
        output: { ...emptyMenuIntent(), ...intent },
        usage: { inputTokens: 40, outputTokens: 20 },
      });
      const result = body(await post(query).expect(200));
      const unsupported = Boolean(intent.unsupportedCriteria?.length);
      expect(result.fallbackUsed).toBe(unsupported);
      expect(result.result.appliedFilters).toEqual(unsupported ? {} : intent);
      if (unsupported)
        expect(result.warnings.join(' ')).toContain('không đủ để xác minh');
      if (intent.excludedAllergens)
        expect(result.warnings.join(' ')).toContain(
          'Không thể xác minh đầy đủ',
        );
      expect(provider.calls[0].systemPrompt).toBe(
        MENU_SEARCH_PROMPT.systemPrompt,
      );
      const input = JSON.parse(provider.calls[0].input) as Record<
        string,
        unknown
      >;
      expect(input).toEqual({
        query,
        lang: 'vi',
        categories: [{ name: 'Món nước', nameEn: 'Soups' }],
      });
      expect(JSON.stringify(input)).not.toContain(dishId.toString());
      expect(
        result.result.dishes.every(
          (item) => item._id === dishId.toString() && item.price === 70000,
        ),
      ).toBe(true);
      expect(insert.mock.calls[0][0]).toMatchObject({
        feature: 'menu-search',
        promptVersion: 'menu-search-v2',
        success: true,
        inputTokens: 40,
        outputTokens: 20,
      });
      expect(JSON.stringify(insert.mock.calls)).not.toContain(query);
    },
  );
  it('filters combined constraints and returns only real DB data with exact version', async () => {
    steps.push({
      output: {
        ...emptyMenuIntent(),
        maxPrice: 100000,
        requiredIngredients: ['beef'],
        excludedAllergens: ['peanut'],
        maxSpiceLevel: 0,
      },
    });
    const result = body(await post().expect(200));
    expect(result.result.dishes).toHaveLength(1);
    expect(result.result.dishes[0]).toMatchObject({
      _id: dishId.toString(),
      price: 70000,
      name: 'Phở bò',
    });
    expect(result.modelVersion).toBe(
      'openai:test-model-snapshot:menu-search-v2',
    );
    expect(findDish).toHaveBeenCalledTimes(2);
    expect(findDish).toHaveBeenLastCalledWith({
      isAvailable: true,
      categoryId: { $in: [categoryId] },
    });
    expect(findCategory).toHaveBeenLastCalledWith({ isActive: true });
  });
  it('reads fresh price after provider completion', async () => {
    steps.push(() => {
      findDish.mockReturnValue(chain([{ ...dish, price: 150000 }]));
      return Promise.resolve({
        output: { ...emptyMenuIntent(), maxPrice: 100000 },
      });
    });
    expect(body(await post().expect(200)).result.dishes).toEqual([]);
  });
  it('hard excludes a recorded allergen despite safe-sounding name and empty ingredients', async () => {
    findDish.mockReturnValue(
      chain([
        {
          ...dish,
          name: 'Không đậu phộng',
          ingredients: [],
          allergenTags: ['peanut'],
        },
      ]),
    );
    steps.push({
      output: { ...emptyMenuIntent(), excludedAllergens: ['peanut'] },
    });
    expect(body(await post().expect(200)).result.dishes).toEqual([]);
  });
  it('warns for missing allergy metadata without declaring safety', async () => {
    findDish.mockReturnValue(chain([{ ...dish, allergenTags: undefined }]));
    steps.push({
      output: { ...emptyMenuIntent(), excludedAllergens: ['peanut'] },
    });
    expect(body(await post().expect(200)).warnings.join(' ')).toContain(
      'Không thể xác minh đầy đủ',
    );
  });
  it('warns and excludes unknown spice rather than treating it as zero', async () => {
    findDish.mockReturnValue(chain([{ ...dish, spiceLevel: null }]));
    steps.push({ output: { ...emptyMenuIntent(), maxSpiceLevel: 0 } });
    const result = body(await post().expect(200));
    expect(result.result.dishes).toEqual([]);
    expect(result.warnings.join(' ')).toContain('thiếu metadata');
  });
  it('vetoes model nutrition substitutions even if unsupported flag is missing', async () => {
    steps.push({
      output: { ...emptyMenuIntent(), requiredDietaryTags: ['vegetarian'] },
    });
    const result = body(await post('món tốt cho tim').expect(200));
    expect(result.result.appliedFilters).toEqual({});
    expect(result.warnings.join(' ')).toContain('không đủ để xác minh');
    expect(result.fallbackUsed).toBe(true);
  });
  it('does not confuse tìm (search) with tim (heart)', async () => {
    steps.push({ output: { ...emptyMenuIntent(), maxPrice: 100000 } });
    const result = body(await post('tìm món dưới 100k').expect(200));
    expect(result.fallbackUsed).toBe(false);
    expect(result.result.dishes).toHaveLength(1);
  });
  it('links ingredient peanut exclusion to its allergen when the model misses the tag', async () => {
    findDish.mockReturnValue(
      chain([{ ...dish, ingredients: ['thịt bò'], allergenTags: ['peanut'] }]),
    );
    steps.push({
      output: { ...emptyMenuIntent(), excludedIngredients: ['peanut'] },
    });
    const result = body(await post('không có đậu phộng').expect(200));
    expect(result.result.dishes).toEqual([]);
    expect(result.result.appliedFilters.excludedAllergens).toEqual(['peanut']);
  });
  it('does not require or create an active session for a valid public table', async () => {
    steps.push({ output: { ...emptyMenuIntent(), maxPrice: 80000 } });
    await post().expect(200);
    tableExec.mockResolvedValue(null);
    await post().expect(404);
    expect(provider.calls).toHaveLength(1);
  });
  it.each([
    { tableId: 'bad' },
    { tableId: null },
    { query: '' },
    { query: '  ' },
    { query: null },
    { query: 4 },
    { query: 'a'.repeat(501) },
    { query: '😀'.repeat(251) },
    { lang: 'fr' },
    { lang: null },
    { filters: { price: 1 } },
    { $where: 'evil' },
    { sessionId: tableId },
  ])('rejects invalid DTO %j before provider', async (extras) => {
    await post('Phở', extras).expect(400);
    expect(provider.calls).toHaveLength(0);
    expect(findDish).not.toHaveBeenCalled();
  });
  it('requires tableId, trims and bounds query', async () => {
    await request(app.getHttpServer())
      .post('/ai/menu/search')
      .send({ query: 'Phở' })
      .expect(400);
    steps.push({ output: { ...emptyMenuIntent(), keywords: ['Phở'] } });
    await post('  Phở  ').expect(200);
    expect(provider.calls[0].input).toContain('"query":"Phở"');
  });
  it.each<Partial<MenuSearchIntent> | Record<string, unknown>>([
    { maxPrice: '100000' },
    { maxPrice: -1 },
    { maxPrice: 1.5 },
    { maxPrice: 1000000001 },
    { minPrice: 120000, maxPrice: 50000 },
    { minSpiceLevel: 4, maxSpiceLevel: 1 },
    { maxSpiceLevel: 6 },
    { excludedAllergens: ['unknown'] },
    { requiredDietaryTags: ['halal'] },
    { requiredIngredients: ['beef', 'beef'] },
    { keywords: ['x'.repeat(81)] },
    { categories: [' '] },
    { excludedAllergens: null },
    { unsupportedCriteria: ['secret explanation'] },
    { dishes: [{ _id: 'imaginary' }] },
    { $where: 'return true' },
    { pipeline: [{ $match: {} }] },
    { maxPrice: undefined },
  ])(
    'invalid model fields fail schema and honestly fallback %j',
    async (extra) => {
      steps.push({ output: { ...emptyMenuIntent(), ...extra } });
      const result = body(await post().expect(200));
      expect(result.fallbackUsed).toBe(true);
      expect(result.result.appliedFilters).toEqual({});
      expect(result.result.dishes).toHaveLength(1);
      expect(insert.mock.calls[0][0]).toMatchObject({
        success: false,
        errorCode: 'AI_INVALID_OUTPUT',
        fallbackUsed: true,
      });
    },
  );
  it.each([
    'AI_DISABLED',
    'AI_NOT_CONFIGURED',
    'AI_TIMEOUT',
    'AI_PROVIDER_UNAVAILABLE',
  ] as const)('fallback normal search when %s', async (code) => {
    if (code === 'AI_DISABLED') config.set('AI_ENABLED', 'false');
    else if (code === 'AI_NOT_CONFIGURED') config.set('AI_API_KEY', '');
    else steps.push(new AiError(code));
    const result = body(await post('Beef', { lang: 'en' }).expect(200));
    expect(result.fallbackUsed).toBe(true);
    expect(result.result.dishes[0].name).toBe('Beef pho');
    expect(result.warnings.join(' ')).toContain('not been verified');
    expect(insert.mock.calls[0][0]).toMatchObject({
      errorCode: code,
      fallbackUsed: true,
    });
  });
  it('aborts timed-out provider and keeps menu searchable', async () => {
    steps.push(() => new Promise(() => {}));
    const result = body(await post().expect(200));
    expect(result.fallbackUsed).toBe(true);
    expect(provider.calls[0].signal.aborted).toBe(true);
    await request(app.getHttpServer())
      .get('/menu')
      .query({ tableId, lang: 'en' })
      .expect(200);
  });
  it('does not interpolate model keywords as Mongo syntax', async () => {
    steps.push({
      output: { ...emptyMenuIntent(), keywords: ['$where return true'] },
    });
    expect(body(await post().expect(200)).result.dishes).toEqual([]);
    expect(JSON.stringify(findDish.mock.calls)).not.toContain('$where');
  });
  it('limits public AI POSTs to 10 per minute and leaves normal menu accessible', async () => {
    for (let i = 0; i < 10; i++) {
      steps.push({ output: { ...emptyMenuIntent(), maxPrice: 80000 } });
      await post().expect(200);
    }
    await post().expect(429);
    expect(provider.calls).toHaveLength(10);
    await request(app.getHttpServer())
      .get('/menu')
      .query({ tableId })
      .expect(200);
  });
});
