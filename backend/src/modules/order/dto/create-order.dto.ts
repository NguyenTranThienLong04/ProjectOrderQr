import {
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateOrderDto {
  @IsMongoId()
  tableId!: string;

  @IsMongoId()
  sessionId!: string;

  @IsInt()
  @Min(0)
  cartVersion!: number;

  @IsString()
  @Matches(/^\S+$/)
  @MaxLength(128)
  idempotencyKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  promotionCode?: string;
}
