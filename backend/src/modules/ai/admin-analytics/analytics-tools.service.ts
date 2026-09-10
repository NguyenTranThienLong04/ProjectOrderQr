import { Injectable } from '@nestjs/common';
import { AdminService } from '../../admin/admin.service';
import { AiError } from '../ai.errors';
import type { AnalyticsIntent } from './analytics.dto';
import type { AnalyticsPeriod } from './analytics-period';

export interface AnalyticsFact {
  id: string;
  metric: string;
  label: string;
  period: AnalyticsPeriod;
  value: number | null;
  unit: 'VND' | 'orders' | 'items' | 'reviews' | 'stars' | 'percent' | 'rank';
  dishName?: string;
  comparisonPeriod?: AnalyticsPeriod;
}
export const ANALYTICS_WARNINGS = {
  unsupported:
    'Hệ thống hiện chưa có dữ liệu cost/margin/waste hoặc dữ liệu phù hợp để trả lời câu hỏi này chính xác. Chỉ hỗ trợ doanh thu, đơn đã thanh toán, món bán và đánh giá.',
  causes:
    'Chưa đủ dữ liệu để xác định nguyên nhân; hệ thống không ghi nhận thời tiết, ca nhân viên, lượng khách, tồn kho hay sự kiện.',
  small: 'Mẫu dữ liệu nhỏ; chưa đủ cơ sở để kết luận xu hướng.',
  empty: 'Không có dữ liệu phù hợp trong kỳ đã chọn.',
  zero: 'Kỳ đối chiếu bằng không nên không xác định được phần trăm thay đổi.',
  partial:
    'Kỳ hiện tại chưa kết thúc; số liệu là phần đã ghi nhận, so sánh dùng toàn kỳ lịch đã chọn.',
  unequal:
    'Hai kỳ có độ dài khác nhau; đây là so sánh tổng, chưa chuẩn hóa theo ngày.',
};
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export function periodChange(current: number, previous: number) {
  return {
    difference: round(current - previous),
    percentage:
      previous === 0 ? null : round(((current - previous) / previous) * 100),
  };
}

/** Closed dispatch: no method name, field name, operator or pipeline comes from the LLM. */
@Injectable()
export class AnalyticsToolsService {
  constructor(private readonly admin: AdminService) {}

