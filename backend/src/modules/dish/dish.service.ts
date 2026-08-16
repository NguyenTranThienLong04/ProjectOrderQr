import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Dish, DishDocument } from './dish.schema';
import { CreateDishDto } from './dto/create-dish.dto';
import { UpdateDishDto } from './dto/update-dish.dto';
import { CloudinaryService } from '../cloudinary/cloudinary.service';

/** Folder trên Cloudinary chứa ảnh món ăn */
const CLOUDINARY_FOLDER = 'restaurant/dishes';

@Injectable()
export class DishService {
  constructor(
    @InjectModel(Dish.name) private readonly dishModel: Model<DishDocument>,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  /**
   * Upload ảnh lên Cloudinary nếu có file mới, trả về secure_url.
   * Trả undefined nếu không có file (giữ nguyên ảnh cũ).
   */
  private async uploadImageIfPresent(
    file?: Express.Multer.File,
  ): Promise<string | undefined> {
    if (!file) return undefined;
    const result = await this.cloudinaryService.uploadBuffer(
      file.buffer,
      CLOUDINARY_FOLDER,
    );
    return result.secure_url;
  }

  /**
   * Xóa ảnh cũ trên Cloudinary nếu imageUrl là Cloudinary URL.
   * Bỏ qua nếu là URL local cũ (đường dẫn /uploads/...) để tránh lỗi.
   */
  private async deleteOldCloudinaryImage(imageUrl?: string): Promise<void> {
    if (!imageUrl) return;
    // Chỉ xóa nếu URL thuộc Cloudinary (an toàn với dữ liệu cũ lưu local)
    if (!imageUrl.includes('res.cloudinary.com')) return;
    const publicId = this.cloudinaryService.extractPublicId(imageUrl);
    if (publicId) {
      await this.cloudinaryService.deleteByPublicId(publicId).catch((err) => {
        // Không throw — xóa ảnh cũ thất bại không nên chặn thao tác chính
        console.warn(`[DishService] Không thể xóa ảnh Cloudinary cũ: ${err}`);
      });
    }
  }

  async create(
    createDishDto: CreateDishDto,
    file?: Express.Multer.File,
  ): Promise<DishDocument> {
    const imageUrl = await this.uploadImageIfPresent(file);
    const createdDish = new this.dishModel({
      ...createDishDto,
      categoryId: new Types.ObjectId(createDishDto.categoryId),
      imageUrl,
    });
    return (await createdDish.save()).populate('categoryId');
  }

  async findAll(
    categoryId?: string,
    includeInactive = false,
  ): Promise<DishDocument[]> {
    const filter: Record<string, unknown> = {};
    if (!includeInactive) {
      filter.isAvailable = true;
    }
    if (categoryId) {
      filter.categoryId = new Types.ObjectId(categoryId);
    }
    return this.dishModel.find(filter).populate('categoryId').exec();
  }

  async findOne(id: string): Promise<DishDocument> {
    const dish = await this.dishModel
      .findById(id)
      .populate('categoryId')
      .exec();
    if (!dish) {
      throw new NotFoundException(`Không tìm thấy món ăn với ID ${id}`);
    }
    return dish;
  }

  async update(
    id: string,
    updateDishDto: UpdateDishDto,
    file?: Express.Multer.File,
  ): Promise<DishDocument> {
    const currentDish = await this.findOne(id);
    const updateData: Record<string, unknown> = { ...updateDishDto };

    if (updateDishDto.categoryId) {
      updateData.categoryId = new Types.ObjectId(updateDishDto.categoryId);
    }

    if (file) {
      // Upload ảnh mới lên Cloudinary
      const newImageUrl = await this.uploadImageIfPresent(file);
      updateData.imageUrl = newImageUrl;
      // Xóa ảnh cũ trên Cloudinary (nếu có và là Cloudinary URL)
      await this.deleteOldCloudinaryImage(currentDish.imageUrl);
    }

    const updatedDish = await this.dishModel
      .findByIdAndUpdate(id, updateData, { new: true })
      .populate('categoryId')
      .exec();

    if (!updatedDish) {
      throw new NotFoundException(`Không tìm thấy món ăn với ID ${id}`);
    }
    return updatedDish;
  }

  async remove(id: string): Promise<void> {
    const dish = await this.findOne(id);
    // Xóa ảnh trên Cloudinary nếu là Cloudinary URL
    await this.deleteOldCloudinaryImage(dish.imageUrl);
    await this.dishModel.findByIdAndDelete(id).exec();
  }
}
