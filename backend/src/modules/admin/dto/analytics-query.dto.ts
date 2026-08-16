import { IsEnum, IsOptional, IsString, IsNumberString } from 'class-validator';
import { Type } from 'class-transformer';

export type GroupBy = 'day' | 'month' | 'year';

export class RevenueQueryDto {
  @IsOptional()
  @IsString()
  from?: string; // ISO date

  @IsOptional()
  @IsString()
  to?: string; // ISO date

  @IsOptional()
  @IsEnum(['day', 'month', 'year'])
  groupBy?: GroupBy = 'day';
}

export class TopDishesQueryDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsNumberString()
  limit?: string; // will be parsed as number in controller
}
