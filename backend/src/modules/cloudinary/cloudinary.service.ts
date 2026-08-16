import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';

@Injectable()
export class CloudinaryService {
  constructor(private readonly configService: ConfigService) {
    // Cấu hình Cloudinary từ .env — KHÔNG hardcode key
    cloudinary.config({
      cloud_name: this.configService.getOrThrow<string>(
        'CLOUDINARY_CLOUD_NAME',
      ),
      api_key: this.configService.getOrThrow<string>('CLOUDINARY_API_KEY'),
      api_secret: this.configService.getOrThrow<string>(
        'CLOUDINARY_API_SECRET',
      ),
    });
  }

  /**
   * Upload buffer lên Cloudinary qua stream (không cần lưu file tạm trên đĩa).
   * @param buffer   Buffer dữ liệu file ảnh
   * @param folder   Thư mục Cloudinary đích (VD: "restaurant/dishes")
   * @param publicId Public ID tùy chọn; nếu undefined, Cloudinary tự sinh
   */
  uploadBuffer(
    buffer: Buffer,
    folder: string,
    publicId?: string,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder, public_id: publicId, resource_type: 'image' },
        (error, result) => {
          if (error) {
            reject(
              new InternalServerErrorException(
                `Cloudinary upload thất bại: ${error.message}`,
              ),
            );
          } else {
            resolve(result as UploadApiResponse);
          }
        },
      );

      Readable.from(buffer).pipe(uploadStream);
    });
  }

  /**
   * Xóa ảnh trên Cloudinary theo publicId.
   * @param publicId  VD: "restaurant/dishes/abc123"
   */
  async deleteByPublicId(publicId: string): Promise<void> {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  }

  /**
   * Trích xuất publicId từ secure_url Cloudinary trả về.
   * VD: "https://res.cloudinary.com/xxx/image/upload/v1/restaurant/dishes/abc123.jpg"
   * → "restaurant/dishes/abc123"
   */
  extractPublicId(secureUrl: string): string | null {
    try {
      // Tìm đoạn sau "/upload/v<version>/" hoặc "/upload/"
      const match = secureUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }
}
