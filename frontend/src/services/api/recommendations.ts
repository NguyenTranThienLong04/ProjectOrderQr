import { axiosClient } from './axios-client';
import type { MenuSearchFilters } from './ai';
import type { PublicDish } from './menu';

export type RecommendationConstraints = Omit<MenuSearchFilters, 'keywords'>;
export interface RecommendationResponse {
  result: {
    recommendations: { dish: PublicDish; reason: 'frequently_bought_together' | 'popular'; evidence: { sampleSize: number; anchorCount: number; pairCount: number; confidence: number; support: number; basketCount: number } }[];
    cartDishIds: string[];
    sampleSize: number;
  };
  warnings: string[];
}
export const recommendationsApi = {
  get: async (input: { sessionId: string; tableId: string; lang: 'vi' | 'en'; constraints: RecommendationConstraints }, signal: AbortSignal): Promise<RecommendationResponse> => {
    const response = (await axiosClient.post<RecommendationResponse>('/menu/recommendations', input, { signal, timeout: 10000 })).data;
    // An upstream HTML/error response must remain a recommendation error, never a page crash.
    if (!response?.result || !Array.isArray(response.result.recommendations) || !Array.isArray(response.warnings) ||
      !response.warnings.every(warning => typeof warning === 'string') ||
      !response.result.recommendations.every(item => item && ['popular', 'frequently_bought_together'].includes(item.reason) &&
        item.dish && typeof item.dish._id === 'string' && typeof item.dish.name === 'string' &&
        typeof item.dish.isAvailable === 'boolean' && Number.isFinite(item.dish.price))) throw new Error('Invalid recommendation response');
    return response;
  },
};
