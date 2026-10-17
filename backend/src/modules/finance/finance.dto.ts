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
  @IsIn(['OPEN', 'PENDING_REVIEW', 'CLOSED'])
  status?: 'OPEN' | 'PENDING_REVIEW' | 'CLOSED';

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

export class SubmitShiftDto {
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  declaredCash!: number;

  // Opaque concurrency token; the blind count response contains no cash totals.
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;
}

export class VerifyShiftDto {
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  verifiedCash!: number;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;
}
