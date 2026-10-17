import type { OrderNoteAnalysis } from './ai';
import { axiosClient } from './axios-client';
import { downloadInvoiceBlob } from './invoice-download';

export interface KitchenItem {
  itemId: string;
  dishName: string;
  quantity: number;
  status: string;
  note?: string;
  aiNoteAnalysis?: OrderNoteAnalysis;
  rejectionReason?: string;
  rejectedAt?: string;
}

export interface KitchenOrder {
  orderId: string;
  tableId: string;
  tableCode: string;
  tableDisplayName: string;
  items: KitchenItem[];
  createdAt?: string;
}

export interface TablePaymentSummary {
  tableId: string;
  orderStatuses: string[];
  isPaid: boolean;
  canClear?: boolean;
}

export const orderApi = {
  listForKitchen: async (signal?: AbortSignal): Promise<KitchenOrder[]> => {
    const res = await axiosClient.get<KitchenOrder[]>('/orders/kitchen', { signal, timeout: 10_000 });
    return res.data;
  },
  listForWaiter: async (signal?: AbortSignal): Promise<KitchenOrder[]> => {
    const res = await axiosClient.get<KitchenOrder[]>('/orders/waiter', { signal, timeout: 10_000 });
    return res.data;
  },
  transitionItem: async (orderId: string, itemId: string, status: string, rejectionReason?: string) => {
    const res = await axiosClient.patch(`/orders/${orderId}/items/${itemId}/status`, { status, rejectionReason });
    return res.data;
  },
  listPaymentSummariesForWaiter: async (signal?: AbortSignal): Promise<TablePaymentSummary[]> => {
    const res = await axiosClient.get<TablePaymentSummary[]>('/orders/waiter/payment-summaries', { signal, timeout: 10_000 });
    return res.data;
  },
  downloadInvoice: async (orderId: string, sessionId: string) => {
    const res = await axiosClient.get(`/orders/${orderId}/invoice`, { params: { sessionId }, responseType: 'blob' });
    downloadInvoiceBlob(res.data, res.headers['content-disposition']);
  },
};
