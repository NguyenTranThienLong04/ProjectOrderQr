import { IsIn, IsString, Length, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import {
  ORDER_ITEM_STATUSES,
  type OrderItemStatus,
  REJECTED_ITEM_STATUS,
} from '../../../common/enums/order-status.enum';
export class TransitionOrderItemDto {
  @IsIn(ORDER_ITEM_STATUSES) status!: OrderItemStatus;

  @ValidateIf(
    (dto: TransitionOrderItemDto) => dto.status === REJECTED_ITEM_STATUS,
  )
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 250)
  rejectionReason?: string;
}
