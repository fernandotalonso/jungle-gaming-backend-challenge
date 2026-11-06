import type { DateLike } from './date-like';
import { DomainError } from './errors';

export function toDate(value: DateLike): Date {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new DomainError(`invalid date value: ${String(value)}`);
  }
  return date;
}
