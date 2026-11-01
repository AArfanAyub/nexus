/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * ISO-8601 UTC helpers. Every stored timestamp is `nowIso()`; every stored
 * date-only column is `todayIso()` (`YYYY-MM-DD`). `Date` objects never cross
 * an IPC boundary (CONVENTIONS §5).
 */

const MS_PER_DAY = 86_400_000;

/** `2026-02-11T09:41:00.000Z` */
export function nowIso(): string {
  return new Date().toISOString();
}

/** `2026-02-11` */
export function todayIso(): string {
  return nowIso().slice(0, 10);
}

/** True when `value` is a well-formed `YYYY-MM-DD` calendar date. */
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(time)) return false;
  return new Date(time).toISOString().slice(0, 10) === value;
}

/** True when `value` is a well-formed ISO-8601 UTC timestamp. */
export function isValidTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function toUtcDate(iso: string): Date {
  const normalised = iso.length === 10 ? `${iso}T00:00:00.000Z` : iso;
  const date = new Date(normalised);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ISO date: ${iso}`);
  return date;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Adds (or subtracts) whole days, DST-free because everything is UTC. */
export function addDays(iso: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error('addDays expects an integer day count');
  const date = toUtcDate(iso);
  return dateOnly(new Date(date.getTime() + days * MS_PER_DAY));
}

/** Adds whole months, clamping to the last valid day (Jan 31 + 1 → Feb 28/29). */
export function addMonths(iso: string, months: number): string {
  if (!Number.isInteger(months)) throw new Error('addMonths expects an integer month count');
  const date = toUtcDate(iso);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(year, month + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return dateOnly(target);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const start = toUtcDate(from).getTime();
  const end = toUtcDate(to).getTime();
  return Math.round((end - start) / MS_PER_DAY);
}

/** First day of the calendar month containing `iso`. */
export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** Last day of the calendar month containing `iso`. */
export function endOfMonth(iso: string): string {
  const date = toUtcDate(iso);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return dateOnly(last);
}

/** Calendar month boundaries for the month containing `iso`. */
export function monthRange(iso: string): { readonly start: string; readonly end: string } {
  return { start: startOfMonth(iso), end: endOfMonth(iso) };
}

/**
 * Fiscal year boundaries for the year containing `iso`.
 * `fiscalStartMonth` is 1-based (1 = January).
 */
export function fiscalYearRange(
  iso: string,
  fiscalStartMonth = 1,
): { readonly start: string; readonly end: string } {
  if (!Number.isInteger(fiscalStartMonth) || fiscalStartMonth < 1 || fiscalStartMonth > 12) {
    throw new Error(`fiscalStartMonth must be 1..12, received ${String(fiscalStartMonth)}`);
  }
  const date = toUtcDate(iso);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const startYear = month >= fiscalStartMonth ? year : year - 1;
  const start = `${String(startYear)}-${String(fiscalStartMonth).padStart(2, '0')}-01`;
  const end = addDays(addMonths(start, 12), -1);
  return { start, end };
}

/**
 * Splits a fiscal year into `periodsPerYear` periods. Default is 12 monthly
 * periods; the caller passes the count when the company uses quarters.
 */
export function fiscalPeriods(
  fiscalStartMonth: number,
  iso: string,
  periodsPerYear = 12,
): readonly { readonly name: string; readonly start: string; readonly end: string }[] {
  if (!Number.isInteger(periodsPerYear) || periodsPerYear < 1 || periodsPerYear > 12) {
    throw new Error('periodsPerYear must be 1..12');
  }
  const monthsPerPeriod = 12 / periodsPerYear;
  if (!Number.isInteger(monthsPerPeriod)) {
    throw new Error('periodsPerYear must divide 12 evenly');
  }
  const year = fiscalYearRange(iso, fiscalStartMonth);
  const periods: { name: string; start: string; end: string }[] = [];
  for (let index = 0; index < periodsPerYear; index += 1) {
    const start = addMonths(year.start, index * monthsPerPeriod);
    const end = addDays(addMonths(start, monthsPerPeriod), -1);
    periods.push({ name: `P${String(index + 1).padStart(2, '0')}`, start, end });
  }
  return periods;
}

/** True when both dates fall inside the same `[start, end]` window. */
export function isSamePeriod(
  a: string,
  b: string,
  range: { readonly start: string; readonly end: string },
): boolean {
  const inRange = (value: string): boolean => value >= range.start && value <= range.end;
  return inRange(a) && inRange(b);
}

/** True when `date` is within `[start, end]` inclusive. */
export function isWithin(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}

const MONTH_LONG_CACHE = new Map<string, Intl.DateTimeFormat>();
const MONTH_SHORT_CACHE = new Map<string, Intl.DateTimeFormat>();

function monthName(monthIndex: number, locale: string, long: boolean): string {
  const cache = long ? MONTH_LONG_CACHE : MONTH_SHORT_CACHE;
  let formatter = cache.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { month: long ? 'long' : 'short', timeZone: 'UTC' });
    cache.set(locale, formatter);
  }
  return formatter.format(new Date(Date.UTC(2026, monthIndex, 1)));
}

/**
 * Formats an ISO date or timestamp with a token pattern.
 * Tokens: `yyyy yy MMMM MMM MM M dd d HH mm ss`. Default `yyyy-MM-dd`.
 */
export function formatDate(iso: string, locale = 'en-US', pattern = 'yyyy-MM-dd'): string {
  const date = toUtcDate(iso);
  const hasTime = iso.length > 10;
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  const pad = (value: number): string => String(value).padStart(2, '0');

  const tokens: readonly (readonly [string, string])[] = [
    ['yyyy', String(year)],
    ['yy', String(year).slice(-2)],
    ['MMMM', monthName(month, locale, true)],
    ['MMM', monthName(month, locale, false)],
    ['MM', pad(month + 1)],
    ['dd', pad(day)],
    ['HH', hasTime ? pad(hours) : '00'],
    ['mm', hasTime ? pad(minutes) : '00'],
    ['ss', hasTime ? pad(seconds) : '00'],
    ['M', String(month + 1)],
    ['d', String(day)],
  ];

  let output = pattern;
  for (const [token, value] of tokens) {
    output = output.split(token).join(value);
  }
  return output;
}

/** Human relative label used by list views: "Today", "3 days ago", else the date. */
export function relativeDay(iso: string, reference = todayIso(), locale = 'en-US'): string {
  const delta = daysBetween(iso.slice(0, 10), reference);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Yesterday';
  if (delta === -1) return 'Tomorrow';
  if (delta > 1 && delta <= 30) return `${String(delta)} days ago`;
  if (delta < -1 && delta >= -30) return `in ${String(-delta)} days`;
  return formatDate(iso, locale);
}
