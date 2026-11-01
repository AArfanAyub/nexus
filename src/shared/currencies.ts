/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The currencies NEXUS knows by name.
 *
 * A currency is data, not code: the company picks one as its base during
 * onboarding and the rest are seeded as inactive rows an accountant can switch on
 * in Settings → Currencies. This list exists only so the onboarding picker can
 * show a human name and a symbol instead of a bare ISO code, and so a fresh
 * company is not limited to four currencies.
 *
 * `decimals` is 0 for currencies with no minor unit (JPY, VND, KRW) — money is
 * stored in minor units, so this value decides what "one cent" means.
 */

export interface CurrencyDef {
  readonly code: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: 0 | 2 | 3;
}

export const CURRENCIES: readonly CurrencyDef[] = [
  { code: 'MYR', name: 'Malaysian ringgit', symbol: 'RM', decimals: 2 },
  { code: 'USD', name: 'US dollar', symbol: '$', decimals: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 },
  { code: 'GBP', name: 'Pound sterling', symbol: '£', decimals: 2 },
  { code: 'SGD', name: 'Singapore dollar', symbol: 'S$', decimals: 2 },
  { code: 'IDR', name: 'Indonesian rupiah', symbol: 'Rp', decimals: 2 },
  { code: 'THB', name: 'Thai baht', symbol: '฿', decimals: 2 },
  { code: 'PHP', name: 'Philippine peso', symbol: '₱', decimals: 2 },
  { code: 'VND', name: 'Vietnamese dong', symbol: '₫', decimals: 0 },
  { code: 'INR', name: 'Indian rupee', symbol: '₹', decimals: 2 },
  { code: 'AED', name: 'UAE dirham', symbol: 'د.إ', decimals: 2 },
  { code: 'SAR', name: 'Saudi riyal', symbol: '﷼', decimals: 2 },
  { code: 'CNY', name: 'Chinese yuan', symbol: '¥', decimals: 2 },
  { code: 'JPY', name: 'Japanese yen', symbol: '¥', decimals: 0 },
  { code: 'KRW', name: 'South Korean won', symbol: '₩', decimals: 0 },
  { code: 'AUD', name: 'Australian dollar', symbol: 'A$', decimals: 2 },
  { code: 'CAD', name: 'Canadian dollar', symbol: 'C$', decimals: 2 },
  { code: 'ZAR', name: 'South African rand', symbol: 'R', decimals: 2 },
  { code: 'BRL', name: 'Brazilian real', symbol: 'R$', decimals: 2 },
  { code: 'MXN', name: 'Mexican peso', symbol: 'MX$', decimals: 2 },
];

const BY_CODE = new Map(CURRENCIES.map((entry) => [entry.code, entry]));

export function currencyDef(code: string): CurrencyDef | undefined {
  return BY_CODE.get(code.toUpperCase());
}

/** True when the code is one we can name — anything else is still accepted as a raw code. */
export function isKnownCurrency(code: string): boolean {
  return BY_CODE.has(code.toUpperCase());
}

/** Options for a `<Select>`, base currency first. */
export function currencyOptions(baseCode?: string): { value: string; label: string }[] {
  const ordered = baseCode
    ? [...CURRENCIES].sort((a, b) => (a.code === baseCode ? -1 : b.code === baseCode ? 1 : 0))
    : [...CURRENCIES];
  return ordered.map((entry) => ({ value: entry.code, label: `${entry.code} — ${entry.name}` }));
}
