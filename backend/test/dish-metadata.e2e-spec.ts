import 'dotenv/config';
import * as dns from 'dns';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Model, Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DISH_METADATA_OPTIONS } from '../src/modules/dish/dish-metadata';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import {
  Dish,
  DishDocument,
  DishSchema,
} from '../src/modules/dish/dish.schema';
import { DishController } from '../src/modules/dish/dish.controller';
import { DishService } from '../src/modules/dish/dish.service';
import {
  Category,
  CategorySchema,
} from '../src/modules/category/category.schema';
import { Table, TableSchema } from '../src/modules/table/table.schema';
import { MenuController } from '../src/modules/menu/menu.controller';
import { MenuService } from '../src/modules/menu/menu.service';
import { CloudinaryService } from '../src/modules/cloudinary/cloudinary.service';

if (process.env.CUSTOM_DNS_SERVERS)
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
jest.setTimeout(60000);

/** Real MongoDB, isolated database, real JWT/RolesGuard/DTO/Multer/service/menu.
 * No AppModule startup, staff seed, orders, sessions, payments or external upload. */
describe('Phase 15 catalog HTTP + MongoDB', () => {
  let app: INestApplication<App>;
  let dishes: Model<DishDocument>;
  let categories: Model<Category>;
  let tables: Model<Table>;
  const categoryId = new Types.ObjectId();
  const hiddenCategoryId = new Types.ObjectId();
  const tableId = new Types.ObjectId();
  const legacyId = new Types.ObjectId();
  const secret = 'phase15-isolated-test-jwt-not-a-production-credential';
  const jwt = new JwtService({ secret });
  const token = (role: string) =>
    jwt.sign({ sub: 'phase15-test', email: 'phase15@example.invalid', role });
  const admin = `Bearer ${token('admin')}`;
  const base = {
    name: 'Phở bò kiểm thử',
    nameEn: 'Test Beef Pho',
    description: 'Nước dùng bò',
    price: 65000,
    categoryId: categoryId.toString(),
  };
  const metadata = {
    ingredients: ['beef', 'rice-noodles', 'fish-sauce'],
    allergenTags: ['fish'],
    dietaryTags: ['contains-meat'],
    spiceLevel: 0,
    servingSize: '1 tô',
    descriptionEn: 'Beef broth',
    availableModifiers: ['NO_ONION'],
  };
  let createdId: string;

  beforeAll(async () => {
    if (process.env.NODE_ENV === 'production')
      throw new Error('Catalog test is forbidden in production');
    if (!process.env.MONGODB_URI)
      throw new Error('MONGODB_URI is required for the real database test');
    const fixture = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(process.env.MONGODB_URI, {
          dbName: 'smartorder_phase15_test',
          retryAttempts: 0,
          serverSelectionTimeoutMS: 15000,
        }),
        MongooseModule.forFeature([
          { name: Dish.name, schema: DishSchema },
          { name: Category.name, schema: CategorySchema },
          { name: Table.name, schema: TableSchema },
        ]),
      ],
      controllers: [DishController, MenuController],
      providers: [
        DishService,
        MenuService,
        JwtStrategy,
        { provide: ConfigService, useValue: { get: () => secret } },
        {
          provide: CloudinaryService,
          useValue: {
            uploadBuffer: jest.fn().mockResolvedValue({
              secure_url: 'https://example.invalid/phase15.png',
            }),
            extractPublicId: jest.fn(),
            deleteByPublicId: jest.fn(),
          },
        },
      ],
    }).compile();
    app = fixture.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    dishes = fixture.get(getModelToken(Dish.name));
    categories = fixture.get(getModelToken(Category.name));
    tables = fixture.get(getModelToken(Table.name));
    await categories.create([
      { _id: categoryId, name: 'Món kiểm thử', nameEn: 'Test dishes' },
      { _id: hiddenCategoryId, name: 'Ẩn kiểm thử', isActive: false },
    ]);
    await tables.create({
      _id: tableId,
      tableCode: `P15_${tableId.toString()}`,
      qrCodeUrl: 'data:image/png;base64,phase15-test',
    });
    // Raw insert deliberately bypasses defaults to prove old stored BSON works.
    await dishes.collection.insertOne({
      _id: legacyId,
      name: 'Món cũ',
      description: 'Mô tả cũ',
      price: 45000,
      categoryId,
      isAvailable: true,
    });
  });

  afterAll(async () => {
    try {
      if (dishes)
        await dishes.deleteMany({
          categoryId: { $in: [categoryId, hiddenCategoryId] },
        });
      if (categories)
        await categories.deleteMany({
          _id: { $in: [categoryId, hiddenCategoryId] },
        });
      if (tables) await tables.deleteOne({ _id: tableId });
    } finally {
      if (app) await app.close();
    }
  });

  it('requires JWT and admin for taxonomy and mutations', async () => {
    await request(app.getHttpServer())
      .get('/dishes/metadata-options')
      .expect(401);
    for (const role of ['kitchen', 'waiter', 'customer']) {
      const auth = `Bearer ${token(role)}`;
      await request(app.getHttpServer())
        .get('/dishes/metadata-options')
        .set('Authorization', auth)
        .expect(403);
      await request(app.getHttpServer())
        .post('/dishes')
        .set('Authorization', auth)
        .send(base)
        .expect(403);
      await request(app.getHttpServer())
        .put(`/dishes/${legacyId.toString()}`)
        .set('Authorization', auth)
        .send(metadata)
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/dishes/${legacyId.toString()}`)
        .set('Authorization', auth)
        .expect(403);
    }
    const result = await request(app.getHttpServer())
      .get('/dishes/metadata-options')
      .set('Authorization', admin)
      .expect(200);
    expect(
      (result.body as typeof DISH_METADATA_OPTIONS).allergens,
    ).toContainEqual({
      value: 'peanut',
      label: 'Đậu phộng',
    });
  });

  it('creates through multipart with image, reads exact facts from MongoDB', async () => {
    let create = request(app.getHttpServer())
      .post('/dishes')
      .set('Authorization', admin);
    for (const [key, value] of Object.entries({ ...base, ...metadata }))
      create = create.field(
        key,
        Array.isArray(value) ? JSON.stringify(value) : String(value),
      );
    const result = await create
      .attach('image', Buffer.from('test-image'), {
        filename: 'test.png',
        contentType: 'image/png',
      })
      .expect(201);
    createdId = (result.body as { _id: string })._id;
    expect(result.body).toMatchObject({
      ...metadata,
      price: 65000,
      categoryId: { _id: categoryId.toString() },
    });
    const persisted = await dishes.findById(createdId).lean();
    expect(persisted).toMatchObject(metadata);
    expect(persisted?.imageUrl).toBe('https://example.invalid/phase15.png');
    await request(app.getHttpServer()).get(`/dishes/${createdId}`).expect(200);
  });

  it('serves VI/EN descriptions and legacy fallback, excluding unavailable and inactive-category dishes', async () => {
    await dishes.create([
      { ...base, name: 'Unavailable', isAvailable: false },
      { ...base, name: 'Hidden category', categoryId: hiddenCategoryId },
    ]);
    for (const lang of ['vi', 'en']) {
      const result = await request(app.getHttpServer())
        .get('/menu')
        .query({ tableId: tableId.toString(), lang })
        .expect(200);
      const body = result.body as {
        categories: {
          _id: string;
          dishes: ({ _id: string } & Record<string, unknown>)[];
        }[];
      };
      const category = body.categories.find(
        (value: { _id: string }) => value._id === categoryId.toString(),
      );
      expect(category).toBeDefined();
      expect(category!.dishes).toHaveLength(2);
      expect(
        category!.dishes.find(
          (value: { _id: string }) => value._id === createdId,
        ),
      ).toMatchObject({
        ...metadata,
        name: lang === 'en' ? base.nameEn : base.name,
        description: lang === 'en' ? metadata.descriptionEn : base.description,
        price: 65000,
      });
      expect(
        category!.dishes.find(
          (value: { _id: string }) => value._id === legacyId.toString(),
        ),
      ).toMatchObject({
        name: 'Món cũ',
        description: 'Mô tả cũ',
        ingredients: [],
        allergenTags: [],
        availableModifiers: [],
      });
      expect(
        body.categories.some(
          (value: { _id: string }) => value._id === hiddenCategoryId.toString(),
        ),
      ).toBe(false);
    }
    expect(
      (await dishes.collection.findOne({ _id: legacyId }))?.ingredients,
    ).toBeUndefined();
  });

  it('updates metadata, preserves omitted fields, and explicitly clears values', async () => {
    await request(app.getHttpServer())
      .put(`/dishes/${createdId}`)
      .set('Authorization', admin)
      .send({ description: 'Mô tả cập nhật' })
      .expect(200);
    expect(await dishes.findById(createdId).lean()).toMatchObject(metadata);
    await request(app.getHttpServer())
      .put(`/dishes/${createdId}`)
      .set('Authorization', admin)
      .field('ingredients', '["beef"]')
      .field('spiceLevel', '5')
      .expect(200);
    expect(await dishes.findById(createdId).lean()).toMatchObject({
      ingredients: ['beef'],
      spiceLevel: 5,
      allergenTags: ['fish'],
    });
    await request(app.getHttpServer())
      .put(`/dishes/${createdId}`)
      .set('Authorization', admin)
      .field('ingredients', '[]')
      .field('allergenTags', '[]')
      .field('dietaryTags', '[]')
      .field('availableModifiers', '[]')
      .field('descriptionEn', '')
      .field('servingSize', '')
      .field('spiceLevel', '')
      .expect(200);
    expect(await dishes.findById(createdId).lean()).toMatchObject({
      ingredients: [],
      allergenTags: [],
      dietaryTags: [],
      availableModifiers: [],
      spiceLevel: null,
      descriptionEn: '',
      servingSize: '',
      price: 65000,
      isAvailable: true,
    });
  });

  it('rejects malformed multipart/unknown taxonomy/extra fields without changing persisted data', async () => {
    for (const [field, value] of [
      ['ingredients', 'beef'],
      ['allergenTags', '["invented"]'],
      ['spiceLevel', '6'],
      ['availableModifiers', 'null'],
      ['approvedByAi', 'true'],
    ]) {
      await request(app.getHttpServer())
        .put(`/dishes/${createdId}`)
        .set('Authorization', admin)
        .field(field, value)
        .expect(400);
    }
    expect(await dishes.findById(createdId).lean()).toMatchObject({
      ingredients: [],
      allergenTags: [],
      spiceLevel: null,
    });
  });

  it('deletes through existing Admin CRUD', async () => {
    await request(app.getHttpServer())
      .delete(`/dishes/${createdId}`)
      .set('Authorization', admin)
      .expect(200);
    expect(await dishes.findById(createdId)).toBeNull();
    await request(app.getHttpServer()).get(`/dishes/${createdId}`).expect(404);
  });
});
