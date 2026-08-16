import { IsMongoId, IsNotEmpty } from 'class-validator';

export class MoveSessionDto {
  @IsMongoId()
  @IsNotEmpty()
  newTableId!: string;
}
