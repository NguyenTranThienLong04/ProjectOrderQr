import {
  IsString,
  IsOptional,
  IsNumber,
  Min,
  IsBoolean,
  IsMongoId,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { DishMetadataDto } from './dish-metadata.dto';

export class UpdateDishDto extends DishMetadataDto {
  @IsOptional()
  @IsString({ message: 'Tên món ăn phải là chuỗi ký tự' })
  name?: string;

  @IsOptional()
  @IsString({ message: 'Tên món ăn tiếng Anh phải là chuỗi ký tự' })
  nameEn?: string;

  @IsOptional()
  @IsString({ message: 'Mô tả phải là chuỗi ký tự' })
  description?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber({}, { message: 'Giá tiền phải là số' })
  @Min(0, { message: 'Giá tiền không được nhỏ hơn 0' })
  price?: number;

  @IsOptional()
  @IsString({ message: 'Mã danh mục phải là chuỗi ký tự' })
  @IsMongoId({ message: 'Mã danh mục không hợp lệ' })
  categoryId?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  @IsBoolean({ message: 'Trạng thái món ăn phải là boolean' })
  isAvailable?: boolean;
}
