import { Module } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service';

/**
 * CloudinaryModule — Module dùng chung cho toàn ứng dụng.
 * Export CloudinaryService để các module khác (Dish, ...) inject được.
 * Không cần forRoot/forFeature vì cấu hình đọc trực tiếp từ ConfigService (global).
 */
@Module({
  providers: [CloudinaryService],
  exports: [CloudinaryService],
})
export class CloudinaryModule {}
