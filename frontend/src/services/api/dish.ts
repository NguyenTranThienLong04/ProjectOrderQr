import { axiosClient } from "./axios-client";
import type { Category } from "./category";

export interface Dish {
  _id: string;
  name: string;
  nameEn?: string;
  description?: string;
  price: number;
  imageUrl?: string;
  categoryId: Category | string;
  isAvailable: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export const dishApi = {
  findAll: async (
    categoryId?: string,
    includeInactive = false,
  ): Promise<Dish[]> => {
    let url = `/dishes?includeInactive=${includeInactive}`;
    if (categoryId) {
      url += `&categoryId=${categoryId}`;
    }
    const response = await axiosClient.get<Dish[]>(url);
    return response.data;
  },

  findOne: async (id: string): Promise<Dish> => {
    const response = await axiosClient.get<Dish>(`/dishes/${id}`);
    return response.data;
  },

  create: async (formData: FormData): Promise<Dish> => {
    const response = await axiosClient.post<Dish>("/dishes", formData, {
      headers: {
        "Content-Type": "multipart/form-data",
      },
    });
    return response.data;
  },

  update: async (id: string, formData: FormData): Promise<Dish> => {
    const response = await axiosClient.put<Dish>(`/dishes/${id}`, formData, {
      headers: {
        "Content-Type": "multipart/form-data",
      },
    });
    return response.data;
  },

  remove: async (
    id: string,
  ): Promise<{ success: boolean; message: string }> => {
    const response = await axiosClient.delete<{
      success: boolean;
      message: string;
    }>(`/dishes/${id}`);
    return response.data;
  },
};
