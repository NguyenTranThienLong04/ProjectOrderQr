import { axiosClient } from './axios-client';
export type ReviewSentiment = 'positive' | 'neutral' | 'negative' | 'mixed';
export type ReviewTopic = 'taste' | 'saltiness' | 'spiciness' | 'temperature' | 'portion' | 'presentation' | 'service_speed' | 'value' | 'other';
export interface ReviewFilter { dishId?: string; fromDate?: string; toDate?: string }
export interface ReviewReport {
  facts: {
    totalReviews: number; commentCount: number; analyzedCommentCount: number; sampleSize: number;
    averageRating: number | null; analysisCoveragePercentage: number; minimumSample: number;
    sentimentCounts: Record<ReviewSentiment, number>; sentimentPercentages: Record<ReviewSentiment, number>;
    topics: { topic: ReviewTopic; label: string; count: number; percentage: number; sentiments: Record<ReviewSentiment, number> }[];
  };
  warnings: string[]; taxonomyVersion: string; generatedAt: string;
  summary?: string | null; summaryStatus?: 'ready' | 'empty' | 'unavailable'; modelVersion?: string | null;
}
export interface ReviewSources {
  reviews: { _id: string; dishId: string; rating: number; comment?: string; createdAt: string;
    aiInsight?: { sentiment: ReviewSentiment; topics: { topic: ReviewTopic; sentiment: ReviewSentiment }[]; taxonomyVersion: string; modelVersion: string; analyzedAt: string };
  }[]; total: number; page: number; pageSize: number;
}
const base = '/ai/admin/review-insights';
export const reviewIntelligenceApi = {
  get: async (params: ReviewFilter, signal: AbortSignal): Promise<ReviewReport> => (await axiosClient.get<ReviewReport>(base, { params, signal })).data,
  summary: async (input: ReviewFilter, signal: AbortSignal): Promise<ReviewReport> => (await axiosClient.post<ReviewReport>(`${base}/summary`, input, { signal, timeout: 190000 })).data,
  analyze: async (input: ReviewFilter, signal: AbortSignal): Promise<{ attempted: number; analyzed: number; outcomes: { status: string; code?: string; warnings: string[] }[] }> => (await axiosClient.post(`${base}/analyze`, input, { signal, timeout: 190000 })).data,
  sources: async (params: ReviewFilter & { topic?: ReviewTopic; sentiment?: ReviewSentiment; page: number }, signal: AbortSignal): Promise<ReviewSources> => (await axiosClient.get<ReviewSources>(`${base}/sources`, { params, signal })).data,
};
