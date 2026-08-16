import { IsMongoId } from 'class-validator';

export class GetReviewableOrderDto {
  @IsMongoId() orderId!: string;
  @IsMongoId() sessionId!: string;
}
