"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.nowIso = nowIso;
exports.todayIso = todayIso;
exports.isValidDate = isValidDate;
exports.isValidTimestamp = isValidTimestamp;
exports.addDays = addDays;
exports.addMonths = addMonths;
exports.daysBetween = daysBetween;
exports.startOfMonth = startOfMonth;
exports.endOfMonth = endOfMonth;
exports.monthRange = monthRange;
exports.fiscalYearRange = fiscalYearRange;
exports.fiscalPeriods = fiscalPeriods;
exports.isSamePeriod = isSamePeriod;
exports.isWithin = isWithin;
exports.formatDate = formatDate;
exports.relativeDay = relativeDay;
/**
 * ISO-8601 UTC helpers. Every stored timestamp is `nowIso()`; every stored
 * date-only column is `todayIso()` (`YYYY-MM-DD`). `Date` objects never cross
 * an IPC boundary (CONVENTIONS §5).
 */
const MS_PER_DAY = 86_400_000;
/** `2026-02-11T09:41:00.000Z` */
function nowIso() {
    return new Date().toISOString();
}
/** `2026-02-11` */
function todayIso() {
    return nowIso().slice(0, 10);
}
/** True when `value` is a well-formed `YYYY-MM-DD` calendar date. */
function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const time = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isNaN(time))
        return false;
    return new Date(time).toISOString().slice(0, 10) === value;
}
/** True when `value` is a well-formed ISO-8601 UTC timestamp. */
function isValidTimestamp(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value))
        return false;
    return !Number.isNaN(Date.parse(value));
}
function toUtcDate(iso) {
    const normalised = iso.length === 10 ? `${iso}T00:00:00.000Z` : iso;
    const date = new Date(normalised);
    if (Number.isNaN(date.getTime()))
        throw new Error(`Invalid ISO date: ${iso}`);
    return date;
}
function dateOnly(date) {
    return date.toISOString().slice(0, 10);
}
/** Adds (or subtracts) whole days, DST-free because everything is UTC. */
function addDays(iso, days) {
    if (!Number.isInteger(days))
        throw new Error('addDays expects an integer day count');
    const date = toUtcDate(iso);
    return dateOnly(new Date(date.getTime() + days * MS_PER_DAY));
}
/** Adds whole months, clamping to the last valid day (Jan 31 + 1 → Feb 28/29). */
function addMonths(iso, months) {
    if (!Number.isInteger(months))
        throw new Error('addMonths expects an integer month count');
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
function daysBetween(from, to) {
    const start = toUtcDate(from).getTime();
    const end = toUtcDate(to).getTime();
    return Math.round((end - start) / MS_PER_DAY);
}
/** First day of the calendar month containing `iso`. */
function startOfMonth(iso) {
    return `${iso.slice(0, 7)}-01`;
}
/** Last day of the calendar month containing `iso`. */
function endOfMonth(iso) {
    const date = toUtcDate(iso);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    return dateOnly(last);
}
/** Calendar month boundaries for the month containing `iso`. */
function monthRange(iso) {
    return { start: startOfMonth(iso), end: endOfMonth(iso) };
}
/**
 * Fiscal year boundaries for the year containing `iso`.
 * `fiscalStartMonth` is 1-based (1 = January).
 */
function fiscalYearRange(iso, fiscalStartMonth = 1) {
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
function fiscalPeriods(fiscalStartMonth, iso, periodsPerYear = 12) {
    if (!Number.isInteger(periodsPerYear) || periodsPerYear < 1 || periodsPerYear > 12) {
        throw new Error('periodsPerYear must be 1..12');
    }
    const monthsPerPeriod = 12 / periodsPerYear;
    if (!Number.isInteger(monthsPerPeriod)) {
        throw new Error('periodsPerYear must divide 12 evenly');
    }
    const year = fiscalYearRange(iso, fiscalStartMonth);
    const periods = [];
    for (let index = 0; index < periodsPerYear; index += 1) {
        const start = addMonths(year.start, index * monthsPerPeriod);
        const end = addDays(addMonths(start, monthsPerPeriod), -1);
        periods.push({ name: `P${String(index + 1).padStart(2, '0')}`, start, end });
    }
    return periods;
}
/** True when both dates fall inside the same `[start, end]` window. */
function isSamePeriod(a, b, range) {
    const inRange = (value) => value >= range.start && value <= range.end;
    return inRange(a) && inRange(b);
}
/** True when `date` is within `[start, end]` inclusive. */
function isWithin(date, start, end) {
    return date >= start && date <= end;
}
const MONTH_LONG_CACHE = new Map();
const MONTH_SHORT_CACHE = new Map();
function monthName(monthIndex, locale, long) {
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
function formatDate(iso, locale = 'en-US', pattern = 'yyyy-MM-dd') {
    const date = toUtcDate(iso);
    const hasTime = iso.length > 10;
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();
    const seconds = date.getUTCSeconds();
    const pad = (value) => String(value).padStart(2, '0');
    const tokens = [
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
function relativeDay(iso, reference = todayIso(), locale = 'en-US') {
    const delta = daysBetween(iso.slice(0, 10), reference);
    if (delta === 0)
        return 'Today';
    if (delta === 1)
        return 'Yesterday';
    if (delta === -1)
        return 'Tomorrow';
    if (delta > 1 && delta <= 30)
        return `${String(delta)} days ago`;
    if (delta < -1 && delta >= -30)
        return `in ${String(-delta)} days`;
    return formatDate(iso, locale);
}
//# sourceMappingURL=dates.js.map