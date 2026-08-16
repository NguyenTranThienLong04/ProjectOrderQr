import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  Min,
  IsBoolean,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateDishDto {
  @IsNotEmpty({ message: 'Tên món ăn không được để trống' })
  @IsString({ message: 'Tên món ăn phải là chuỗi ký tự' })
  name!: string;

  @IsOptional()
  @IsString({ message: 'Tên món ăn tiếng Anh phải là chuỗi ký tự' })
  nameEn?: string;

  @IsOptional()
  @IsString({ message: 'Mô tả phải là chuỗi ký tự' })
  description?: string;

  @IsNotEmpty({ message: 'Giá tiền không được để trống' })
  @Transform(({ value }) => Number(value))
  @IsNumber({}, { message: 'Giá tiền phải là số' })
  @Min(0, { message: 'Giá tiền không được nhỏ hơn 0' })
  price!: number;

  @IsNotEmpty({ message: 'Mã danh mục không được để trống' })
  @IsString({ message: 'Mã danh mục phải là chuỗi ký tự' })
  categoryId!: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  @IsBoolean({ message: 'Trạng thái món ăn phải là boolean' })
  isAvailable?: boolean;
}
