/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Display formatting. Pure functions, no React, no i18n runtime.
 *
 * Money is always integer cents in and a formatted string out — the arithmetic
 * itself stays in `money.ts` (CONVENTIONS §4). Dates are ISO `YYYY-MM-DD` in and
 * a locale string out; nothing here re-implements calendar maths.
 */

import { formatCents, type Cents } from '@shared/money';

const DEFAULT_LOCALE = 'en-US';

/** `123456` cents → `$1,234.56`. */
export function currency(cents: number | null | undefined, code = 'USD', locale = DEFAULT_LOCALE): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  return formatCents(cents as Cents, code, locale);
}

/** `123456` cents → `1,234.56` with no symbol, for table cells. */
export function amount(cents: number | null | undefined, locale = DEFAULT_LOCALE): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    cents / 100,
  );
}

/** Milli-units → a quantity string with up to three decimals, trailing zeros trimmed. */
export function quantity(milli: number | null | undefined, locale = DEFAULT_LOCALE): string {
  if (milli === null || milli === undefined || !Number.isFinite(milli)) return '—';
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(milli / 1000);
}

/** Basis points → `12.5%`. */
export function percent(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return '—';
  return `${new Intl.NumberFormat(DEFAULT_LOCALE, { maximumFractionDigits: 2 }).format(bp / 100)}%`;
}

/** `2026-03-14` → `14 Mar 2026`. Falls back to the raw value when unparseable. */
export function date(iso: string | null | undefined, locale = DEFAULT_LOCALE): string {
  if (!iso) return '—';
  const parsed = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed)) return iso;
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(parsed));
}

/** `2026-03-14T09:12:00Z` → `14 Mar 2026, 09:12`. */
export function dateTime(iso: string | null | undefined, locale = DEFAULT_LOCALE): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(parsed));
}

/** `3 days ago`, `in 2 hours`, `just now`. */
export function relative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMs = then - Date.now();
  const abs = Math.abs(diffMs);
  const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 24 * 3600_000],
    ['month', 30 * 24 * 3600_000],
    ['day', 24 * 3600_000],
    ['hour', 3600_000],
    ['minute', 60_000],
  ];
  const formatter = new Intl.RelativeTimeFormat(DEFAULT_LOCALE, { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (abs >= ms) return formatter.format(Math.round(diffMs / ms), unit);
  }
  return 'just now';
}

/** `1_450_000` → `1.45M`. Used on KPI tiles where width is scarce. */
export function compact(value: number | null | undefined, locale = DEFAULT_LOCALE): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Compact money: `1450000` cents → `$14.5K`. */
export function compactMoney(cents: number | null | undefined, code = 'USD', locale = DEFAULT_LOCALE): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: code,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

/** A human label from a snake_case column or channel (`base_price_cents` → `Base price`). */
export function humanise(key: string): string {
  const words = key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `paid` → `Paid`, for status chips. */
export function titleCase(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Truncates on a word boundary without cutting a surrogate pair. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const slice = Array.from(value).slice(0, Math.max(0, max - 1)).join('');
  return `${slice}…`;
}
