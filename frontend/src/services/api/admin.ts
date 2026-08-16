import { axiosClient } from './axios-client';

export interface AnalyticsFilter {
  from?: string;
  to?: string;
  groupBy?: 'day' | 'month' | 'year';
  limit?: number;
}
export interface RevenuePoint { date: string; revenue: number; orders: number; }
export interface TopDishPoint { dishId: string; dishName: string; totalQuantity: number; revenue: number; }
export interface TopRatedDishPoint { dishId: string; dishName: string; averageRating: number; reviewCount: number; }
export interface AnalyticsOverview { totalOrders: number; ordersToday: number; occupiedTables: number; avgOrderValue: number; }

export const adminApi = {
  getRevenue: async (params?: AnalyticsFilter): Promise<RevenuePoint[]> => (await axiosClient.get<RevenuePoint[]>('/admin/analytics/revenue', { params })).data,
  getTopDishes: async (params?: AnalyticsFilter): Promise<TopDishPoint[]> => (await axiosClient.get<TopDishPoint[]>('/admin/analytics/top-dishes', { params })).data,
  getTopRatedDishes: async (): Promise<TopRatedDishPoint[]> => (await axiosClient.get<TopRatedDishPoint[]>('/admin/analytics/top-rated-dishes')).data,
  getOverview: async (): Promise<AnalyticsOverview> => (await axiosClient.get<AnalyticsOverview>('/admin/analytics/overview')).data,
};
