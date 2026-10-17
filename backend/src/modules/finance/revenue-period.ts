import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';

export const REVENUE_TIMEZONE = 'Asia/Ho_Chi_Minh';
const DAY = 86400000;
const OFFSET = 7 * 3600000;

/** Date-only filters are inclusive Vietnam business days. ISO instants must
 * carry a timezone; the database predicate always uses an exclusive upper bound. */
export function revenuePeriod(from?: string, to?: string, now = new Date()) {
  const today = new Date(now.getTime() + OFFSET).toISOString().slice(0, 10);
  if ((from === undefined) !== (to === undefined))
    throw new BadRequestException('Cần nhập cả ngày bắt đầu và kết thúc');
  function parse(input: string, end: boolean) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      const utc = new Date(`${input}T00:00:00.000Z`);
      if (!Number.isFinite(+utc) || utc.toISOString().slice(0, 10) !== input)
        throw new BadRequestException('Ngày không hợp lệ');
      return new Date(+utc - OFFSET + (end ? DAY : 0));
    }
    if (
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input) ||
      !isISO8601(input, { strict: true, strictSeparator: true }) ||
      !Number.isFinite(Date.parse(input))
    )
      throw new BadRequestException(
        'Thời gian phải là YYYY-MM-DD hoặc ISO có múi giờ',
      );
    return new Date(input);
  }
  const start = parse(from ?? today, false);
  const end = parse(to ?? today, true);
  if (start >= end || +end - +start > 366 * DAY)
    throw new BadRequestException(
      'Khoảng ngày phải tăng dần và tối đa 366 ngày',
    );
  return { from: start, toExclusive: end, timezone: REVENUE_TIMEZONE };
}