  async execute(
    intent: AnalyticsIntent,
    current: AnalyticsPeriod,
    comparison: AnalyticsPeriod,
  ) {
    const facts: AnalyticsFact[] = [],
      warnings: string[] = [];
    const add = (
      metric: string,
      label: string,
      value: number | null,
      unit: AnalyticsFact['unit'],
      period = current,
      dishName?: string,
      comparisonPeriod?: AnalyticsPeriod,
    ) => {
      if (
        value !== null &&
        (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
      )
        throw new AiError('AI_ANALYTICS_UNAVAILABLE');
      facts.push({
        id: `f${facts.length + 1}`,
        metric,
        label,
        period,
        value,
        unit,
        ...(dishName ? { dishName } : {}),
        ...(comparisonPeriod ? { comparisonPeriod } : {}),
      });
    };
    let sample = 0;
    let hasCurrentData = false;
    if (['revenue', 'orders', 'averageOrderValue'].includes(intent.metric)) {
      const totals = async (period: AnalyticsPeriod) => {
        const rows = await this.admin.getRevenue(
          new Date(period.from),
          new Date(period.to),
        );
        return rows.reduce(
          (sum, row) => ({
            revenue: sum.revenue + row.revenue,
            orders: sum.orders + row.orders,
          }),
          { revenue: 0, orders: 0 },
        );
      };
      const now = await totals(current);
      sample = now.orders;
      hasCurrentData = now.orders > 0;
      add('revenue', 'Doanh thu đã thanh toán', now.revenue, 'VND');
      add('orders', 'Đơn đã thanh toán', now.orders, 'orders');
      add(
        'averageOrderValue',
        'Giá trị đơn đã thanh toán trung bình',
        now.orders ? round(now.revenue / now.orders) : null,
        'VND',
      );
      if (intent.operation === 'compare') {
        const prior = await totals(comparison);
        sample = Math.min(sample, prior.orders);
        add(
          'revenue',
          'Doanh thu kỳ đối chiếu',
          prior.revenue,
          'VND',
          comparison,
        );
        add(
          'orders',
          'Đơn đã thanh toán kỳ đối chiếu',
          prior.orders,
          'orders',
          comparison,
        );
        const key = intent.metric === 'orders' ? 'orders' : 'revenue';
        const change = periodChange(now[key], prior[key]);
        add(
          `${key}Difference`,
          'Chênh lệch so với kỳ đối chiếu',
          change.difference,
          key === 'orders' ? 'orders' : 'VND',
          current,
          undefined,
          comparison,
        );
        add(
          `${key}ChangePercent`,
          'Thay đổi so với kỳ đối chiếu',
          change.percentage,
          'percent',
          current,
          undefined,
          comparison,
        );
        if (change.percentage === null) warnings.push(ANALYTICS_WARNINGS.zero);
        if (
          Date.parse(current.to) - Date.parse(current.from) !==
          Date.parse(comparison.to) - Date.parse(comparison.from)
        )
          warnings.push(ANALYTICS_WARNINGS.unequal);
      }
    } else if (intent.metric === 'topDishes') {
      const rows = await this.admin.getTopDishes(
        new Date(current.from),
        new Date(current.to),
        intent.limit,
      );
      hasCurrentData = rows.length > 0;
      // Quantity is not an independent sample count: use actual Paid orders.
      sample = (
        await this.admin.getRevenue(
          new Date(current.from),
          new Date(current.to),
        )
      ).reduce((sum, row) => sum + row.orders, 0);
      add('orders', 'Đơn đã thanh toán trong kỳ', sample, 'orders');
      rows.forEach((row, index) => {
        add(
          'rank',
          'Xếp hạng bán chạy',
          index + 1,
          'rank',
          current,
          row.dishName,
        );
        add(
          'quantity',
          'Số phần đã bán',
          row.totalQuantity,
          'items',
          current,
          row.dishName,
        );
        add(
          'dishGrossRevenue',
          'Giá trị món trước giảm giá cấp đơn',
          row.revenue,
          'VND',
          current,
          row.dishName,
        );
      });
    } else if (intent.metric === 'topRatedDishes') {
      const rows = await this.admin.getTopRatedDishes(
        intent.limit,
        new Date(current.from),
        new Date(current.to),
      );
      hasCurrentData = rows.length > 0;
      if (!rows.length)
        add('reviewCount', 'Số đánh giá của món trong kết quả', 0, 'reviews');
      sample = rows.length
        ? Math.min(...rows.map((row) => row.reviewCount))
        : 0;
      rows.forEach((row, index) => {
        add(
          'rank',
          'Xếp hạng đánh giá',
          index + 1,
          'rank',
          current,
          row.dishName,
        );
        add(
          'averageRating',
          'Điểm đánh giá trung bình',
          row.averageRating,
          'stars',
          current,
          row.dishName,
        );
        add(
          'reviewCount',
          'Số đánh giá',
          row.reviewCount,
          'reviews',
          current,
          row.dishName,
        );
      });
    } else if (intent.metric === 'ratingSummary') {
      const rows = await this.admin.getRatingSummary(
        new Date(current.from),
        new Date(current.to),
      );
      sample = rows[0]?.reviewCount ?? 0;
      hasCurrentData = sample > 0;
      add(
        'averageRating',
        'Điểm đánh giá trung bình',
        rows[0]?.averageRating ?? null,
        'stars',
      );
      add('reviewCount', 'Số đánh giá', sample, 'reviews');
    } else throw new AiError('AI_INVALID_OUTPUT');
    if (!hasCurrentData) warnings.push(ANALYTICS_WARNINGS.empty);
    if (sample < 5) warnings.push(ANALYTICS_WARNINGS.small);
    return { facts, warnings };
  }
}
