import 'dotenv/config';
import * as dns from 'dns';
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CatalogDraftAiModule } from '../src/modules/ai/catalog-draft/catalog-draft-ai.module';
import { AiError } from '../src/modules/ai/ai.errors';
import { AI_PROVIDER } from '../src/modules/ai/providers/ai-provider.interface';
import { AiInteraction } from '../src/modules/ai/schemas/ai-interaction.schema';
import {
  MockAiProvider,
  type MockAiStep,
} from '../src/modules/ai/testing/mock-ai-provider';
import { validAiEnv } from '../src/modules/ai/testing/ai-test.fixture';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import {
  Category,
  CategorySchema,
} from '../src/modules/category/category.schema';
import { Dish, DishSchema } from '../src/modules/dish/dish.schema';
import { DishController } from '../src/modules/dish/dish.controller';
import { DishService } from '../src/modules/dish/dish.service';
import { CloudinaryService } from '../src/modules/cloudinary/cloudinary.service';
import { Table, TableSchema } from '../src/modules/table/table.schema';
import { MenuController } from '../src/modules/menu/menu.controller';
import { MenuService } from '../src/modules/menu/menu.service';

if (process.env.CUSTOM_DNS_SERVERS)
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
jest.setTimeout(60000);

describe('Phase 18 real Mongo + HTTP draft/review/CRUD boundary', () => {
  const dbName = `smartorder_p18_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const categoryId = new Types.ObjectId();
  const dishId = new Types.ObjectId();
  const tableId = new Types.ObjectId();
  const secret = 'phase18-isolated-jwt';
  const auth = `Bearer ${new JwtService({ secret }).sign({ sub: 'test', email: 'test@example.invalid', role: 'admin' })}`;
  const config = new ConfigService({
    ...validAiEnv,
    AI_MAX_RETRIES: '0',
    JWT_ACCESS_SECRET: secret,
  });
  const steps: MockAiStep[] = [];
  const provider = new MockAiProvider(steps);
  let app: INestApplication<App>;
  let connection: Connection;
  let dishes: Model<Dish>;
  let categories: Model<Category>;
  let tables: Model<Table>;
  let audit: Model<AiInteraction>;
  const draft = {
    nameEn: 'Bánh xèo',
    description: 'Bánh xèo truyền thống.',
    descriptionEn: 'Traditional bánh xèo.',
  };
  const post = () =>
    request(app.getHttpServer())
      .post('/ai/admin/dish-draft')
      .set('Authorization', auth)
      .send({
        name: 'Bánh xèo',
        description: 'Bánh xèo truyền thống.',
        categoryId: categoryId.toString(),
        generateFields: ['nameEn', 'description', 'descriptionEn'],
      });
  const catalogSnapshot = async () =>
    JSON.stringify({
      dishes: await dishes.find().sort('_id').lean(),
      categories: await categories.find().sort('_id').lean(),
    });

  beforeAll(async () => {
    if (process.env.NODE_ENV === 'production' || !process.env.MONGODB_URI)
      throw new Error(
        'Requires non-production and MONGODB_URI; test DB always overridden',
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
        MongooseModule.forFeature([
          { name: Dish.name, schema: DishSchema },
          { name: Category.name, schema: CategorySchema },
          { name: Table.name, schema: TableSchema },
        ]),
        CatalogDraftAiModule,
      ],
      controllers: [DishController, MenuController],
      providers: [
        JwtStrategy,
        DishService,
        MenuService,
        {
          provide: CloudinaryService,
          useValue: { uploadBuffer: jest.fn(), deleteByPublicId: jest.fn() },
        },
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
    await categories.create({
      _id: categoryId,
      name: 'Món Việt',
      nameEn: 'Vietnamese dishes',
    });
    await tables.create({
      _id: tableId,
      tableCode: `P18_${tableId.toString()}`,
      qrCodeUrl: 'test-only',
    });
    await dishes.create({
      _id: dishId,
      name: 'Bánh xèo',
      description: 'Mô tả gốc',
      categoryId,
      price: 65000,
      ingredients: ['rice-flour'],
      allergenTags: [],
      isAvailable: true,
    });
  });
  afterAll(async () => {
    try {
      if (connection && connection.name === dbName) {
        await dishes?.deleteOne({ _id: dishId });
        await categories?.deleteOne({ _id: categoryId });
        await tables?.deleteOne({ _id: tableId });
        if (audit) {
          const entries = await audit
            .find({ feature: 'dish-draft' })
            .select('_id')
            .lean();
          await audit.deleteMany({
            _id: { $in: entries.map((entry) => entry._id) },
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

  it('generates and persists a versioned audit without mutating any Dish/category', async () => {
    const before = await catalogSnapshot();
    steps.push({ output: draft, usage: { inputTokens: 35, outputTokens: 12 } });
    expect((await post().expect(200)).body).toEqual({
      result: draft,
      warnings: [],
      modelVersion: 'openai:test-model-snapshot:dish-draft-v2',
      fallbackUsed: false,
    });
    expect(await catalogSnapshot()).toBe(before);
    expect(await audit.findOne({ success: true }).lean()).toMatchObject({
      feature: 'dish-draft',
      promptVersion: 'dish-draft-v2',
      inputTokens: 35,
      outputTokens: 12,
      attempts: 1,
    });
    const context = JSON.parse(provider.calls[0].input) as Record<
      string,
      unknown
    >;
    expect(context.backendContext).toEqual({
      category: { name: 'Món Việt', nameEn: 'Vietnamese dishes' },
    });
    expect(provider.calls[0].input).not.toContain('rice-flour');
  });
  it('keeps legacy EN fallback before explicit CRUD save, then serves approved VI/EN content', async () => {
    const menu = async (lang: string) => {
      const response = await request(app.getHttpServer())
        .get('/menu')
        .query({ tableId: tableId.toString(), lang })
        .expect(200);
      return (
        response.body as {
          categories: { dishes: { name: string; description: string }[] }[];
        }
      ).categories[0].dishes[0];
    };
    expect(await menu('en')).toMatchObject({
      name: 'Bánh xèo',
      description: 'Mô tả gốc',
    });
    await request(app.getHttpServer())
      .put(`/dishes/${dishId.toString()}`)
      .set('Authorization', auth)
      .send(draft)
      .expect(200);
    expect(await menu('vi')).toMatchObject({
      name: 'Bánh xèo',
      description: draft.description,
    });
    expect(await menu('en')).toMatchObject({
      name: draft.nameEn,
      description: draft.descriptionEn,
    });
    expect(await dishes.findById(dishId).lean()).toMatchObject({
      price: 65000,
      ingredients: ['rice-flour'],
      allergenTags: [],
      isAvailable: true,
    });
  });
  it.each([
    [
      'AI_INVALID_OUTPUT',
      502,
      { output: { ...draft, ingredients: ['invented'] } },
    ],
    ['AI_PROVIDER_UNAVAILABLE', 503, new AiError('AI_PROVIDER_UNAVAILABLE')],
    ['AI_TIMEOUT', 504, () => new Promise(() => undefined)],
  ] as [string, number, MockAiStep][])(
    'audits %s with no catalog mutation',
    async (code, status, step) => {
      const before = await catalogSnapshot();
      steps.push(step);
      expect((await post().expect(status)).body).toMatchObject({ code });
      expect(await audit.findOne({ errorCode: code }).lean()).toMatchObject({
        success: false,
        promptVersion: 'dish-draft-v2',
        attempts: 1,
      });
      expect(await catalogSnapshot()).toBe(before);
    },
  );
  it('disabled and missing key remain controlled and manual CRUD still works', async () => {
    const before = await catalogSnapshot();
    config.set('AI_ENABLED', 'false');
    expect((await post().expect(503)).body).toMatchObject({
      code: 'AI_DISABLED',
    });
    config.set('AI_ENABLED', 'true');
    config.set('AI_API_KEY', '');
    expect((await post().expect(503)).body).toMatchObject({
      code: 'AI_NOT_CONFIGURED',
    });
    expect(await catalogSnapshot()).toBe(before);
    expect(await audit.countDocuments({ attempts: 0, success: false })).toBe(2);
    await request(app.getHttpServer())
      .put(`/dishes/${dishId.toString()}`)
      .set('Authorization', auth)
      .send({ description: 'Nhập thủ công' })
      .expect(200);
    expect(await dishes.findById(dishId).lean()).toMatchObject({
      description: 'Nhập thủ công',
      price: 65000,
    });
  });
  it('audit contains only metadata, no raw content or secrets, and no live provider call', async () => {
    const entries = await audit.find().lean();
    expect(entries).toHaveLength(6);
    const serialized = JSON.stringify(entries);
    for (const forbidden of [
      'Bánh xèo',
      'Món Việt',
      'rawPrompt',
      'systemPrompt',
      'draftText',
      'rice-flour',
      secret,
      validAiEnv.AI_API_KEY,
    ])
      expect(serialized).not.toContain(forbidden);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(provider.calls).toHaveLength(4);
  });
});
