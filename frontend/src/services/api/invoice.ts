import { axiosClient } from './axios-client';
import { downloadInvoiceBlob } from './invoice-download';

export const invoiceCodePattern = /^INV-\d{8}-[A-HJ-NP-Z2-9]{8}$/;
export interface InvoiceDetail {
  invoiceCode: string;
  paymentStatus: 'pending' | 'succeeded' | 'failed';
  paidAt: string | null;
  table: { displayName: string };
  vnpTransactionNo?: string;
  orders: {
    sequence: number;
    items: { name: string; nameEn?: string; quantity: number; unitPrice: number; note?: string }[];
    subtotalAmount: number;
    discountAmount: number;
    totalAmount: number;
  }[];
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
}

export const invoiceApi = {
  async lookup(invoiceCode: string): Promise<InvoiceDetail> {
    return (await axiosClient.get<InvoiceDetail>(`/admin/invoices/${encodeURIComponent(invoiceCode)}`)).data;
  },
  async download(invoiceCode: string) {
    const response = await axiosClient.get(`/admin/invoices/${encodeURIComponent(invoiceCode)}/pdf`, { responseType: 'blob' });
    downloadInvoiceBlob(response.data, response.headers['content-disposition']);
  },
};
