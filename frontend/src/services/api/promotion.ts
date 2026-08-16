import { axiosClient } from './axios-client';

export type PromotionType = 'percentage' | 'fixed_amount';
export interface Promotion { _id: string; code: string; type: PromotionType; value: number; minOrderAmount: number; startDate: string; endDate: string; isActive: boolean; usageLimit: number; usedCount: number; }
export interface PromotionPreview { code: string; subtotalAmount: number; discountAmount: number; totalAmount: number; }
export type PromotionPayload = Omit<Promotion, '_id' | 'usedCount'>;

export const promotionApi = {
  findAll: async () => (await axiosClient.get<Promotion[]>('/promotions')).data,
  create: async (payload: PromotionPayload) => (await axiosClient.post<Promotion>('/promotions', payload)).data,
  update: async (id: string, payload: Partial<PromotionPayload>) => (await axiosClient.put<Promotion>(`/promotions/${id}`, payload)).data,
  remove: async (id: string) => (await axiosClient.delete<{ success: boolean }>(`/promotions/${id}`)).data,
  preview: async (code: string, tableId: string) => (await axiosClient.post<PromotionPreview>('/promotions/preview', { code, tableId })).data,
};
