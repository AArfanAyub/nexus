"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.V5_VERSION = exports.MIGRATION_V5_SQL = void 0;
/**
 * v5 — the indexes the 300 000-line scale proof asked for.
 *
 * Every statement here came out of a measurement, not a guess (`scripts/perf.mjs`).
 * On a 10 000-customer / 100 000-invoice company the trial balance took 3.4 s and
 * global search 580 ms; the plans showed why:
 *
 *  - the trial balance drove from `journal_entries` and then, for each of 300 000
 *    lines, probed `idx_jl_entry` and went to the table for `debit_cents` /
 *    `credit_cents`, because `idx_jl_entry(entry_id, line_no)` does not carry the
 *    amounts. A covering index turns 300 000 table lookups into 300 000 index
 *    reads;
 *  - every document table was searched with `ORDER BY date DESC LIMIT n` and no
 *    index on `date`, so SQLite had to scan the whole table and sort it before it
 *    could honour the LIMIT. An index on the sort column lets the scan stop as
 *    soon as it has enough rows;
 *  - `bills`, `quotes` and `sales_orders` had no index on `number`, so the
 *    prefix pass — the one that is supposed to be fast — scanned them too.
 *
 * All of these are `IF NOT EXISTS`, so this migration is safe to re-run and safe
 * on a database created after it.
 */
exports.MIGRATION_V5_SQL = `
-- ── 1. covering indexes for the ledger aggregates ───────────────────────────
-- The trial balance and every account balance sum debit/credit per account. With
-- the amounts in the index, the aggregate never touches the table.
CREATE INDEX IF NOT EXISTS idx_jl_entry_cover
  ON journal_lines(entry_id, account_id, debit_cents, credit_cents);
CREATE INDEX IF NOT EXISTS idx_jl_account_cover
  ON journal_lines(account_id, debit_cents, credit_cents);

-- ── 2. the sort column of every document list ───────────────────────────────
-- A list is always "newest first, one page"; without this the page is a full
-- scan plus a sort of the entire table.
CREATE INDEX IF NOT EXISTS idx_inv_date      ON invoices(date);
CREATE INDEX IF NOT EXISTS idx_bill_date     ON bills(date);
CREATE INDEX IF NOT EXISTS idx_quote_date    ON quotes(date);
CREATE INDEX IF NOT EXISTS idx_so_date       ON sales_orders(date);
CREATE INDEX IF NOT EXISTS idx_je_number     ON journal_entries(number);

-- ── 3. the prefix pass of global search ─────────────────────────────────────
-- products(name), customers(name), crm_accounts(name) and invoices(number)
-- already had an index from the base schema or v2; only the gaps are filled here.
CREATE INDEX IF NOT EXISTS idx_bill_number   ON bills(number);
CREATE INDEX IF NOT EXISTS idx_quote_number  ON quotes(number);
CREATE INDEX IF NOT EXISTS idx_so_number     ON sales_orders(number);
CREATE INDEX IF NOT EXISTS idx_vend_name     ON vendors(name);
CREATE INDEX IF NOT EXISTS idx_contact_name  ON contacts(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_lead_name     ON leads(name);
CREATE INDEX IF NOT EXISTS idx_deal_name     ON deals(name);
CREATE INDEX IF NOT EXISTS idx_acct_name     ON accounts(name);
`;
exports.V5_VERSION = 5;
//# sourceMappingURL=migrate.v5.js.map