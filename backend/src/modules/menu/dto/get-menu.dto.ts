import { IsIn, IsMongoId, IsOptional } from 'class-validator';

export class GetMenuDto {
  @IsMongoId()
  tableId!: string;

  @IsOptional()
  @IsIn(['vi', 'en'], { message: 'Ngôn ngữ chỉ hỗ trợ vi hoặc en' })
  lang?: 'vi' | 'en';
}
