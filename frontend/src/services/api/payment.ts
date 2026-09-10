import { axiosClient } from './axios-client';
import { downloadInvoiceBlob } from './invoice-download';

export interface SessionPaymentOrderItem {
  dishName: string;
  nameEn?: string;
  imageUrl?: string;
  unitPrice: number;
  quantity: number;
  note?: string;
}

export interface SessionPaymentOrder {
  orderId: string;
  orderNumber: number;
  status: string;
  itemCount: number;
  items: SessionPaymentOrderItem[];
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
  promotionCode?: string;
  createdAt?: string;
}

export interface SessionPaymentSummary {
  sessionId: string;
  tableId: string;
  tableIds: string[];
  tableCode: string;
  sessionOrderCount: number;
  orderCount: number;
  itemCount: number;
  subtotalAmount: number;
  discountAmount: number;
  payableTotal: number;
  canPay: boolean;
  fullyPaid: boolean;
  eligibilityMessage: string;
  orders: SessionPaymentOrder[];
  payableOrders: SessionPaymentOrder[];
}

export interface PaymentStatus {
  invoiceCode?: string;
  txnRef: string;
  sessionId: string;
  status: 'pending' | 'succeeded' | 'failed';
  amount: number;
  coveredOrderIds: string[];
  completedAt?: string | null;
  transactionNo?: string;
}

export const paymentApi = {
  getSessionSummary: async (
    sessionId: string,
    tableId: string,
  ): Promise<SessionPaymentSummary> =>
    (
      await axiosClient.get<SessionPaymentSummary>('/vnpay/session-summary', {
        params: { sessionId, tableId },
      })
    ).data,

  createPaymentUrl: async (
    sessionId: string,
    tableId: string,
  ): Promise<{
    paymentUrl: string;
    txnRef: string;
    amount: number;
    coveredOrderIds: string[];
  }> =>
    (
      await axiosClient.post('/vnpay/create-payment-url', {
        sessionId,
        tableId,
      })
    ).data,

  getPaymentStatus: async (
    txnRef: string,
    sessionId: string,
    tableId: string,
  ): Promise<PaymentStatus> =>
    (
      await axiosClient.get<PaymentStatus>('/vnpay/payment-status', {
        params: { txnRef, sessionId, tableId },
      })
    ).data,

  downloadSessionInvoice: async (
    txnRef: string,
    sessionId: string,
    tableId: string,
  ) => {
    const response = await axiosClient.get('/vnpay/session-invoice', {
      params: { txnRef, sessionId, tableId },
      responseType: 'blob',
    });
    return downloadInvoiceBlob(response.data, response.headers['content-disposition']);
  },
};
