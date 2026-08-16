import { IsMongoId } from 'class-validator';

export class GetActiveSessionDto {
  @IsMongoId()
  tableId!: string;
}
