import {
  dateRange,
  normalizePeriod,
  resolveIntent,
  selectedRange,
} from './analytics-period';
import { analyticsIntent } from './analytics.golden';
import { periodChange } from './analytics-tools.service';

describe('Phase 21 deterministic UTC dates and arithmetic', () => {
  const now = new Date('2026-09-08T23:59:59Z');
  it.each([
    ['today', '2026-09-08', '2026-09-08'],
    ['yesterday', '2026-09-07', '2026-09-07'],
    ['this_week', '2026-09-07', '2026-09-13'],
    ['last_week', '2026-08-31', '2026-09-06'],
    ['this_month', '2026-09-01', '2026-09-30'],
    ['last_month', '2026-08-01', '2026-08-31'],
    ['this_year', '2026-01-01', '2026-12-31'],
    ['selected', '2026-09-01', '2026-09-30'],
  ] as const)('resolves %s without model timestamps', (preset, from, to) => {
    expect(
      normalizePeriod({ preset, from: '', to: '' }, { query: 'q' }, now),
    ).toEqual({
      from: `${from}T00:00:00.000Z`,
      to: `${to}T23:59:59.999Z`,
      timezone: 'UTC',
    });
  });
  it('rolls prior month across year and leap day', () => {
    expect(
      normalizePeriod(
        { preset: 'last_month', from: '', to: '' },
        { query: 'q' },
        new Date('2026-01-01Z'),
      ).from,
    ).toBe('2025-12-01T00:00:00.000Z');
    expect(dateRange('28/2/2024', '29/2/2024').to).toBe(
      '2024-02-29T23:59:59.999Z',
    );
  });
  it('resolves omitted year in exact question lexemes', () => {
    expect(
      normalizePeriod(
        { preset: 'custom', from: '1/8', to: '15/8' },
        { query: 'từ 1/8 đến 15/8' },
        now,
      ),
    ).toEqual(dateRange('2026-08-01', '2026-08-15'));
  });
  it.each([
    ['2026-02-29', '2026-03-01'],
    ['2026-08-20', '2026-08-01'],
    ['2025-01-01', '2026-01-02'],
    ['2026-13-01', '2026-13-02'],
    ['2026-01-01T00:00Z', '2026-02-01'],
    ['1999-01-01', '1999-01-02'],
  ])('rejects invalid/bounded range %s %s', (from, to) => {
    expect(() => dateRange(from, to)).toThrow();
  });
  it('requires both dashboard dates and prefers selected range', () => {
    expect(() =>
      selectedRange({ query: 'q', fromDate: '2026-08-01' }),
    ).toThrow();
    expect(
      normalizePeriod(
        { preset: 'selected', from: '', to: '' },
        { query: 'q', fromDate: '2026-08-01', toDate: '2026-08-15' },
        now,
      ),
    ).toEqual(dateRange('2026-08-01', '2026-08-15'));
  });
  it('rejects invented date lexemes and preset timestamps', () => {
    expect(() =>
      normalizePeriod(
        { preset: 'custom', from: '1/8', to: '15/8' },
        { query: 'doanh thu' },
        now,
      ),
    ).toThrow();
    expect(() =>
      normalizePeriod(
        { preset: 'today', from: '2026-01-01', to: '' },
        { query: 'q' },
        now,
      ),
    ).toThrow();
  });
  it('rejects overlapping comparisons and unsupported compare metrics', () => {
    expect(() =>
      resolveIntent(
        analyticsIntent({ operation: 'compare' }),
        { query: 'q' },
        now,
      ),
    ).toThrow();
    expect(() =>
      resolveIntent(
        analyticsIntent({ metric: 'topDishes', operation: 'compare' }),
        { query: 'q' },
        now,
      ),
    ).toThrow();
  });
  it.each([
    [12500000, 10000000, 2500000, 25],
    [80, 100, -20, -20],
    [0, 100, -100, -100],
    [0, 0, 0, null],
    [10, 0, 10, null],
    [2, 3, -1, -33.33],
  ])(
    'calculates %s versus %s in backend',
    (current, prior, difference, percentage) => {
      expect(periodChange(current, prior)).toEqual({
        difference,
        percentage,
      });
    },
  );
});
