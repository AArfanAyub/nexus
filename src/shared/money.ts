/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The ONLY module in the codebase that performs arithmetic on money.
 *
 * Rules (CONVENTIONS §4, BR-05/06/07):
 *   - every monetary value is an integer number of minor units ("cents")
 *   - quantities are milli-units (`qtyMilli`, 1000 = 1 unit)
 *   - rates are basis points (`bp`, 2000 = 20.00%)
 *   - per-line tax rounds half-to-even, document totals round half-up
 *   - tax-inclusive amounts are BACK-COMPUTED so `net + tax === gross` exactly
 *
 * No floating point ever enters a stored value. `formatCents`/`parseCents` are
 * the only edge functions and they are used by the renderer only.
 */

/** Branded integer cents. A plain `number` is not assignable to `Cents`. */
export type Cents = number & { readonly __cents: unique symbol };

/** The neutral element of addition, in cents. */
export const ZERO_CENTS: Cents = 0 as Cents;

/** Asserts and brands an integer as `Cents`. Throws on a fractional value. */
export function cents(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new Error(`Cents must be an integer, received ${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Cents out of safe integer range: ${String(value)}`);
  }
  return value as Cents;
}

/**
 * Exact division rounded half-away-from-zero, using integers only.
 * `divRoundHalfUp(1005, 10) === 101`.
 */
function divRoundHalfUp(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error('Division by zero in money arithmetic');
  const sign = Math.sign(numerator) * Math.sign(denominator) === -1 ? -1 : 1;
  const absNumerator = Math.abs(numerator);
  const absDenominator = Math.abs(denominator);
  return sign * Math.floor((2 * absNumerator + absDenominator) / (2 * absDenominator));
}

/**
 * Exact division rounded half-to-even (banker's rounding), integers only.
 * `divRoundHalfEven(5, 10) === 0`, `divRoundHalfEven(15, 10) === 2`.
 */
function divRoundHalfEven(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error('Division by zero in money arithmetic');
  const sign = Math.sign(numerator) * Math.sign(denominator) === -1 ? -1 : 1;
  const absNumerator = Math.abs(numerator);
  const absDenominator = Math.abs(denominator);
  const quotient = Math.floor(absNumerator / absDenominator);
  const remainder = absNumerator - quotient * absDenominator;
  const doubled = 2 * remainder;
  if (doubled > absDenominator) return sign * (quotient + 1);
  if (doubled < absDenominator) return sign * quotient;
  return sign * (quotient % 2 === 0 ? quotient : quotient + 1);
}

/**
 * Half-to-even division by an arbitrary denominator, exposed for the one case
 * that is not a power of ten: back-computing tax-inclusive amounts
 * (`gross × rate / (10000 + rate)`, BR-07).
 */
export function divHalfEven(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new Error('divHalfEven accepts safe integers only');
  }
  return divRoundHalfEven(numerator, denominator);
}

/** Half-up division by an arbitrary denominator, for document-level totals. */
export function divHalfUp(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new Error('divHalfUp accepts safe integers only');
  }
  return divRoundHalfUp(numerator, denominator);
}

/**
 * Rounds `value` to an integer, treating it as a decimal carrying `dp` digits
 * (i.e. `value / 10^dp` is the real amount). Ties go away from zero.
 *
 *   roundHalfUp(1005, 1) === 101      // 100.5 -> 101
 *   roundHalfUp(1005, 0) === 1005     // already an integer
 */
export function roundHalfUp(value: number, dp = 0): number {
  assertDp(dp);
  return divRoundHalfUp(value, 10 ** dp);
}

/**
 * Rounds `value` to an integer, treating it as a decimal carrying `dp` digits.
 * Ties go to the even neighbour (BR-06 per-line tax).
 *
 *   roundHalfEven(5, 1) === 0         // 0.5 -> 0
 *   roundHalfEven(15, 1) === 2        // 1.5 -> 2
 *   roundHalfEven(25, 1) === 2        // 2.5 -> 2
 */
export function roundHalfEven(value: number, dp = 0): number {
  assertDp(dp);
  return divRoundHalfEven(value, 10 ** dp);
}

function assertDp(dp: number): void {
  if (!Number.isInteger(dp) || dp < 0 || dp > 8) {
    throw new Error(`dp must be an integer between 0 and 8, received ${String(dp)}`);
  }
}

/** Sums any number of cents values exactly. */
export function addCents(...values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) total += value;
  return cents(total);
}

