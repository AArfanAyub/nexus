"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.V9_VERSION = exports.MIGRATION_V9_SQL = void 0;
/**
 * v9 — indexes on every foreign key that points at the ledger.
 *
 * ## Why
 *
 * SQLite enforces a foreign key **on delete** by looking for child rows. With no
 * index on the child column it does that with a full table scan — per deleted
 * row. Archiving 50 000 journal entries therefore scanned `invoices` (100 000
 * rows) 50 000 times, and the run that should take two minutes did not finish in
 * thirteen. The plan for the delete is invisible in `EXPLAIN QUERY PLAN`, which
 * is why this was found by timing the archive table by table rather than by
 * reading a query plan.
 *
 * ## Which columns
 *
 * The six `journal_entry_id` columns and the self-reference `reverses_id`. The
 * rest of the schema's foreign keys are already covered: `journal_lines.entry_id`
 * by `idx_jl_entry`, `invoice_lines.invoice_id` by `idx_invl_invoice`,
 * `payment_allocations.payment_id` by `idx_alloc_payment`.
 *
 * These are pure cost, no benefit to any read path — they exist so that deleting
 * a row is proportional to what it references rather than to the size of the
 * company.
 */
exports.MIGRATION_V9_SQL = `
CREATE INDEX IF NOT EXISTS idx_inv_entry    ON invoices(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_bill_entry   ON bills(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_pay_entry    ON payments(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_moves_entry  ON stock_moves(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_gr_entry     ON goods_receipts(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_sd_entry     ON sales_deliveries(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_je_reverses  ON journal_entries(reverses_id);
`;
exports.V9_VERSION = 9;
//# sourceMappingURL=migrate.v9.js.map