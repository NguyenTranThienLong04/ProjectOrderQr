import { IsMongoId, IsNotEmpty, IsOptional, ValidateIf } from 'class-validator';

export class UnmergeSessionDto {
  /** Existing clients may identify the merged child directly. */
  @IsOptional()
  @IsMongoId()
  childSessionId?: string;

  /** Selects the exact original table to restore from a merged group. */
  @ValidateIf((dto: UnmergeSessionDto) => !dto.childSessionId)
  @IsMongoId()
  @IsNotEmpty()
  tableId?: string;
}
