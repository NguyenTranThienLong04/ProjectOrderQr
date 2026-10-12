import type { OrderNoteAnalysis } from './ai';
import { axiosClient } from "./axios-client";
import { customerEntryHeaders, customerToken, saveCustomerGrant, SessionScopeError, type CustomerGrant } from '../customer-access';

export interface PublicDish {
  _id: string;
  name: string;
  description?: string;
  descriptionEn?: string;
  ingredients?: string[];
  allergenTags?: string[];
  dietaryTags?: string[];
  spiceLevel?: number | null;
  servingSize?: string;
  availableModifiers?: string[];
  price: number;
  imageUrl?: string;
  isAvailable: boolean;
}

export interface PublicMenuCategory {
  _id: string;
  id: string;
  name: string;
  description?: string;
  dishes: PublicDish[];
}

export interface PublicMenu {
  table: { id: string; tableCode: string };
  categories: PublicMenuCategory[];
}

export interface CreateOrderPayload {
  tableId: string;
  sessionId: string;
  cartVersion: number;
  idempotencyKey: string;
  promotionCode?: string;
}

export interface SharedCartItem {
  cartItemId: string;
  dishId: string;
  dishName: string;
  unitPrice: number;
  quantity: number;
  note?: string;
  aiNoteAnalysis?: OrderNoteAnalysis;
}

export interface SharedCart {
  sessionId: string;
  tableId: string;
  version: number;
  cart: SharedCartItem[];
  currentOrder?: {
    orderId: string;
    status: string;
    subtotalAmount: number;
    discountAmount: number;
    totalAmount: number;
    promotionCode?: string;
  } | null;
}

export interface CreatedOrder {
  orderId: string;
  sessionId: string;
  tableId: string;
  status: string;
  totalAmount: number;
  subtotalAmount: number;
  discountAmount: number;
  promotionCode?: string;
  createdAt: string;
}

export const menuApi = {
  get: async (
    tableId: string,
    lang: "vi" | "en" = "vi",
    signal?: AbortSignal,
  ): Promise<PublicMenu> => {
    const response = await axiosClient.get<PublicMenu>("/menu", {
      params: { tableId, lang },
      signal, timeout: 10_000,
    });
    return response.data;
  },
  getActiveSession: async (tableId: string, sessionId?: string, signal?: AbortSignal): Promise<SharedCart> => {
    const previousToken = sessionId ? customerToken(sessionId, tableId) : '';
    const response = await axiosClient.get<SharedCart & CustomerGrant>("/sessions/active", {
      params: { tableId, sessionId },
      headers: customerEntryHeaders(tableId),
      skipAuthRefresh: true,
      signal, timeout: 10_000,
    });
    if (sessionId && response.data.sessionId !== sessionId) throw new SessionScopeError();
    // A cancelled read or newer Socket grant must not replace current auth scope.
    if (!signal?.aborted && (!sessionId || customerToken(sessionId, tableId) === previousToken)) {
      saveCustomerGrant(response.data);
    }
    return response.data;
  },
  createOrder: async (payload: CreateOrderPayload): Promise<CreatedOrder> => {
    const response = await axiosClient.post<CreatedOrder>("/orders", payload);
    return response.data;
  },
};
