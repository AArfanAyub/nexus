"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.V3_VERSION = exports.MIGRATION_V3_SQL = void 0;
/**
 * Migration v3 — the operations pass (T07 inventory, T08 purchasing & sales).
 *
 * Four kinds of change, all forward-only:
 *
 *   1. `stock_moves.type` grows `production_in` / `production_out`. SQLite cannot
 *      alter a CHECK constraint, so the table is rebuilt and copied. The rebuild
 *      recreates the v2 indexes, because dropping the table drops them with it —
 *      that is the one part of this file that is easy to get wrong, so the index
 *      statements are repeated verbatim rather than assumed.
 *   2. `stock_layers` — the FIFO cost layers. A layer is created by a receipt and
 *      consumed oldest-first by an issue; `remaining_milli` reaching zero retires
 *      it. FIFO valuation is `Σ remaining × unit_cost`, which is why valuation can
 *      be recomputed from moves alone.
 *   3. `uom_conversions` — per-product factors so a receipt in boxes lands in the
 *      base UoM. Stored in milli so a factor of 1/3 is representable.
 *   4. columns the document chains need to cross-reference both ways: the journal
 *      entry a receipt/delivery posted, the invoice a delivery produced, the
 *      payable account a vendor overrides, and the cached average cost.
 *
 * Every statement is `IF NOT EXISTS` or a one-time `ALTER`, and the whole file
 * runs inside the migration runner's transaction, so a failure leaves v2 intact.
 */
exports.MIGRATION_V3_SQL = `
-- ── 1. stock_moves: extend the move types (table rebuild) ────────────────────
CREATE TABLE IF NOT EXISTS stock_moves_v3 (
  id TEXT PRIMARY KEY, reference TEXT, type TEXT NOT NULL
  CHECK (type IN ('receipt','issue','transfer','adjustment','production_in','production_out')),
  product_id TEXT NOT NULL REFERENCES products(id),
  from_location_id TEXT REFERENCES locations(id), to_location_id TEXT REFERENCES locations(id),
  qty_milli INTEGER NOT NULL, unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  value_cents INTEGER NOT NULL DEFAULT 0, reason TEXT, status TEXT NOT NULL DEFAULT 'posted',
  source_type TEXT, source_id TEXT, moved_at TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  journal_entry_id TEXT REFERENCES journal_entries(id),
  override_reason TEXT
);
INSERT INTO stock_moves_v3
  (id, reference, type, product_id, from_location_id, to_location_id, qty_milli,
   unit_cost_cents, value_cents, reason, status, source_type, source_id, moved_at,
   created_by, created_at, journal_entry_id, override_reason)
SELECT
   id, reference, type, product_id, from_location_id, to_location_id, qty_milli,
   unit_cost_cents, value_cents, reason, status, source_type, source_id, moved_at,
   created_by, created_at, NULL, NULL
FROM stock_moves;
DROP TABLE stock_moves;
ALTER TABLE stock_moves_v3 RENAME TO stock_moves;

-- v2's index lived on the table that was just dropped.
CREATE INDEX IF NOT EXISTS idx_moves_prod    ON stock_moves(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_moves_prod_at ON stock_moves(product_id, moved_at);
CREATE INDEX IF NOT EXISTS idx_moves_from    ON stock_moves(from_location_id, moved_at);
CREATE INDEX IF NOT EXISTS idx_moves_to      ON stock_moves(to_location_id, moved_at);
CREATE INDEX IF NOT EXISTS idx_moves_type_at ON stock_moves(type, moved_at);
CREATE INDEX IF NOT EXISTS idx_moves_source  ON stock_moves(source_type, source_id);

-- ── 2. FIFO cost layers ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_layers (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  move_id TEXT REFERENCES stock_moves(id),
  qty_milli INTEGER NOT NULL,
  remaining_milli INTEGER NOT NULL,
  unit_cost_cents INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_layers_open ON stock_layers(product_id, location_id, received_at);
CREATE INDEX IF NOT EXISTS idx_layers_move ON stock_layers(move_id);

-- ── 3. unit-of-measure conversions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS uom_conversions (
  id TEXT PRIMARY KEY,
  product_id TEXT REFERENCES products(id),
  from_uom TEXT NOT NULL,
  to_uom TEXT NOT NULL,
  factor_milli INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (product_id, from_uom, to_uom)
);

-- ── 4. cross-references and cached costs ─────────────────────────────────────
ALTER TABLE products ADD COLUMN avg_cost_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vendors  ADD COLUMN payable_account_id TEXT REFERENCES accounts(id);
ALTER TABLE goods_receipts ADD COLUMN journal_entry_id TEXT REFERENCES journal_entries(id);
ALTER TABLE sales_deliveries ADD COLUMN journal_entry_id TEXT REFERENCES journal_entries(id);
ALTER TABLE sales_deliveries ADD COLUMN invoice_id TEXT REFERENCES invoices(id);

-- ── 5. indexes for the operations list filters ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_po_vendor_dt  ON purchase_orders(vendor_id, date);
CREATE INDEX IF NOT EXISTS idx_po_status_dt  ON purchase_orders(status, date);
CREATE INDEX IF NOT EXISTS idx_po_number     ON purchase_orders(number);
CREATE INDEX IF NOT EXISTS idx_pol_po        ON po_lines(po_id, line_no);
CREATE INDEX IF NOT EXISTS idx_gr_po         ON goods_receipts(po_id, status);
CREATE INDEX IF NOT EXISTS idx_gr_vendor_dt  ON goods_receipts(vendor_id, date);
CREATE INDEX IF NOT EXISTS idx_grl_receipt   ON gr_lines(receipt_id, line_no);
CREATE INDEX IF NOT EXISTS idx_grl_poline    ON gr_lines(po_line_id);
CREATE INDEX IF NOT EXISTS idx_quote_cust    ON quotes(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_quote_status  ON quotes(status, expiry_date);
CREATE INDEX IF NOT EXISTS idx_ql_quote      ON quote_lines(quote_id, line_no);
CREATE INDEX IF NOT EXISTS idx_so_cust       ON sales_orders(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_so_status_dt  ON sales_orders(status, date);
CREATE INDEX IF NOT EXISTS idx_so_number     ON sales_orders(number);
CREATE INDEX IF NOT EXISTS idx_sol_order     ON so_lines(order_id, line_no);
CREATE INDEX IF NOT EXISTS idx_sd_order      ON sales_deliveries(order_id, status);
CREATE INDEX IF NOT EXISTS idx_sdl_delivery  ON delivery_lines(delivery_id);
CREATE INDEX IF NOT EXISTS idx_pli_list      ON price_list_items(price_list_id, product_id, min_qty_milli);
CREATE INDEX IF NOT EXISTS idx_pl_default    ON price_lists(is_default, is_active);
CREATE INDEX IF NOT EXISTS idx_uom_product   ON uom_conversions(product_id, from_uom);
`;
/** The version this build writes. `migrate.ts` asserts MIGRATIONS matches. */
exports.V3_VERSION = 3;
//# sourceMappingURL=migrate.v3.js.map