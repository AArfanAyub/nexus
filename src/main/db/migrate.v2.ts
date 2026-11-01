/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Migration v2 — the scale pass (requirement R1).
 *
 * Three kinds of change, all additive:
 *   1. covering indexes for the filters the list screens actually use, so a
 *      100k-row table is an index range scan and not a table scan
 *   2. `archive_records`, the cold store for closed/immutable history
 *   3. `report_cache`, so a dashboard KPI is not recomputed on every navigation
 *
 * v1 is never edited: an installed database has to be able to reach v2 by
 * applying this file, and a fresh one has to reach v2 by applying v1 then v2.
 * Both end in the same state because every statement is `IF NOT EXISTS`.
 */

export const MIGRATION_V2_SQL = `
-- ── hot filter indexes (R1) ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cust_active   ON customers(is_active, name, code);
CREATE INDEX IF NOT EXISTS idx_cust_code     ON customers(code);
CREATE INDEX IF NOT EXISTS idx_vend_active   ON vendors(is_active, name, code);
CREATE INDEX IF NOT EXISTS idx_prod_sku      ON products(sku);
CREATE INDEX IF NOT EXISTS idx_prod_active   ON products(is_active, name);
CREATE INDEX IF NOT EXISTS idx_inv_due       ON invoices(status, due_date);
CREATE INDEX IF NOT EXISTS idx_inv_cust_date ON invoices(customer_id, date);
CREATE INDEX IF NOT EXISTS idx_inv_number    ON invoices(number);
CREATE INDEX IF NOT EXISTS idx_bill_due      ON bills(status, due_date);
CREATE INDEX IF NOT EXISTS idx_bill_vend_dt  ON bills(vendor_id, date);
CREATE INDEX IF NOT EXISTS idx_jl_acct_entry ON journal_lines(account_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_je_date_jr    ON journal_entries(date, journal_id);
CREATE INDEX IF NOT EXISTS idx_je_status_dt  ON journal_entries(status, date);
CREATE INDEX IF NOT EXISTS idx_deal_stage    ON deals(stage_id, owner_id);
-- v1 already indexes (is_done, due_at); this covers "what did I finish, newest
-- first", which is what the activity timeline asks for.
CREATE INDEX IF NOT EXISTS idx_activity_done ON activities(is_done, completed_at);
CREATE INDEX IF NOT EXISTS idx_moves_prod    ON stock_moves(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_at      ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_alloc_payment ON payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_pay_date      ON payments(date, direction);

-- ── cold store for closed history (R1) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS archive_records (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_gz BLOB NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 1,
  sha256 TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  archived_by TEXT,
  reason TEXT,
  range_start TEXT,
  range_end TEXT
);
CREATE INDEX IF NOT EXISTS idx_archive_table ON archive_records(table_name, archived_at);
CREATE INDEX IF NOT EXISTS idx_archive_range ON archive_records(table_name, range_start, range_end);
CREATE INDEX IF NOT EXISTS idx_archive_entity ON archive_records(table_name, entity_id);

-- ── report cache (R1) ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_cache (
  key TEXT PRIMARY KEY,
  payload_gz BLOB NOT NULL,
  computed_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cache_time ON report_cache(computed_at);
`;

/** The version this build writes. `migrate.ts` asserts MIGRATIONS matches. */
export const V2_VERSION = 2;
