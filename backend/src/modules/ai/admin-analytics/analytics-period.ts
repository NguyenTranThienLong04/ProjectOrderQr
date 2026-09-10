import { AiError } from '../ai.errors';
import type {
  AnalyticsIntent,
  AnalyticsPeriodIntent,
  AnalyticsQueryDto,
} from './analytics.dto';

const DAY = 86400000;
export interface AnalyticsPeriod {
  from: string;
  to: string;
  timezone: 'UTC';
}

function dateOnly(text: string, year: number): Date {
  let iso = text;
  const local = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(text);
  if (local)
    iso = `${local[3] ?? year}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new AiError('AI_INVALID_REQUEST');
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== iso ||
    date.getUTCFullYear() < 2000 ||
    date.getUTCFullYear() > 2100
  )
    throw new AiError('AI_INVALID_REQUEST');
  return date;
}
export function dateRange(
  from: string,
  to: string,
  year = new Date().getUTCFullYear(),
): AnalyticsPeriod {
  const start = dateOnly(from, year),
    end = dateOnly(to, year);
  if (start > end || end.getTime() - start.getTime() >= 366 * DAY)
    throw new AiError('AI_INVALID_REQUEST');
  return {
    from: start.toISOString(),
    to: new Date(end.getTime() + DAY - 1).toISOString(),
    timezone: 'UTC',
  };
}
export function selectedRange(
  input: AnalyticsQueryDto,
): AnalyticsPeriod | undefined {
  if (input.fromDate === undefined && input.toDate === undefined) return;
  if (!input.fromDate || !input.toDate) throw new AiError('AI_INVALID_REQUEST');
  return dateRange(input.fromDate, input.toDate);
}
export function normalizePeriod(
  intent: AnalyticsPeriodIntent,
  input: AnalyticsQueryDto,
  now: Date,
): AnalyticsPeriod {
  if (intent.preset === 'custom') {
    // Date lexemes must be copied from the question. Years omitted by the user are resolved here.
    const dates: string[] =
      input.query.match(
        /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{4})?\b/g,
      ) ?? [];
    if (!dates.includes(intent.from) || !dates.includes(intent.to))
      throw new AiError('AI_INVALID_OUTPUT');
    return dateRange(intent.from, intent.to, now.getUTCFullYear());
  }
  if (intent.from !== '' || intent.to !== '')
    throw new AiError('AI_INVALID_OUTPUT');
  if (intent.preset === 'selected' && selectedRange(input))
    return selectedRange(input)!;
  const y = now.getUTCFullYear(),
    m = now.getUTCMonth(),
    d = now.getUTCDate();
  let start = Date.UTC(y, m, d),
    end = start + DAY - 1;
  switch (intent.preset) {
    case 'today':
      break;
    case 'yesterday':
      start -= DAY;
      end -= DAY;
      break;
    case 'this_week':
    case 'last_week': {
      start -= ((now.getUTCDay() + 6) % 7) * DAY;
      if (intent.preset === 'last_week') start -= 7 * DAY;
      end = start + 7 * DAY - 1;
      break;
    }
    case 'selected':
    case 'this_month':
      start = Date.UTC(y, m, 1);
      end = Date.UTC(y, m + 1, 1) - 1;
      break;
    case 'last_month':
      start = Date.UTC(y, m - 1, 1);
      end = Date.UTC(y, m, 1) - 1;
      break;
    case 'this_year':
      start = Date.UTC(y, 0, 1);
      end = Date.UTC(y + 1, 0, 1) - 1;
      break;
    default:
      throw new AiError('AI_INVALID_OUTPUT');
  }
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    timezone: 'UTC',
  };
}
export function resolveIntent(
  intent: AnalyticsIntent,
  input: AnalyticsQueryDto,
  now: Date,
) {
  if (
    intent.operation === 'compare' &&
    !['revenue', 'orders'].includes(intent.metric)
  )
    throw new AiError('AI_INVALID_OUTPUT');
  const current = normalizePeriod(intent.currentPeriod, input, now);
  // Validate even unused arguments; no unvalidated model argument reaches a tool.
  const comparison = normalizePeriod(intent.comparisonPeriod, input, now);
  if (
    intent.operation === 'compare' &&
    !(current.to < comparison.from || comparison.to < current.from)
  )
    throw new AiError('AI_INVALID_OUTPUT');
  return { current, comparison };
}
