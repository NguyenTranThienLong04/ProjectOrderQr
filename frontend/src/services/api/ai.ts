import { axiosClient } from "./axios-client";
import type { PublicDish } from './menu';

export interface MenuSearchFilters {
  minPrice?: number;
  maxPrice?: number;
  categories?: string[];
  requiredIngredients?: string[];
  excludedIngredients?: string[];
  requiredDietaryTags?: string[];
  excludedDietaryTags?: string[];
  excludedAllergens?: string[];
  minSpiceLevel?: number;
  maxSpiceLevel?: number;
  keywords?: string[];
}
export interface MenuSearchResponse {
  result: { dishes: (PublicDish & { categoryId: string })[]; appliedFilters: MenuSearchFilters };
  warnings: string[];
  modelVersion: string;
  fallbackUsed: boolean;
}

export const dishDraftFields = [
  "nameEn",
  "description",
  "descriptionEn",
] as const;
export type DishDraftField = (typeof dishDraftFields)[number];
export type DishDraftResult = Partial<Record<DishDraftField, string>>;
export interface DishDraftInput {
  name: string;
  nameEn?: string;
  description?: string;
  descriptionEn?: string;
  categoryId?: string;
  generateFields: DishDraftField[];
}
export interface DishDraftResponse {
  result: DishDraftResult;
  warnings: string[];
  modelVersion: string;
  fallbackUsed: boolean;
}

export const aiApi = {
  queryAnalytics: async (input: { query: string; fromDate?: string; toDate?: string }, signal?: AbortSignal): Promise<AnalyticsCopilotResponse> =>
    (await axiosClient.post<AnalyticsCopilotResponse>('/ai/admin/analytics/query', input, { signal, timeout: 380000 })).data,
  searchMenu: async (input: { tableId: string; query: string; lang: 'vi' | 'en' }, signal?: AbortSignal): Promise<MenuSearchResponse> =>
    (await axiosClient.post<MenuSearchResponse>('/ai/menu/search', input, { signal, timeout: 190000 })).data,
  analyzeOrderNote: async (input: { sessionId: string; tableId: string; dishId: string; note: string }, signal?: AbortSignal): Promise<OrderNoteResponse> =>
    (await axiosClient.post<OrderNoteResponse>('/ai/order-notes/analyze', input, { signal, timeout: 190000 })).data,
  dishDraft: async (
    input: DishDraftInput,
    signal?: AbortSignal,
  ): Promise<DishDraftResponse> => {
    const response = await axiosClient.post<DishDraftResponse>(
      "/ai/admin/dish-draft",
      input,
      { signal, timeout: 190000 },
    );
    return response.data;
  },
};

export interface AnalyticsCopilotResponse {
  result: { answer: string };
  facts: {
    id: string; metric: string; label: string; value: number | null;
    unit: 'VND' | 'orders' | 'items' | 'reviews' | 'stars' | 'percent' | 'rank';
    period: { from: string; to: string; timezone: 'UTC' };
    comparisonPeriod?: { from: string; to: string; timezone: 'UTC' };
    dishName?: string;
  }[];
  warnings: string[];
  modelVersion: string;
  fallbackUsed: boolean;
}

export interface OrderNoteAnalysis {
  summary: string;
  modifierTags: string[];
  allergyMentioned: boolean;
  warnings: string[];
  modelVersion: string;
  fallbackUsed: boolean;
  confirmedByCustomer: boolean;
}
export interface OrderNoteResponse {
  result: Pick<OrderNoteAnalysis, 'summary' | 'modifierTags' | 'allergyMentioned'>;
  warnings: string[];
  modelVersion: string;
  fallbackUsed: boolean;
  analysisToken: string;
}
