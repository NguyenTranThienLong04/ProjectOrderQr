import { axiosClient } from "./axios-client";

export interface Category {
  _id: string;
  name: string;
  nameEn?: string;
  description?: string;
  sortOrder: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export const categoryApi = {
  findAll: async (includeInactive = false): Promise<Category[]> => {
    const response = await axiosClient.get<Category[]>(
      `/categories?includeInactive=${includeInactive}`,
    );
    return response.data;
  },

  findOne: async (id: string): Promise<Category> => {
    const response = await axiosClient.get<Category>(`/categories/${id}`);
    return response.data;
  },

  create: async (
    data: Omit<Category, "_id" | "createdAt" | "updatedAt">,
  ): Promise<Category> => {
    const response = await axiosClient.post<Category>("/categories", data);
    return response.data;
  },

  update: async (id: string, data: Partial<Category>): Promise<Category> => {
    const response = await axiosClient.put<Category>(`/categories/${id}`, data);
    return response.data;
  },

  remove: async (
    id: string,
  ): Promise<{ success: boolean; message: string }> => {
    const response = await axiosClient.delete<{
      success: boolean;
      message: string;
    }>(`/categories/${id}`);
    return response.data;
  },
};
