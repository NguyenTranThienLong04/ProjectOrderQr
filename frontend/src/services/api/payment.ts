import { axiosClient } from './axios-client';

export interface SessionPaymentOrder {
  orderId: string;
  orderNumber: number;
  status: string;
  itemCount: number;
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
    const url = URL.createObjectURL(response.data);
    const link = document.createElement('a');
    link.href = url;
    link.download = `session-invoice-${txnRef}.pdf`;
    link.click();
    URL.revokeObjectURL(url);
  },
};
