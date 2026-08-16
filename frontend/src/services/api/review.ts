import { axiosClient } from './axios-client';
export interface ReviewableItem { dishId: string; dishName: string; reviewed: boolean; }
export const reviewApi = {
  getReviewable: async (orderId: string, sessionId: string) => (await axiosClient.get<{ orderId: string; items: ReviewableItem[] }>('/reviews/reviewable', { params: { orderId, sessionId } })).data,
  create: async (payload: { orderId: string; sessionId: string; dishId: string; rating: number; comment?: string }) => (await axiosClient.post('/reviews', payload)).data,
};
