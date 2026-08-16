import { IsMongoId, IsNotEmpty } from 'class-validator';

export class MergeSessionsDto {
  @IsMongoId()
  @IsNotEmpty()
  sourceSessionId!: string;

  @IsMongoId()
  @IsNotEmpty()
  targetSessionId!: string;
}
