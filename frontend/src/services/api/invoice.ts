import { axiosClient } from './axios-client';
import { downloadInvoiceBlob } from './invoice-download';

export const invoiceCodePattern = /^INV-\d{8}-[A-HJ-NP-Z2-9]{8}$/;
export interface InvoiceDetail {
  invoiceCode: string;
  paymentStatus: 'pending' | 'succeeded' | 'failed' | 'provider_rejected' | 'superseded';
  paymentMethod?: 'vnpay' | 'internal_zero' | 'CASH';
  replacementInvoiceCode?: string;
  reconciliationRequired?: boolean;
  paidAt: string | null;
  settledByName?: string;
  table: { displayName: string };
  vnpTransactionNo?: string;
  orders: {
    sequence: number;
    items: { name: string; nameEn?: string; quantity: number; unitPrice: number; note?: string; status?: string; rejectionReason?: string; chargedAmount?: number }[];
    subtotalAmount: number;
    discountAmount: number;
    promotionCode?: string;
    totalAmount: number;
  }[];
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
}

export interface RecentCashInvoice {
  invoiceCode: string;
  amount: number;
  paidAt: string | null;
  table: { displayName: string };
}

export const invoiceApi = {
  async recentCash(): Promise<RecentCashInvoice[]> {
    return (await axiosClient.get<RecentCashInvoice[]>('/admin/invoices')).data;
  },
  async lookup(invoiceCode: string, signal?: AbortSignal): Promise<InvoiceDetail> {
    return (await axiosClient.get<InvoiceDetail>(`/admin/invoices/${encodeURIComponent(invoiceCode)}`, { signal })).data;
  },
  async download(invoiceCode: string) {
    const response = await axiosClient.get(`/admin/invoices/${encodeURIComponent(invoiceCode)}/pdf`, { responseType: 'blob' });
    downloadInvoiceBlob(response.data, response.headers['content-disposition']);
  },
};
