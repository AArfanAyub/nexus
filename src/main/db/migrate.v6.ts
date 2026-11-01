/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * v6 — the posting date travels with the ledger line.
 *
 * ## Why this exists
 *
 * A trial balance over 300 000 journal lines took **1.5 s** after v5 added the
 * covering indexes (budget: 600 ms). The plan looked ideal — drive from
 * `journal_entries` by status and date, then read each entry's lines from a
 * covering index — so the cost was not a missing index but the *shape* of the
 * join: 150 000 separate b-tree descents into `journal_lines`, one per entry,
 * measured at 12 µs each in the wasm build.
 *
 * The aggregate itself is cheap when it can scan: summing `journal_lines` in
 * account order takes 142 ms for the same 300 000 rows. What it cannot do is
 * filter by a date that lives in the parent table.
 *
 * So the line carries the date. `posted_date` is **NULL for a draft and the
 * entry's date once posted**, which encodes the status filter as well: a NULL
 * never satisfies `>=`/`<=`, so drafts drop out of every dated report without a
 * second column and without a join.
 *
 * ## Why this is a copy and not a second source of truth
 *
 * A posted entry is immutable — there is no code path that edits `date` or
 * moves an entry back to draft — so the copy cannot drift. The one transition
 * that changes either value (draft → posted) writes both rows in the same
 * transaction, and `tests/core.test.cjs` asserts that every line agrees with its
 * entry. This is the standard shape of a general-ledger line table, and it is
 * recorded in `DECISIONS.md`.
 *
 * The backfill is a single `UPDATE ... FROM` over the existing lines. On a
 * 300 000-line database that is the most expensive migration this product has
 * ever shipped; `docs/PERF.md` records how long it took so the cost is known
 * rather than discovered.
 */

export const MIGRATION_V6_SQL = `
-- ── 1. the column ───────────────────────────────────────────────────────────
ALTER TABLE journal_lines ADD COLUMN posted_date TEXT;

-- ── 2. backfill: posted entries only, so a draft stays out of every report ──
UPDATE journal_lines
   SET posted_date = (SELECT e.date FROM journal_entries e
                       WHERE e.id = journal_lines.entry_id AND e.status = 'posted');

-- ── 3. the index the aggregate actually wants ───────────────────────────────
-- date first, then account, then the two amounts: the report range-scans by
-- date and never touches the table. Grouping by account still costs a sort of
-- the matched rows, which is why the account-first index below exists as well.
CREATE INDEX IF NOT EXISTS idx_jl_posted_cover
  ON journal_lines(posted_date, account_id, debit_cents, credit_cents);

-- Account first lets a report group by account without a temporary B-tree, at
-- the cost of scanning every row for a narrow date range. Both plans are
-- measured in docs/PERF.md; SQLite picks per query, and for the full-range
-- trial balance this is the one that wins.
CREATE INDEX IF NOT EXISTS idx_jl_account_date_cover
  ON journal_lines(account_id, posted_date, debit_cents, credit_cents);
`;

export const V6_VERSION = 6;
