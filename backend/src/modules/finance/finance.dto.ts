import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page = 1;
}

export class RevenueQuery extends PageQuery {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsIn(['CASH', 'VNPAY'])
  paymentMethod?: 'CASH' | 'VNPAY';

  @IsOptional()
  @IsMongoId()
  staffId?: string;
}

export class ShiftQuery extends PageQuery {
  @IsOptional()
  @IsIn(['OPEN', 'CLOSED'])
  status?: 'OPEN' | 'CLOSED';

  @IsOptional()
  @IsMongoId()
  staffId?: string;
}

export class ShiftParams {
  @IsMongoId()
  id!: string;
}

export class OpenShiftDto {
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  openingCash!: number;
}

export class CloseShiftDto {
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  actualCash!: number;

  // Supplied by the UI from the preview; never a user-entered cash amount.
  @IsInt()
  @Min(0)
  version!: number;
}
