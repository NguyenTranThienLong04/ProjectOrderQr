import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PromotionType } from '../promotion-type.enum';

export class CreatePromotionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/\S/, { message: 'Mã giảm giá không được để trống' })
  code!: string;
  @IsEnum(PromotionType, { message: 'Loại giảm giá không hợp lệ' })
  type!: PromotionType;
  @IsNumber()
  @Min(0.01, { message: 'Giá trị giảm phải lớn hơn 0' })
  value!: number;
  @IsNumber()
  @Min(0, { message: 'Giá trị đơn tối thiểu không được âm' })
  minOrderAmount!: number;
  @IsDateString({}, { message: 'Ngày bắt đầu không hợp lệ' })
  startDate!: string;
  @IsDateString({}, { message: 'Ngày kết thúc không hợp lệ' }) endDate!: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @Type(() => Number)
  @IsInt({ message: 'Giới hạn lượt dùng phải là số nguyên' })
  @Min(1, { message: 'Giới hạn lượt dùng phải ít nhất là 1' })
  usageLimit!: number;
}
