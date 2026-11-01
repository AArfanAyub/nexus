"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.V8_VERSION = exports.MIGRATION_V8_SQL = void 0;
/**
 * v8 — the indexes global search was always supposed to use.
 *
 * ## What was wrong
 *
 * Every search source is a prefix match, and every prefix match was a **full
 * table scan**. `EXPLAIN QUERY PLAN` said so plainly:
 *
 *     SCAN invoices                      -- 88 ms over 100 000 rows
 *     SEARCH invoices USING INDEX …      -- 0.4 ms, same query, same rows
 *
 * The difference is the collation. `LIKE` is case-insensitive for ASCII unless
 * `PRAGMA case_sensitive_like` is on, and SQLite will only use an index for a
 * case-insensitive `LIKE` when that index is built with `COLLATE NOCASE`. The
 * indexes from v2 and v5 are BINARY, so they were skipped: correct, and useless.
 *
 * `case_sensitive_like = ON` would have been the one-line fix and the wrong one
 * — an operator who types `acme` must find `Acme Industries`.
 *
 * ## Cost
 *
 * One extra index per searched column. They are only on text columns that a
 * human types into a search box; amounts, dates and ids are untouched. The
 * measured effect on the 100 000-invoice dataset is in `docs/PERF.md`.
 *
 * `contacts` is deliberately absent: the search matches the concatenated full
 * name, which is an expression rather than a column, and the table is small
 * enough that scanning it costs less than the index would.
 */
exports.MIGRATION_V8_SQL = `
-- ── master data ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cust_name_nc  ON customers(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_cust_code_nc  ON customers(code COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_vend_name_nc  ON vendors(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_vend_code_nc  ON vendors(code COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_prod_name_nc  ON products(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_prod_sku_nc   ON products(sku COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_crmacc_name_nc ON crm_accounts(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_crmacc_domain_nc ON crm_accounts(domain COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_lead_name_nc  ON leads(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_lead_company_nc ON leads(company COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_deal_name_nc  ON deals(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_acct_code_nc  ON accounts(code COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_acct_name_nc  ON accounts(name COLLATE NOCASE);

-- ── documents: found by number ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_inv_number_nc  ON invoices(number COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_bill_number_nc ON bills(number COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_quote_number_nc ON quotes(number COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_so_number_nc   ON sales_orders(number COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_je_number_nc   ON journal_entries(number COLLATE NOCASE);
`;
exports.V8_VERSION = 8;
//# sourceMappingURL=migrate.v8.js.map