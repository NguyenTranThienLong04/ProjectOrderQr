import { REJECTED_ITEM_STATUS } from '../../common/enums/order-status.enum';

export function itemCharge(item: {
  status?: string;
  unitPrice: number;
  quantity: number;
}): number {
  return item.status === REJECTED_ITEM_STATUS
    ? 0
    : item.unitPrice * item.quantity;
}

export function billableSubtotal(
  items: Parameters<typeof itemCharge>[0][],
): number {
  return items.reduce((sum, item) => sum + itemCharge(item), 0);
}
