import { Types } from 'mongoose';
import { Dish } from '../dish/dish.schema';
import {
  ingredientMatches,
  matchesMenuFilters,
  menuSearchScore,
  type MenuSearchFilters,
} from './menu-search';

describe('Phase 20 deterministic catalog predicates', () => {
  const dish: Dish = {
    name: 'Món bò không cay, không đậu phộng',
    description: 'vegan healthy',
    categoryId: new Types.ObjectId(),
    price: 100000,
    isAvailable: true,
    ingredients: ['thịt bò / beef', 'hành lá / spring onion'],
    allergenTags: ['peanut'],
    dietaryTags: ['contains-meat'],
    spiceLevel: 2,
    availableModifiers: [],
  };
  it.each<[MenuSearchFilters, boolean]>([
    [{ maxPrice: 100000 }, true],
    [{ maxPrice: 99999 }, false],
    [{ minPrice: 100000 }, true],
    [{ minPrice: 100001 }, false],
    [{ requiredIngredients: ['beef'] }, true],
    [{ requiredIngredients: ['chicken'] }, false],
    [{ excludedIngredients: ['onion'] }, false],
    [{ excludedIngredients: ['milk'] }, true],
    [{ excludedAllergens: ['peanut'] }, false],
    [{ excludedAllergens: ['milk'] }, true],
    [{ requiredDietaryTags: ['vegan'] }, false],
    [{ requiredDietaryTags: ['contains-meat'] }, true],
    [{ excludedDietaryTags: ['contains-meat'] }, false],
    [{ maxSpiceLevel: 0 }, false],
    [{ maxSpiceLevel: 2 }, true],
    [{ minSpiceLevel: 3 }, false],
    [{ minSpiceLevel: 2 }, true],
    [{ categories: ['Món nước'] }, true],
    [{ categories: ['Drinks'] }, false],
    [{ requiredIngredients: ['beef'], maxPrice: 99999 }, false],
  ])(
    'applies DB fields %j -> %s regardless of name/description',
    (filters, expected) => {
      expect(matchesMenuFilters(dish, ['Món nước', 'Soups'], filters)).toBe(
        expected,
      );
    },
  );
  it('never returns an unavailable dish', () =>
    expect(matchesMenuFilters({ ...dish, isAvailable: false }, [], {})).toBe(
      false,
    ));
  it.each<MenuSearchFilters>([
    { maxSpiceLevel: 0 },
    { minSpiceLevel: 0 },
    { requiredIngredients: ['beef'] },
    { excludedIngredients: ['peanut'] },
    { requiredDietaryTags: ['vegetarian'] },
    { excludedDietaryTags: ['contains-meat'] },
  ])('does not treat missing metadata as proof: %j', (filters) => {
    const legacy = {
      ...dish,
      ingredients: [],
      dietaryTags: [],
      spiceLevel: null,
    };
    expect(matchesMenuFilters(legacy, [], filters)).toBe(false);
  });
  it.each([
    ['hành tím / shallot', 'onion', true],
    ['đậu phộng rang / roasted peanuts', 'peanut', true],
    ['thịt bò / beef', 'bo', true],
    ['bột mì', 'bo', false],
    ['chicken', 'beef', false],
    ['coconut milk', 'milk', false],
    ['beef', '$where', false],
    ['bơ', 'beef', false],
  ])('matches ingredient language tokens %s / %s', (recorded, term, expected) =>
    expect(ingredientMatches(recorded, term)).toBe(expected),
  );
  it('ranks exact names above name substring and description, deterministically', () => {
    const exact = menuSearchScore({ name: 'Phở bò' }, ['pho bo']);
    const partial = menuSearchScore({ name: 'Phở bò đặc biệt' }, ['pho bo']);
    const prose = menuSearchScore({ name: 'Món A', description: 'Phở bò' }, [
      'pho bo',
    ]);
    expect(exact).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(prose);
    expect(menuSearchScore({ name: 'Phở bò' }, ['pho bo'])).toBe(exact);
  });
});
