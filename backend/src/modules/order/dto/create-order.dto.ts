import { IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateOrderDto {
  @IsMongoId()
  tableId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  promotionCode?: string;
}
