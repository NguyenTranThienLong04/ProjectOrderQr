import {
  OrderStatus,
  OrderItemStatus,
  REJECTED_ITEM_STATUS,
} from '../../common/enums/order-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';

// Order stays Pending during item preparation; Preparing/Ready are supported
// for existing records. Paid and Cancelled have no outgoing edges.
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.SERVED, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.SERVED, OrderStatus.CANCELLED],
  [OrderStatus.READY]: [OrderStatus.SERVED, OrderStatus.CANCELLED],
  [OrderStatus.SERVED]: [OrderStatus.PAID, OrderStatus.CANCELLED],
  [OrderStatus.PAID]: [],
  [OrderStatus.CANCELLED]: [],
};

export const ITEM_TRANSITIONS: Partial<
  Record<OrderItemStatus, { to: OrderStatus; roles: readonly UserRole[] }>
> = {
  [OrderStatus.PENDING]: {
    to: OrderStatus.PREPARING,
    roles: [UserRole.KITCHEN, UserRole.ADMIN],
  },
  [OrderStatus.PREPARING]: {
    to: OrderStatus.READY,
    roles: [UserRole.KITCHEN, UserRole.ADMIN],
  },
  [OrderStatus.READY]: {
    to: OrderStatus.SERVED,
    roles: [UserRole.WAITER, UserRole.ADMIN],
  },
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus) {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export function orderSourcesFor(to: OrderStatus) {
  return Object.values(OrderStatus).filter((from) =>
    canTransitionOrder(from, to),
  );
}

export const PROCESSING_ORDER_STATUSES = orderSourcesFor(OrderStatus.SERVED);

export const TERMINAL_ITEM_STATUSES = [
  OrderStatus.SERVED,
  REJECTED_ITEM_STATUS,
] as const;

export function isFinishedItem(status: OrderItemStatus) {
  return status === OrderStatus.SERVED || status === REJECTED_ITEM_STATUS;
}

export function canRejectItem(
  orderStatus: OrderStatus,
  itemStatus: OrderItemStatus,
  role: UserRole,
) {
  return (
    role === UserRole.KITCHEN &&
    itemStatus === OrderStatus.PENDING &&
    PROCESSING_ORDER_STATUSES.includes(orderStatus)
  );
}
