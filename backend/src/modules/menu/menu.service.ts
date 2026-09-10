import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Category, CategoryDocument } from '../category/category.schema';
import { Dish, DishDocument } from '../dish/dish.schema';
import { Table, TableDocument } from '../table/table.schema';
import {
  matchesMenuFilters,
  menuSearchScore,
  searchWarnings,
  type MenuSearchFilters,
} from './menu-search';

@Injectable()
export class MenuService {
  constructor(
    @InjectModel(Table.name) private readonly tableModel: Model<TableDocument>,
    @InjectModel(Category.name)
    private readonly categoryModel: Model<CategoryDocument>,
    @InjectModel(Dish.name) private readonly dishModel: Model<DishDocument>,
  ) {}

  async getSearchCatalog(tableId: string) {
    const table = await this.tableModel.findById(tableId).exec();
    if (!table) throw new NotFoundException('Không tìm thấy bàn');
    const categories = await this.categoryModel
      .find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .lean()
      .exec();
    const dishes = await this.dishModel
      .find({
        isAvailable: true,
        categoryId: { $in: categories.map((category) => category._id) },
      })
      .sort({ name: 1 })
      .lean()
      .exec();
    return { table, categories, dishes };
  }

  async searchPublicMenu(
    tableId: string,
    filters: MenuSearchFilters,
    query: string,
    lang: 'vi' | 'en',
    fallback = false,
  ) {
    // Read again after the provider finishes: availability/price may have changed.
    // Never accept a Mongo predicate, projection, ID list or pipeline from AI.
    const { categories, dishes } = await this.getSearchCatalog(tableId);
    const warnings: string[] = [];
    const messages = searchWarnings(lang);
    if (filters.excludedAllergens?.length) warnings.push(messages.allergy);
    if (
      dishes.some(
        (dish) =>
          ((filters.requiredIngredients?.length ||
            filters.excludedIngredients?.length) &&
            !dish.ingredients?.length) ||
          ((filters.requiredDietaryTags?.length ||
            filters.excludedDietaryTags?.length) &&
            !dish.dietaryTags?.length) ||
          ((filters.minSpiceLevel !== undefined ||
            filters.maxSpiceLevel !== undefined) &&
            dish.spiceLevel == null),
      )
    )
      warnings.push(messages.metadata);
    const ranked = dishes
      .filter((dish) => {
        if (fallback)
          return (lang === 'en' ? dish.nameEn?.trim() || dish.name : dish.name)
            .toLowerCase()
            .includes(query.trim().toLowerCase());
        const category = categories.find(
          (item) => item._id.toString() === dish.categoryId.toString(),
        );
        return matchesMenuFilters(
          dish,
          [category?.name ?? '', category?.nameEn ?? ''],
          filters,
        );
      })
      .map((dish) => ({
        dish,
        score: menuSearchScore(dish, filters.keywords ?? []),
      }))
      .filter(({ score }) => fallback || !filters.keywords?.length || score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.dish.name.localeCompare(b.dish.name, 'vi') ||
          a.dish._id.toString().localeCompare(b.dish._id.toString()),
      );
    return {
      result: {
        dishes: ranked.map(({ dish }) => this.localizeDish(dish, lang)),
        appliedFilters: filters,
      },
      warnings,
    };
  }

  private localizeDish<T extends Dish>(dish: T, lang: 'vi' | 'en') {
    return {
      ...dish,
      name: lang === 'en' ? dish.nameEn?.trim() || dish.name : dish.name,
      description:
        lang === 'en'
          ? dish.descriptionEn?.trim() || dish.description
          : dish.description,
      ingredients: dish.ingredients ?? [],
      allergenTags: dish.allergenTags ?? [],
      dietaryTags: dish.dietaryTags ?? [],
      availableModifiers: dish.availableModifiers ?? [],
    };
  }

  async getPublicMenu(tableId: string, lang: 'vi' | 'en' = 'vi') {
    const { table, categories, dishes } = await this.getSearchCatalog(tableId);
    return {
      table: { id: table.id, tableCode: table.tableCode },
      categories: categories.map((category) => ({
        ...category,
        // `name` always remains a string for existing consumers. Old Atlas
        // documents have no nameEn, so English deliberately falls back to Vietnamese.
        name:
          lang === 'en'
            ? category.nameEn?.trim() || category.name
            : category.name,
        id: category._id.toString(),
        dishes: dishes
          .filter(
            (dish) => dish.categoryId.toString() === category._id.toString(),
          )
          .map((dish) => this.localizeDish(dish, lang)),
      })),
    };
  }
}
