/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/** Date helpers: UTC only, no `Date` object ever leaves this module. */

const assert = require('node:assert/strict');
const test = require('node:test');

const dates = require('../dist/main/shared/dates.js');

test('nowIso and todayIso agree', () => {
  const now = dates.nowIso();
  assert.match(now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(dates.todayIso(), now.slice(0, 10));
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(dates.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(dates.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dates.addDays('2026-03-01', -1), '2026-02-28');
});

test('addMonths clamps to the last valid day', () => {
  assert.equal(dates.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(dates.addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(dates.addMonths('2026-08-31', 1), '2026-09-30');
  assert.equal(dates.addMonths('2026-01-15', 12), '2027-01-15');
});

test('monthRange covers the whole month', () => {
  assert.deepEqual(dates.monthRange('2026-02-11'), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(dates.monthRange('2024-02-11'), { start: '2024-02-01', end: '2024-02-29' });
});

test('fiscalYearRange honours the start month', () => {
  assert.deepEqual(dates.fiscalYearRange('2026-02-11', 1), { start: '2026-01-01', end: '2026-12-31' });
  assert.deepEqual(dates.fiscalYearRange('2026-02-11', 4), { start: '2025-04-01', end: '2026-03-31' });
  assert.deepEqual(dates.fiscalYearRange('2026-04-01', 4), { start: '2026-04-01', end: '2027-03-31' });
});

test('isSamePeriod compares against a window', () => {
  const range = dates.monthRange('2026-02-11');
  assert.equal(dates.isSamePeriod('2026-02-01', '2026-02-28', range), true);
  assert.equal(dates.isSamePeriod('2026-02-01', '2026-03-01', range), false);
});

test('formatDate substitutes tokens', () => {
  assert.equal(dates.formatDate('2026-02-11', 'en-US', 'yyyy-MM-dd'), '2026-02-11');
  assert.equal(dates.formatDate('2026-02-11', 'en-US', 'dd/MM/yyyy'), '11/02/2026');
  assert.equal(dates.formatDate('2026-02-11', 'en-US', 'MMM d, yyyy'), 'Feb 11, 2026');
  assert.equal(dates.formatDate('2026-02-11T09:41:00.000Z', 'en-US', 'yyyy-MM-dd HH:mm'), '2026-02-11 09:41');
});

test('daysBetween is signed and exact across DST-free UTC', () => {
  assert.equal(dates.daysBetween('2026-01-01', '2026-01-31'), 30);
  assert.equal(dates.daysBetween('2026-01-31', '2026-01-01'), -30);
});

test('isValidDate rejects impossible dates', () => {
  assert.equal(dates.isValidDate('2026-02-28'), true);
  assert.equal(dates.isValidDate('2026-02-30'), false);
  assert.equal(dates.isValidDate('2026-2-3'), false);
});

test('fiscalPeriods splits a year into 12 periods', () => {
  const periods = dates.fiscalPeriods(1, '2026-02-11', 12);
  assert.equal(periods.length, 12);
  assert.deepEqual(periods[0], { name: 'P01', start: '2026-01-01', end: '2026-01-31' });
  assert.deepEqual(periods[11], { name: 'P12', start: '2026-12-01', end: '2026-12-31' });
});
