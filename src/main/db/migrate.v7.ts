/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * v7 — a balance rollup for the cold store.
 *
 * ## The defect this fixes
 *
 * `archivedBalances()` answered "what do the archived entries add up to?" by
 * reading `archive_records` and gunzipping every payload. Two things were wrong
 * with that:
 *
 *  1. **It was wrong.** The query carried `LIMIT 5000` with no `ORDER BY`, and
 *     the 300 000-line scale proof archived **100 000** journal entries — one
 *     record each. So a trial balance after a housekeeping run saw 5 % of the
 *     archived activity. It still *balanced* (both sides were truncated equally),
 *     which is exactly why nobody would have noticed.
 *  2. **It was slow.** Gunzipping and parsing 5 000 payloads cost 900 ms, and
 *     the honest version — all 100 000 — would have cost twenty seconds.
 *
 * ## The shape of the fix
 *
 * Archive time is the right time to aggregate: the rows are in memory and the
 * run is already the most expensive thing the product does. One row per
 * `(date, account)` per archive run, added with `ON CONFLICT DO UPDATE`, keeps
 * the table proportional to *days × accounts* (a few thousand rows) rather than
 * to entries. A dated report then reads a handful of rows instead of parsing a
 * hundred thousand payloads.
 *
 * `restoreArchived()` subtracts what it puts back, so restoring a record moves
 * its contribution from the cold store to the live ledger without double
 * counting.
 */

export const MIGRATION_V7_SQL = `
CREATE TABLE IF NOT EXISTS archive_balances (
  date TEXT NOT NULL,
  account_id TEXT NOT NULL,
  debit_cents INTEGER NOT NULL DEFAULT 0,
  credit_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, account_id)
);
CREATE INDEX IF NOT EXISTS idx_archive_balances_date ON archive_balances(date);
`;

export const V7_VERSION = 7;
