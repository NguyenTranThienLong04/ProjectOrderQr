import { axiosClient } from "./axios-client";
import type { Category } from "./category";

export interface Dish {
  _id: string;
  name: string;
  nameEn?: string;
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
  categoryId: Category | string;
  isAvailable: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface DishMetadataOptions {
  allergens: { value: string; label: string }[];
  dietaryTags: { value: string; label: string }[];
  modifiers: { value: string; label: string }[];
  spiceLevels: { value: number; label: string }[];
  limits: { ingredients: number; ingredientLength: number; descriptionEn: number; servingSize: number };
}

export const dishApi = {
  metadataOptions: async (): Promise<DishMetadataOptions> => {
    const response = await axiosClient.get<DishMetadataOptions>('/dishes/metadata-options');
    return response.data;
  },
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
