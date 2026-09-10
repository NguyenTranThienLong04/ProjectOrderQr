import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Query,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { DishService } from './dish.service';
import { CreateDishDto } from './dto/create-dish.dto';
import { UpdateDishDto } from './dto/update-dish.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { DISH_METADATA_OPTIONS } from './dish-metadata';

/** Cấu hình multer dùng chung: lưu vào memory (không ghi file local), lọc định dạng ảnh */
const imageInterceptor = FileInterceptor('image', {
  storage: memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.match(/\/(jpg|jpeg|png|gif|webp)$/)) {
      return cb(
        new BadRequestException(
          'Chỉ cho phép tải lên các định dạng ảnh (jpg, jpeg, png, gif, webp)',
        ),
        false,
      );
    }
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

@Controller('dishes')
export class DishController {
  constructor(private readonly dishService: DishService) {}

  @Get()
  async findAll(
    @Query('categoryId') categoryId?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    const showAll = includeInactive === 'true';
    return this.dishService.findAll(categoryId, showAll);
  }

  @Get('metadata-options')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  metadataOptions() {
    return DISH_METADATA_OPTIONS;
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.dishService.findOne(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(imageInterceptor)
  async create(
    @Body() createDishDto: CreateDishDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.dishService.create(createDishDto, file);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(imageInterceptor)
  async update(
    @Param('id') id: string,
    @Body() updateDishDto: UpdateDishDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.dishService.update(id, updateDishDto, file);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async remove(@Param('id') id: string) {
    await this.dishService.remove(id);
    return { success: true, message: 'Xóa món ăn thành công' };
  }
}
