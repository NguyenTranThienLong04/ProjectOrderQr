import { ValidationPipe } from '@nestjs/common';
import { model, Types } from 'mongoose';
import { CreateDishDto } from './dto/create-dish.dto';
import { UpdateDishDto } from './dto/update-dish.dto';
import { DishSchema } from './dish.schema';
import { DISH_METADATA_OPTIONS } from './dish-metadata';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});
const base = {
  name: 'Phở bò',
  price: 65000,
  categoryId: new Types.ObjectId().toString(),
};
const DishModel = model('DishMetadataUnit', DishSchema);
const metadata = {
  descriptionEn: 'Beef noodle soup',
  ingredients: ['beef', 'rice-noodles'],
  allergenTags: ['fish'],
  dietaryTags: ['contains-meat'],
  spiceLevel: 0,
  servingSize: '1 tô',
  availableModifiers: ['NO_ONION'],
};

describe('Dish metadata validation', () => {
  it('accepts existing create clients with no metadata and keeps partial DTOs empty', async () => {
    await expect(
      pipe.transform(base, { type: 'body', metatype: CreateDishDto }),
    ).resolves.toMatchObject(base);
    expect(
      await pipe.transform({}, { type: 'body', metatype: UpdateDishDto }),
    ).toEqual({});
  });

  it.each([CreateDishDto, UpdateDishDto])(
    'validates native JSON and multipart metadata for %p',
    async (metatype) => {
      const json = (await pipe.transform(
        { ...base, ...metadata },
        { type: 'body', metatype },
      )) as CreateDishDto;
      const multipart = Object.fromEntries(
        Object.entries({ ...base, ...metadata }).map(([key, value]) => [
          key,
          Array.isArray(value) ? JSON.stringify(value) : String(value),
        ]),
      );
      const dto = (await pipe.transform(multipart, {
        type: 'body',
        metatype,
      })) as CreateDishDto;
      expect(dto).toEqual(json);
      expect(dto.spiceLevel).toBe(0);
    },
  );

  it('trims strings and distinguishes omitted, cleared, and zero spice', async () => {
    const dto = (await pipe.transform(
      {
        ingredients: '[" beef "]',
        descriptionEn: ' Soup ',
        servingSize: ' 1 tô ',
        spiceLevel: '',
      },
      { type: 'body', metatype: UpdateDishDto },
    )) as UpdateDishDto;
    expect(dto).toMatchObject({
      ingredients: ['beef'],
      descriptionEn: 'Soup',
      servingSize: '1 tô',
      spiceLevel: null,
    });
    expect(dto.allergenTags).toBeUndefined();
    const cleared = (await pipe.transform(
      {
        allergenTags: '[]',
        availableModifiers: [],
        spiceLevel: null,
        descriptionEn: '',
        servingSize: '',
      },
      { type: 'body', metatype: UpdateDishDto },
    )) as UpdateDishDto;
    expect(cleared).toMatchObject({
      allergenTags: [],
      availableModifiers: [],
      spiceLevel: null,
      descriptionEn: '',
      servingSize: '',
    });
  });

  const invalid: Record<string, unknown>[] = [
    { ingredients: 'beef' },
    { ingredients: '[invalid' },
    { ingredients: '{}' },
    { ingredients: null },
    { ingredients: [12] },
    { ingredients: [['beef']] },
    { ingredients: [' '] },
    { ingredients: ['beef', ' beef '] },
    { ingredients: ['a'.repeat(81)] },
    { ingredients: Array.from({ length: 41 }, (_, i) => `ingredient-${i}`) },
    { allergenTags: 'peanut' },
    { allergenTags: '"peanut"' },
    { allergenTags: ['invented'] },
    { allergenTags: ['peanut', 'peanut'] },
    { allergenTags: null },
    { dietaryTags: ['halal'] },
    { dietaryTags: ['vegan', 'contains-meat'] },
    { dietaryTags: null },
    { availableModifiers: ['FREE_MEAL'] },
    { availableModifiers: null },
    { spiceLevel: -1 },
    { spiceLevel: 6 },
    { spiceLevel: 1.5 },
    { spiceLevel: true },
    { spiceLevel: ' ' },
    { spiceLevel: 'null' },
    { spiceLevel: [] },
    { spiceLevel: '1e0' },
    { descriptionEn: null },
    { descriptionEn: 'x'.repeat(2001) },
    { servingSize: null },
    { servingSize: 'x'.repeat(101) },
    { categoryId: 'not-an-id' },
    { metadataApprovedByAi: true },
  ];
  it.each(invalid)(
    'rejects invalid metadata for both create and update: %j',
    async (input) => {
      for (const metatype of [CreateDishDto, UpdateDishDto]) {
        await expect(
          pipe.transform({ ...base, ...input }, { type: 'body', metatype }),
        ).rejects.toMatchObject({ status: 400 });
      }
    },
  );

  it('accepts every backend-owned taxonomy value and spice boundary', async () => {
    for (const spiceLevel of [0, 5]) {
      await expect(
        pipe.transform(
          {
            ...base,
            allergenTags: DISH_METADATA_OPTIONS.allergens.map(
              ({ value }) => value,
            ),
            dietaryTags: ['vegan', 'vegetarian'],
            availableModifiers: DISH_METADATA_OPTIONS.modifiers.map(
              ({ value }) => value,
            ),
            spiceLevel,
          },
          { type: 'body', metatype: CreateDishDto },
        ),
      ).resolves.toBeDefined();
    }
  });

  it('hydrates legacy documents without inventing factual values or modifying old fields', async () => {
    const legacy = DishModel.hydrate({ _id: new Types.ObjectId(), ...base });
    await expect(legacy.validate()).resolves.toBeUndefined();
    expect(legacy.ingredients).toEqual([]);
    expect(legacy.allergenTags).toEqual([]);
    expect(legacy.dietaryTags).toEqual([]);
    expect(legacy.availableModifiers).toEqual([]);
    expect(legacy.spiceLevel).toBeUndefined();
    expect(legacy.descriptionEn).toBeUndefined();
    expect(legacy.name).toBe(base.name);
    expect(legacy.isModified()).toBe(false);
  });

  it.each([
    { allergenTags: ['invented'] },
    { allergenTags: ['peanut', 'peanut'] },
    { ingredients: 'beef' },
    { ingredients: [''] },
    { ingredients: null },
    { dietaryTags: ['contains-meat', 'vegan'] },
    { availableModifiers: ['FREE_MEAL'] },
    { spiceLevel: 1.5 },
    { spiceLevel: 6 },
    { descriptionEn: 'x'.repeat(2001) },
  ])(
    'also rejects invalid metadata at the Mongoose boundary: %j',
    async (input) => {
      await expect(
        new DishModel({ ...base, ...input }).validate(),
      ).rejects.toBeDefined();
    },
  );
});
