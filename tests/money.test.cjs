/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * T01 acceptance #5 — the money contract.
 * Runs against the compiled CommonJS output, i.e. exactly what the main process
 * loads at runtime. `npm test` builds first.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const money = require('../dist/main/shared/money.js');

const { cents, addCents, subCents, mulQty, percentBp, roundHalfUp, roundHalfEven } = money;

test('selfTest passes (T01 acceptance #5)', () => {
  assert.doesNotThrow(() => money.selfTest());
});

test('addition is exact and never floating point', () => {
  assert.equal(addCents(cents(10), cents(20)), 30);
  assert.equal(addCents(money.parseCents('0.1'), money.parseCents('0.2')), money.parseCents('0.3'));
  assert.equal(subCents(cents(100), cents(33)), 67);
});

test('roundHalfUp rounds half away from zero', () => {
  assert.equal(roundHalfUp(1005, 1), 101);
  assert.equal(roundHalfUp(1004, 1), 100);
  assert.equal(roundHalfUp(-1005, 1), -101);
  assert.equal(roundHalfUp(1005, 0), 1005);
});

test('roundHalfEven ties to the even neighbour', () => {
  assert.equal(roundHalfEven(5, 1), 0); // 0.5 -> 0
  assert.equal(roundHalfEven(15, 1), 2); // 1.5 -> 2
  assert.equal(roundHalfEven(25, 1), 2); // 2.5 -> 2
  assert.equal(roundHalfEven(35, 1), 4); // 3.5 -> 4
});

test('inclusive tax back-computes so net + tax === gross (BR-07)', () => {
  const split = money.taxInclusive(cents(12000), 2000);
  assert.equal(split.net, 10000);
  assert.equal(split.tax, 2000);
  assert.equal(split.net + split.tax, split.gross);

  // 100.00 @ 20% inclusive, and an awkward one: 33.33 @ 17.5%
  const awkward = money.taxInclusive(cents(3333), 1750);
  assert.equal(awkward.net + awkward.tax, 3333);
});

test('exclusive tax rounds per line with half-to-even', () => {
  const split = money.taxExclusive(cents(10000), 2000);
  assert.equal(split.tax, 2000);
  assert.equal(split.gross, 12000);
});

test('quantities are milli-units', () => {
  assert.equal(mulQty(cents(1999), 3000), 5997);
  assert.equal(mulQty(cents(1000), 1), 1);
  assert.equal(mulQty(cents(1000), 500), 500);
});

test('basis points', () => {
  assert.equal(percentBp(cents(10000), 2000), 2000);
  assert.equal(percentBp(cents(333), 1500), 50);
});

test('three lines of 33.335 total 100.01 at document level (BR-06)', () => {
  // 33.335 = 3333.5 cents per line, so the sum carries one decimal digit.
  assert.equal(roundHalfUp(3 * 33335, 1), 10001);
});

test('parseCents never uses floating point', () => {
  assert.equal(money.parseCents('1,234.56'), 123456);
  assert.equal(money.parseCents('-12.5'), -1250);
  assert.equal(money.parseCents('0'), 0);
  assert.equal(money.parseCents('0.005'), 1);
  assert.equal(money.parseCents(''), 0);
  assert.throws(() => money.parseCents('abc'));
});

test('formatCents is locale aware', () => {
  assert.equal(money.formatCents(cents(123456), 'USD', 'en-US'), '$1,234.56');
  assert.equal(money.formatCents(cents(123456), 'EUR', 'de-DE'), '1.234,56\u00a0€');
});

test('cents() refuses fractional input', () => {
  assert.throws(() => cents(1.5), /integer/);
});
