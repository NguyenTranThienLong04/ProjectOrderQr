import type { AnalyticsIntent } from './analytics.dto';
export function analyticsIntent(
  overrides: Partial<AnalyticsIntent> = {},
): AnalyticsIntent {
  return {
    metric: 'revenue',
    operation: 'value',
    currentPeriod: { preset: 'selected', from: '', to: '' },
    comparisonPeriod: { preset: 'selected', from: '', to: '' },
    limit: 5,
    ...overrides,
  };
}
export const ANALYTICS_GOLDEN = [
  [
    'doanh thu hôm nay',
    analyticsIntent({ currentPeriod: { preset: 'today', from: '', to: '' } }),
  ],
  [
    'Doanh thu tuần này so với tuần trước thế nào?',
    analyticsIntent({
      operation: 'compare',
      currentPeriod: { preset: 'this_week', from: '', to: '' },
      comparisonPeriod: { preset: 'last_week', from: '', to: '' },
    }),
  ],
  [
    'tháng này bán được bao nhiêu',
    analyticsIntent({
      currentPeriod: { preset: 'this_month', from: '', to: '' },
    }),
  ],
  [
    'top 5 món tháng này',
    analyticsIntent({
      metric: 'topDishes',
      currentPeriod: { preset: 'this_month', from: '', to: '' },
    }),
  ],
  [
    'món nào bán chạy nhất từ 1/8 đến 15/8',
    analyticsIntent({
      metric: 'topDishes',
      limit: 1,
      currentPeriod: { preset: 'custom', from: '1/8', to: '15/8' },
    }),
  ],
  ['đánh giá tháng này', analyticsIntent({ metric: 'ratingSummary' })],
  [
    'món được đánh giá cao nhất',
    analyticsIntent({ metric: 'topRatedDishes', limit: 1 }),
  ],
  ['giá trị đơn trung bình', analyticsIntent({ metric: 'averageOrderValue' })],
  [
    'Tại sao doanh thu giảm?',
    analyticsIntent({
      operation: 'compare',
      currentPeriod: { preset: 'this_month', from: '', to: '' },
      comparisonPeriod: { preset: 'last_month', from: '', to: '' },
    }),
  ],
] as const;
