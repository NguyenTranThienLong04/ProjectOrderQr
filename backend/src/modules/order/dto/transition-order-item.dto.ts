import { IsEnum } from 'class-validator';
import { OrderStatus } from '../../../common/enums/order-status.enum';
export class TransitionOrderItemDto {
  @IsEnum(OrderStatus) status!: OrderStatus;
}
