import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Category, CategoryDocument } from '../category/category.schema';
import { Dish, DishDocument } from '../dish/dish.schema';
import { Table, TableDocument } from '../table/table.schema';

@Injectable()
export class MenuService {
  constructor(
    @InjectModel(Table.name) private readonly tableModel: Model<TableDocument>,
    @InjectModel(Category.name)
    private readonly categoryModel: Model<CategoryDocument>,
    @InjectModel(Dish.name) private readonly dishModel: Model<DishDocument>,
  ) {}

  async getPublicMenu(tableId: string, lang: 'vi' | 'en' = 'vi') {
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
          .map((dish) => ({
            ...dish,
            name: lang === 'en' ? dish.nameEn?.trim() || dish.name : dish.name,
          })),
      })),
    };
  }
}