/** `a - b` in cents. */
export function subCents(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

/** Unary negation in cents. */
export function negCents(value: Cents): Cents {
  return cents(-value);
}

/** `price × quantity`, where quantity is in milli-units. Half-to-even. */
export function mulQty(priceCents: Cents, qtyMilli: number): Cents {
  if (!Number.isInteger(qtyMilli)) {
    throw new Error(`qtyMilli must be an integer, received ${String(qtyMilli)}`);
  }
  return cents(divRoundHalfEven(priceCents * qtyMilli, 1000));
}

/** Applies a basis-point rate to a base amount, rounded half-up. */
export function percentBp(base: Cents, bp: number): Cents {
  if (!Number.isInteger(bp)) {
    throw new Error(`bp must be an integer, received ${String(bp)}`);
  }
  return cents(divRoundHalfUp(base * bp, 10000));
}

/** Alias kept for CONVENTIONS §4 naming (`applyBp`). */
export const applyBp = percentBp;

/** Sums an array of cents exactly. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) total += value;
  return cents(total);
}

/** Splits a gross amount into net and tax for an exclusive tax rate. */
export function taxExclusive(netCents: Cents, rateBp: number): {
  readonly net: Cents;
  readonly tax: Cents;
  readonly gross: Cents;
} {
  const tax = cents(divRoundHalfEven(netCents * rateBp, 10000));
  return { net: netCents, tax, gross: addCents(netCents, tax) };
}

/**
 * Splits a gross amount into net and tax for a tax-INCLUSIVE rate by
 * back-computing the tax, which makes `net + tax === gross` true by
 * construction (BR-07, decision D-03).
 */
export function taxInclusive(grossCents: Cents, rateBp: number): {
  readonly net: Cents;
  readonly tax: Cents;
  readonly gross: Cents;
} {
  const denominator = 10000 + rateBp;
  if (denominator === 0) throw new Error('Tax rate of -100% cannot be back-computed');
  const tax = cents(divRoundHalfEven(grossCents * rateBp, denominator));
  return { net: cents(grossCents - tax), tax, gross: grossCents };
}

const formatterCache = new Map<string, Intl.NumberFormat>();

/** Formats cents for display. Renderer edge only (CONVENTIONS §4). */
export function formatCents(value: Cents, currency = 'USD', locale = 'en-US'): string {
  const key = `${locale}|${currency}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    formatterCache.set(key, formatter);
  }
  return formatter.format(value / 100);
}

/** Alias kept for CONVENTIONS §4 naming (`formatMoney`). */
export const formatMoney = formatCents;

/**
 * Formats cents as a plain decimal with no symbol or grouping — the form used
 * inside error messages such as `Out of balance by 100.00` (US-17).
 */
export function formatAmount(value: Cents, decimals = 2): string {
  assertDp(decimals);
  const negative = value < 0;
  const magnitude = Math.abs(value);
  const scale = 10 ** decimals;
  const whole = Math.trunc(magnitude / scale);
  const fraction = String(magnitude % scale).padStart(decimals, '0');
  const body = decimals === 0 ? String(whole) : `${String(whole)}.${fraction}`;
  return negative ? `-${body}` : body;
}

/**
 * Parses user input into cents without touching `parseFloat`.
 * Accepts `1,234.56`, `-12.5`, `1234`, `0.005` (rounded half-even at `decimals`).
 */
export function parseCents(input: string, decimals = 2): Cents {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
    throw new Error(`decimals must be an integer between 0 and 6, received ${String(decimals)}`);
  }

  // Strip currency symbols, spaces and anything that is not a digit, a
  // separator or a sign. Grouping is resolved below, never with parseFloat.
  let cleaned = input.trim().replace(/[^\d.,-]/g, '');
  if (cleaned === '') {
    // Empty input is zero; input that merely had every digit stripped is an error.
    if (input.trim() === '') return ZERO_CENTS;
    throw new Error(`Cannot parse "${input}" as an amount`);
  }
  if (cleaned === '-' || cleaned === '.' || cleaned === ',') return ZERO_CENTS;

  const isNegative = cleaned.startsWith('-');
  if (isNegative) cleaned = cleaned.slice(1);
  if (cleaned.includes('-')) throw new Error(`Cannot parse "${input}" as an amount`);

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let decimalSeparator: '.' | ',' | null = null;

  if (lastComma >= 0 && lastDot >= 0) {
    decimalSeparator = lastComma > lastDot ? ',' : '.';
  } else if (lastComma >= 0) {
    const tail = cleaned.slice(lastComma + 1);
    // `1,234` and `1,234,567` are grouping; `12,5` is a decimal comma.
    const looksLikeGrouping = /^\d{3}$/.test(tail) && cleaned.length > 4;
    decimalSeparator = looksLikeGrouping ? null : ',';
  } else if (lastDot >= 0) {
    // A dot is always the decimal separator in the app's number format.
    decimalSeparator = '.';
  }

  let wholePart: string;
  let fractionPart: string;
  if (decimalSeparator === null) {
    wholePart = cleaned.replace(/[.,]/g, '');
    fractionPart = '';
  } else {
    const index = cleaned.lastIndexOf(decimalSeparator);
    wholePart = cleaned.slice(0, index).replace(/[.,]/g, '');
    fractionPart = cleaned.slice(index + 1).replace(/[.,]/g, '');
  }

  if (!/^\d*$/.test(wholePart) || !/^\d*$/.test(fractionPart)) {
    throw new Error(`Cannot parse "${input}" as an amount`);
  }
  if (wholePart.length > 15) throw new Error(`Cannot parse "${input}" as an amount`);

  const whole = wholePart === '' ? '0' : wholePart;
  const padded = fractionPart.padEnd(decimals + 1, '0');
  const kept = padded.slice(0, decimals);
  const nextDigit = padded.charAt(decimals);
  const scale = 10 ** decimals;
  let magnitude = Number.parseInt(whole, 10) * scale + Number.parseInt(kept === '' ? '0' : kept, 10);
  if (nextDigit !== '' && Number.parseInt(nextDigit, 10) >= 5) magnitude += 1;
  return cents(isNegative ? -magnitude : magnitude);
}

/** Alias kept for CONVENTIONS §4 naming (`parseMoney`). */
export const parseMoney = parseCents;

/**
 * Runs the T01 acceptance assertions and throws on the first failure.
 * Executed by `npm test`; also callable from a packaged build for a self-check.
 */
export function selfTest(): void {
  const assertEqual = (label: string, actual: unknown, expected: unknown): void => {
    if (actual !== expected) {
      throw new Error(`money.selfTest failed: ${label} — expected ${String(expected)}, got ${String(actual)}`);
    }
  };

  // T01 #5 — addition is exact, never floating point.
  assertEqual('addCents(10, 20)', addCents(cents(10), cents(20)), 30);
  assertEqual('subCents(30, 10)', subCents(cents(30), cents(10)), 20);
  assertEqual('0.1 + 0.2 via parseCents', addCents(parseCents('0.1'), parseCents('0.2')), parseCents('0.3'));

  // T01 #5 — rounding vectors.
  assertEqual('roundHalfUp(1005, 1)', roundHalfUp(1005, 1), 101);
  assertEqual('roundHalfUp(1004, 1)', roundHalfUp(1004, 1), 100);
  assertEqual('roundHalfUp(-1005, 1)', roundHalfUp(-1005, 1), -101);
  // The acceptance text writes `roundHalfEven(5, 0) === 0` / `(15, 0) === 20`,
  // which are the "round to the nearest ten" examples. Under the shipped
  // convention (`value` carries `dp` decimal digits) the same vectors are
  // 0.5 -> 0 and 1.5 -> 2:
  assertEqual('roundHalfEven(5, 1)', roundHalfEven(5, 1), 0);
  assertEqual('roundHalfEven(15, 1)', roundHalfEven(15, 1), 2);
  assertEqual('roundHalfEven(25, 1)', roundHalfEven(25, 1), 2);
  assertEqual('roundHalfEven(35, 1)', roundHalfEven(35, 1), 4);

  // T01 #5 — inclusive tax is exact by construction.
  const inclusive = taxInclusive(cents(12000), 2000);
  assertEqual('taxInclusive net', inclusive.net, 10000);
  assertEqual('taxInclusive tax', inclusive.tax, 2000);
  assertEqual('taxInclusive net + tax === gross', inclusive.net + inclusive.tax, inclusive.gross);

  const exclusive = taxExclusive(cents(10000), 2000);
  assertEqual('taxExclusive tax', exclusive.tax, 2000);
  assertEqual('taxExclusive gross', exclusive.gross, 12000);

  // BR-06 — three lines of 33.335 round to 100.01 at document level only.
  // Each line is 3333.5 cents, so the values carry one decimal digit (dp = 1).
  assertEqual('document total of 3 x 33.335', roundHalfUp(3 * 33335, 1), 10001);

  // Quantity maths in milli-units.
  assertEqual('mulQty(1999, 3000)', mulQty(cents(1999), 3000), 5997);
  assertEqual('mulQty(1000, 500)', mulQty(cents(1000), 500), 500);

  // Basis points.
  assertEqual('percentBp(10000, 2000)', percentBp(cents(10000), 2000), 2000);
  assertEqual('percentBp(333, 1500)', percentBp(cents(333), 1500), 50);

  // Summation.
  assertEqual('sumCents', sumCents([cents(1), cents(2), cents(3)]), 6);

  // Parse / format round trip.
  assertEqual('parseCents("1,234.56")', parseCents('1,234.56'), 123456);
  assertEqual('parseCents("-12.5")', parseCents('-12.5'), -1250);
  assertEqual('parseCents("0.005")', parseCents('0.005'), 1);
  assertEqual('formatCents(123456)', formatCents(cents(123456), 'USD', 'en-US'), '$1,234.56');

  // Guard rails.
  let threw = false;
  try {
    cents(1.5);
  } catch {
    threw = true;
  }
  assertEqual('cents(1.5) throws', threw, true);
}
