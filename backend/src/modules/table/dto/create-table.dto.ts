import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsInt,
  Min,
  IsEnum,
} from 'class-validator';
import { TableStatus } from '../../../common/enums/table-status.enum';

export class CreateTableDto {
  @IsNotEmpty({ message: 'Mã bàn không được để trống' })
  @IsString({ message: 'Mã bàn phải là chuỗi ký tự' })
  tableCode!: string;

  @IsOptional()
  @IsInt({ message: 'Sức chứa phải là số nguyên' })
  @Min(1, { message: 'Sức chứa tối thiểu là 1 người' })
  capacity?: number;

  @IsOptional()
  @IsEnum(TableStatus, { message: 'Trạng thái bàn không hợp lệ' })
  status?: TableStatus;
}
