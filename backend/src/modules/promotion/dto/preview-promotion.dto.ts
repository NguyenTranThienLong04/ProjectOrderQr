import { IsMongoId, IsString, MaxLength, MinLength } from 'class-validator';

export class PreviewPromotionDto {
  @IsString() @MinLength(1) @MaxLength(50) code!: string;
  @IsMongoId({ message: 'tableId không hợp lệ' }) tableId!: string;
}
