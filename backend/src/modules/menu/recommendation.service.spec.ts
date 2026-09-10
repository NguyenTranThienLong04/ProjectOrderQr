import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { Order } from '../order/order.schema';
import { Session } from '../session/session.schema';
import { Table } from '../table/table.schema';
import { MenuService } from './menu.service';
import { RecommendationService } from './recommendation.service';
import { RecommendMenuDto } from './dto/recommend-menu.dto';

const ids = Array.from({ length: 7 }, () => new Types.ObjectId());
const [sessionId, tableId, categoryId, a, b, c, missing] = ids;
const dto = { sessionId: sessionId.toString(), tableId: tableId.toString() };
const query = (value: unknown) => {
  const builder = {
    sort: jest.fn(),
    limit: jest.fn(),
    select: jest.fn(),
    maxTimeMS: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(value),
  };
  for (const key of ['sort', 'limit', 'select', 'maxTimeMS', 'lean'] as const)
    builder[key].mockReturnValue(builder);
  return builder;
};
describe('RecommendationService boundaries', () => {
  function setup() {
    const session = { tableId, tableIds: [], cart: [{ dishId: a }] };
    const table = { currentSessionId: sessionId };
    const history = query(
      Array.from({ length: 20 }, () => ({
        items: [a, b, c, missing].map((dishId) => ({
          dishId,
          status: OrderStatus.SERVED,
        })),
      })),
    );
    const orders = { find: jest.fn().mockReturnValue(history) };
    const sessionQuery = query(session),
      tableQuery = query(table);
    const sessions = { findOne: jest.fn().mockReturnValue(sessionQuery) };
    const tables = { findById: jest.fn().mockReturnValue(tableQuery) };
    const catalog = {
      categories: [{ _id: categoryId, name: 'Sides' }],
      dishes: [a, b, c].map((_id) => ({
        _id,
        name: _id.toString(),
        categoryId,
        price: 50000,
        isAvailable: true,
        allergenTags: [] as string[],
        dietaryTags: ['vegan'],
        ingredients: ['rice'],
      })),
    };
    const menu = {
      getSearchCatalog: jest
        .fn()
        .mockImplementation(() => Promise.resolve(catalog)),
    };
    const service = new RecommendationService(
      orders as unknown as Model<Order>,
      sessions as unknown as Model<Session>,
      tables as unknown as Model<Table>,
      menu as unknown as MenuService,
    );
    return {
      service,
      catalog,
      session,
      sessionQuery,
      tableQuery,
      menu,
      orders,
      history,
    };
  }
  it('returns actual DB dishes and removes cart/missing/unavailable candidates', async () => {
    const { service, catalog } = setup();
    catalog.dishes[2].isAvailable = false;
    const result = await service.recommend(dto);
    expect(result.result.recommendations.map((r) => r.dish._id)).toEqual([b]);
    expect(result.result.recommendations[0].dish.price).toBe(50000);
  });
  it('hard excludes known allergens and never certifies unknown metadata', async () => {
    const { service, catalog } = setup();
    catalog.dishes[1].allergenTags = ['peanut'];
    const response = await service.recommend({
      ...dto,
      constraints: { excludedAllergens: ['peanut'] },
    });
    expect(response.result.recommendations.map((r) => r.dish._id)).toEqual([c]);
    expect(response.warnings.join(' ')).toContain('Không thể xác minh');
  });
  it('hard excludes dietary conflicts and unknown required metadata', async () => {
    const { service, catalog } = setup();
    catalog.dishes[1].dietaryTags = ['contains-meat'];
    catalog.dishes[2].dietaryTags = [];
    expect(
      (
        await service.recommend({
          ...dto,
          constraints: { requiredDietaryTags: ['vegan'] },
        })
      ).result.recommendations,
    ).toEqual([]);
  });
  it('applies ingredient and price constraints to popularity too', async () => {
    const { service, session } = setup();
    session.cart = [];
    expect(
      (
        await service.recommend({
          ...dto,
          constraints: { excludedIngredients: ['rice'], maxPrice: 100 },
        })
      ).result.recommendations,
    ).toEqual([]);
  });
  it.each(['absent', 'wrong-table', 'inactive'])(
    'rejects %s ownership before reading history',
    async (scenario) => {
      const { service, orders, sessionQuery, tableQuery } = setup();
      if (scenario === 'wrong-table')
        tableQuery.exec.mockResolvedValue({
          currentSessionId: new Types.ObjectId(),
        });
      else sessionQuery.exec.mockResolvedValue(null);
      await expect(service.recommend(dto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(orders.find).not.toHaveBeenCalled();
    },
  );
  it('honors authoritative merged table membership', async () => {
    const { service, sessionQuery } = setup();
    sessionQuery.exec.mockResolvedValue({
      tableId: new Types.ObjectId(),
      tableIds: [tableId],
      cart: [],
    });
    expect(
      (await service.recommend(dto)).result.recommendations.length,
    ).toBeGreaterThan(0);
    sessionQuery.exec.mockResolvedValue({
      tableId,
      tableIds: [new Types.ObjectId()],
      cart: [],
    });
    await expect(service.recommend(dto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('coalesces history, reads fresh availability and applies fresh constraints for every call', async () => {
    const { service, orders, menu, catalog } = setup();
    await Promise.all(Array.from({ length: 12 }, () => service.recommend(dto)));
    expect(orders.find).toHaveBeenCalledTimes(1);
    expect(menu.getSearchCatalog).toHaveBeenCalledTimes(12);
    catalog.dishes[1].isAvailable = false;
    catalog.dishes[2].price = 99999;
    expect(
      (await service.recommend({ ...dto, constraints: { maxPrice: 60000 } }))
        .result.recommendations,
    ).toEqual([]);
  });
  it('expires history after 30 seconds', async () => {
    const { service, orders } = setup();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000000000000);
    try {
      await service.recommend(dto);
      now.mockReturnValue(1000000030001);
      await service.recommend(dto);
      expect(orders.find).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
  it('returns bounded unavailable error and retries failed history on next request', async () => {
    const { service, history, orders } = setup();
    history.exec.mockRejectedValueOnce(new Error('private db details'));
    await expect(service.recommend(dto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await service.recommend(dto);
    expect(orders.find).toHaveBeenCalledTimes(2);
  });
  it('never calls LLM/network provider or invents a candidate', async () => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('provider unavailable'));
    try {
      const { service } = setup();
      expect(
        (await service.recommend(dto)).result.recommendations,
      ).toHaveLength(2);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it('queries only bounded completed orders and omits cancelled/pending items', async () => {
    const { service, history, orders } = setup();
    history.exec.mockResolvedValue(
      Array.from({ length: 20 }, () => ({
        items: [
          { dishId: b, status: OrderStatus.CANCELLED },
          { dishId: c, status: OrderStatus.PENDING },
        ],
      })),
    );
    expect((await service.recommend(dto)).result.recommendations).toEqual([]);
    expect(orders.find).toHaveBeenCalledWith(
      expect.objectContaining({
        status: { $in: [OrderStatus.SERVED, OrderStatus.PAID] },
      }),
    );
    expect(history.limit).toHaveBeenCalledWith(5000);
    expect(history.maxTimeMS).toHaveBeenCalledWith(5000);
  });
});
describe('Recommendation DTO', () => {
  it.each([
    { sessionId: 'bad' },
    { dishIds: ['fake'] },
    { constraints: { excludedAllergens: ['unknown'] } },
    { constraints: { requiredDietaryTags: ['halal'] } },
    { constraints: { maxPrice: -1 } },
    { constraints: { minPrice: 10, maxPrice: 1 } },
    { constraints: { minSpiceLevel: 4, maxSpiceLevel: 1 } },
    { constraints: { isAvailable: true } },
    { constraints: null },
    { constraints: { excludedIngredients: Array(13).fill('rice') } },
  ])('rejects invalid/unsupported input %j', async (input) => {
    expect(
      (
        await validate(
          plainToInstance(RecommendMenuDto, { ...dto, ...input }),
          { whitelist: true, forbidNonWhitelisted: true },
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it('accepts explicitly supported semantic constraints', async () => {
    expect(
      await validate(
        plainToInstance(RecommendMenuDto, {
          ...dto,
          constraints: {
            excludedAllergens: ['peanut'],
            requiredDietaryTags: ['vegan'],
            maxPrice: 100000,
          },
        }),
      ),
    ).toEqual([]);
  });
});
