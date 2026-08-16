import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  ValidateIf,
} from 'class-validator';

export class MergeTablesDto {
  /** Preferred API: [rootTableId, sourceTableId]. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsMongoId({ each: true })
  tableIds?: string[];

  /** Backwards-compatible explicit source/target fields. */
  @ValidateIf((dto: MergeTablesDto) => !dto.tableIds)
  @IsMongoId()
  @IsNotEmpty()
  sourceTableId?: string;

  @ValidateIf((dto: MergeTablesDto) => !dto.tableIds)
  @IsMongoId()
  @IsNotEmpty()
  targetTableId?: string;
}
