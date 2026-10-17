export enum OrderStatus {
  PENDING = 'Pending',
  PREPARING = 'Preparing',
  READY = 'Ready',
  SERVED = 'Served',
  PAID = 'Paid',
  CANCELLED = 'Cancelled',
}

// Rejection is an item outcome, never an aggregate Order status.
export const REJECTED_ITEM_STATUS = 'Rejected' as const;
export type OrderItemStatus = OrderStatus | typeof REJECTED_ITEM_STATUS;
export const ORDER_ITEM_STATUSES = [
  ...Object.values(OrderStatus),
  REJECTED_ITEM_STATUS,
];
