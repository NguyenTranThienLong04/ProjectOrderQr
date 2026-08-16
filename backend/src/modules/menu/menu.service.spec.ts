import { NotFoundException } from '@nestjs/common';
import { MenuService } from './menu.service';

const chain = <T>(value: T) => ({
  sort: jest.fn().mockReturnThis(),
  lean: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(value),
});

describe('MenuService', () => {
  const table = { _id: 'table-1', id: 'table-1', tableCode: 'A01' };
  const categoryLegacy = {
    _id: 'category-legacy',
    name: 'Món chính',
    isActive: true,
    sortOrder: 0,
  };
  const categoryTranslated = {
    _id: 'category-en',
    name: 'Đồ uống',
    nameEn: 'Drinks',
    isActive: true,
    sortOrder: 1,
  };
  const dishLegacy = {
    _id: 'dish-legacy',
    name: 'Phở bò',
    categoryId: 'category-legacy',
    isAvailable: true,
  };
  const dishTranslated = {
    _id: 'dish-en',
    name: 'Cà phê sữa',
    nameEn: 'Milk coffee',
    categoryId: 'category-en',
    isAvailable: true,
  };

  const createService = (existingTable = table) => {
    const tableModel = {
      findById: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(existingTable) }),
    };
    const categoryModel = {
      find: jest
        .fn()
        .mockReturnValue(chain([categoryLegacy, categoryTranslated])),
    };
    const dishModel = {
      find: jest.fn().mockReturnValue(chain([dishLegacy, dishTranslated])),
    };
    return {
      service: new MenuService(
        tableModel as never,
        categoryModel as never,
        dishModel as never,
      ),
      categoryModel,
      dishModel,
    };
  };

  it('loads legacy documents for Vietnamese and English without changing their names', async () => {
    const { service } = createService();

    const vietnamese = await service.getPublicMenu('table-1', 'vi');
    const english = await service.getPublicMenu('table-1', 'en');

    expect(vietnamese.categories[0].name).toBe('Món chính');
    expect(vietnamese.categories[0].dishes[0].name).toBe('Phở bò');
    expect(english.categories[0].name).toBe('Món chính');
    expect(english.categories[0].dishes[0].name).toBe('Phở bò');
  });

  it('uses English names where present and falls back per category and dish where absent', async () => {
    const { service } = createService();

    const menu = await service.getPublicMenu('table-1', 'en');

    expect(menu.categories[1].name).toBe('Drinks');
    expect(menu.categories[1].dishes[0].name).toBe('Milk coffee');
    expect(menu.categories[0].name).not.toBeNull();
    expect(menu.categories[0].dishes[0].name).not.toBe('');
  });

  it('returns the established not-found error for an unknown table', async () => {
    const { service } = createService(null);
    await expect(service.getPublicMenu('missing', 'en')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
