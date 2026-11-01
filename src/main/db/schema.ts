/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The complete schema, verbatim from ARCHITECTURE.md §B.2.
 *
 * Every table, index and CHECK constraint is here because a missing constraint
 * is a business rule (BR-01..25) that silently stops being enforced. `schema.ts`
 * is the only place DDL is written; `migrate.ts` is the only place it runs.
 */

/** Current schema version. Bump together with a new entry in `MIGRATIONS`. */
export const SCHEMA_VERSION = 10;

export const SCHEMA_SQL = `
-- ── identity & access ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
  email TEXT, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
  password_algo TEXT NOT NULL DEFAULT 'scrypt-n16384-r8-p1',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1, is_owner INTEGER NOT NULL DEFAULT 0,
  prefs_json TEXT NOT NULL DEFAULT '{}',
  failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
  last_login_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active, deleted_at);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0, permissions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id), role_id TEXT NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id));
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT);

-- ── audit (append-only, hash-chained) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE, actor_id TEXT, actor_name TEXT NOT NULL DEFAULT 'system',
  at TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, action TEXT NOT NULL,
  before_json TEXT, after_json TEXT, meta_json TEXT,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, at);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor_id, at);

-- ── configuration ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, legal_name TEXT, tax_id TEXT, address_json TEXT,
  logo_path TEXT, base_currency TEXT NOT NULL DEFAULT 'USD', fiscal_year_start_month INTEGER NOT NULL DEFAULT 1,
  date_format TEXT NOT NULL DEFAULT 'yyyy-MM-dd', number_format TEXT NOT NULL DEFAULT '1,234.56',
  industry_preset TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS fiscal_years (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS periods (
  id TEXT PRIMARY KEY, fiscal_year_id TEXT NOT NULL REFERENCES fiscal_years(id),
  name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked')),
  locked_at TEXT, locked_by TEXT, unlocked_at TEXT, unlocked_by TEXT);
CREATE INDEX IF NOT EXISTS idx_periods_range ON periods(start_date, end_date);

CREATE TABLE IF NOT EXISTS currencies (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT, decimals INTEGER NOT NULL DEFAULT 2,
  rate_bp INTEGER NOT NULL DEFAULT 10000, is_base INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS taxes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, rate_bp INTEGER NOT NULL,
  is_inclusive INTEGER NOT NULL DEFAULT 0, is_compound INTEGER NOT NULL DEFAULT 0,
  account_id TEXT REFERENCES accounts(id), is_archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS number_sequences (
  doc_type TEXT NOT NULL, fiscal_year_id TEXT NOT NULL, prefix TEXT NOT NULL DEFAULT '',
  padding INTEGER NOT NULL DEFAULT 5, next_value INTEGER NOT NULL DEFAULT 1,
  suffix TEXT NOT NULL DEFAULT '', PRIMARY KEY (doc_type, fiscal_year_id));

-- ── general ledger ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  parent_id TEXT REFERENCES accounts(id), is_postable INTEGER NOT NULL DEFAULT 1,
  currency TEXT, is_archived INTEGER NOT NULL DEFAULT 0, description TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(type, code);

CREATE TABLE IF NOT EXISTS journals (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, type TEXT NOT NULL
  CHECK (type IN ('general','sales','purchase','bank','cash','stock')),
  default_account_id TEXT REFERENCES accounts(id), is_active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY, number TEXT, journal_id TEXT NOT NULL REFERENCES journals(id),
  date TEXT NOT NULL, period_id TEXT NOT NULL REFERENCES periods(id),
  memo TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','reversed')),
  source_type TEXT, source_id TEXT, reverses_id TEXT REFERENCES journal_entries(id),
  posted_at TEXT, posted_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_je_date   ON journal_entries(date, status);
CREATE INDEX IF NOT EXISTS idx_je_source ON journal_entries(source_type, source_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  line_no INTEGER NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id),
  debit_cents INTEGER NOT NULL DEFAULT 0, credit_cents INTEGER NOT NULL DEFAULT 0,
  description TEXT, partner_type TEXT, partner_id TEXT, tax_id TEXT,
  CHECK (debit_cents >= 0 AND credit_cents >= 0 AND (debit_cents = 0 OR credit_cents = 0)));
CREATE INDEX IF NOT EXISTS idx_jl_entry   ON journal_lines(entry_id, line_no);
CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines(account_id);

-- ── AR / AP documents ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, number TEXT, customer_id TEXT NOT NULL REFERENCES customers(id),
  date TEXT NOT NULL, due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft','posted','partially_paid','paid','void')),
  currency TEXT NOT NULL, subtotal_cents INTEGER NOT NULL DEFAULT 0, discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0,
  paid_cents INTEGER NOT NULL DEFAULT 0, notes TEXT, terms TEXT,
  source_type TEXT, source_id TEXT, journal_entry_id TEXT REFERENCES journal_entries(id),
  period_id TEXT, custom_json TEXT NOT NULL DEFAULT '{}',
  posted_at TEXT, posted_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_inv_customer ON invoices(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_inv_status   ON invoices(status, due_date);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id),
  line_no INTEGER NOT NULL, product_id TEXT REFERENCES products(id), description TEXT NOT NULL,
  qty_milli INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL,
  discount_bp INTEGER NOT NULL DEFAULT 0, tax_id TEXT REFERENCES taxes(id),
  net_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0, account_id TEXT REFERENCES accounts(id));
CREATE INDEX IF NOT EXISTS idx_invl_invoice ON invoice_lines(invoice_id, line_no);

CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY, number TEXT, vendor_id TEXT NOT NULL REFERENCES vendors(id),
  vendor_ref TEXT, date TEXT NOT NULL, due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft','posted','partially_paid','paid','void','match_exception')),
  currency TEXT NOT NULL, subtotal_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0, paid_cents INTEGER NOT NULL DEFAULT 0,
  po_id TEXT, receipt_ids_json TEXT, match_state TEXT NOT NULL DEFAULT 'unchecked',
  exception_reason TEXT, approved_by TEXT, approved_at TEXT, notes TEXT,
  journal_entry_id TEXT REFERENCES journal_entries(id), period_id TEXT,
  posted_at TEXT, posted_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bill_vendor ON bills(vendor_id, status);

CREATE TABLE IF NOT EXISTS bill_lines (
  id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), line_no INTEGER NOT NULL,
  product_id TEXT REFERENCES products(id), description TEXT NOT NULL,
  qty_milli INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL,
  tax_id TEXT REFERENCES taxes(id), account_id TEXT REFERENCES accounts(id),
  po_price_cents INTEGER, received_qty_milli INTEGER,
  net_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0, match_status TEXT NOT NULL DEFAULT 'ok');

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, number TEXT, direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  partner_type TEXT NOT NULL CHECK (partner_type IN ('customer','vendor')),
  partner_id TEXT NOT NULL, date TEXT NOT NULL, method TEXT NOT NULL DEFAULT 'bank',
  reference TEXT, amount_cents INTEGER NOT NULL, unallocated_cents INTEGER NOT NULL,
  currency TEXT NOT NULL, bank_account_id TEXT REFERENCES accounts(id),
  journal_entry_id TEXT REFERENCES journal_entries(id), notes TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pay_partner ON payments(partner_type, partner_id);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('invoice','bill')), doc_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_alloc_doc ON payment_allocations(doc_type, doc_id);

-- ── partners & catalogue ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, legal_name TEXT, tax_id TEXT,
  email TEXT, phone TEXT, address_json TEXT, payment_terms_days INTEGER NOT NULL DEFAULT 0,
  price_list_id TEXT, credit_limit_cents INTEGER NOT NULL DEFAULT 0, currency TEXT,
  is_active INTEGER NOT NULL DEFAULT 1, notes TEXT, custom_json TEXT NOT NULL DEFAULT '{}',
  crm_account_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_cust_name ON customers(name);

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, legal_name TEXT, tax_id TEXT,
  email TEXT, phone TEXT, address_json TEXT, payment_terms_days INTEGER NOT NULL DEFAULT 0,
  currency TEXT, is_active INTEGER NOT NULL DEFAULT 1, notes TEXT,
  custom_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, barcode TEXT UNIQUE, name TEXT NOT NULL,
  description TEXT, uom TEXT NOT NULL DEFAULT 'unit', category TEXT,
  cost_method TEXT NOT NULL DEFAULT 'avco' CHECK (cost_method IN ('fifo','avco','standard')),
  standard_cost_cents INTEGER NOT NULL DEFAULT 0, base_price_cents INTEGER NOT NULL DEFAULT 0,
  tax_id TEXT REFERENCES taxes(id), reorder_point_milli INTEGER NOT NULL DEFAULT 0,
  is_stock_tracked INTEGER NOT NULL DEFAULT 1, is_active INTEGER NOT NULL DEFAULT 1,
  income_account_id TEXT REFERENCES accounts(id), expense_account_id TEXT REFERENCES accounts(id),
  inventory_account_id TEXT REFERENCES accounts(id),
  custom_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_prod_name ON products(name);

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, address_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY, warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  code TEXT NOT NULL, name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (warehouse_id, code));

CREATE TABLE IF NOT EXISTS stock_moves (
  id TEXT PRIMARY KEY, reference TEXT, type TEXT NOT NULL
  CHECK (type IN ('receipt','issue','transfer','adjustment')),
  product_id TEXT NOT NULL REFERENCES products(id),
  from_location_id TEXT REFERENCES locations(id), to_location_id TEXT REFERENCES locations(id),
  qty_milli INTEGER NOT NULL, unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  value_cents INTEGER NOT NULL DEFAULT 0, reason TEXT, status TEXT NOT NULL DEFAULT 'posted',
  source_type TEXT, source_id TEXT, moved_at TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS stock_quants (
  product_id TEXT NOT NULL REFERENCES products(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  qty_milli INTEGER NOT NULL DEFAULT 0, value_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, location_id));
CREATE INDEX IF NOT EXISTS idx_quant_loc ON stock_quants(location_id);

-- ── purchasing ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY, number TEXT, vendor_id TEXT NOT NULL REFERENCES vendors(id),
  date TEXT NOT NULL, expected_date TEXT, status TEXT NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft','confirmed','partially_received','received','cancelled')),
  currency TEXT NOT NULL, subtotal_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0, warehouse_id TEXT REFERENCES warehouses(id),
  notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS po_lines (
  id TEXT PRIMARY KEY, po_id TEXT NOT NULL REFERENCES purchase_orders(id), line_no INTEGER NOT NULL,
  product_id TEXT REFERENCES products(id), description TEXT NOT NULL,
  qty_milli INTEGER NOT NULL, received_milli INTEGER NOT NULL DEFAULT 0,
  unit_price_cents INTEGER NOT NULL, tax_id TEXT REFERENCES taxes(id),
  net_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id TEXT PRIMARY KEY, number TEXT, po_id TEXT REFERENCES purchase_orders(id),
  vendor_id TEXT NOT NULL REFERENCES vendors(id), date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id), location_id TEXT REFERENCES locations(id),
  notes TEXT, posted_at TEXT, posted_by TEXT, bill_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS gr_lines (
  id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES goods_receipts(id), line_no INTEGER NOT NULL,
  po_line_id TEXT REFERENCES po_lines(id), product_id TEXT NOT NULL REFERENCES products(id),
  qty_milli INTEGER NOT NULL, unit_cost_cents INTEGER NOT NULL,
  po_price_cents INTEGER, lot_ref TEXT);

-- ── sales ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_lists (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL,
  valid_from TEXT, valid_to TEXT, is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS price_list_items (
  id TEXT PRIMARY KEY, price_list_id TEXT NOT NULL REFERENCES price_lists(id),
  product_id TEXT NOT NULL REFERENCES products(id), price_cents INTEGER NOT NULL,
  min_qty_milli INTEGER NOT NULL DEFAULT 0, UNIQUE (price_list_id, product_id, min_qty_milli));

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY, number TEXT, customer_id TEXT NOT NULL REFERENCES customers(id),
  date TEXT NOT NULL, expiry_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft','sent','accepted','rejected','converted','expired')),
  currency TEXT NOT NULL, subtotal_cents INTEGER NOT NULL DEFAULT 0, discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT, terms TEXT, converted_order_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS quote_lines (
  id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id), line_no INTEGER NOT NULL,
  product_id TEXT REFERENCES products(id), description TEXT NOT NULL,
  qty_milli INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL,
  discount_bp INTEGER NOT NULL DEFAULT 0, tax_id TEXT REFERENCES taxes(id),
  price_source TEXT NOT NULL DEFAULT 'base',
  net_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS sales_orders (
  id TEXT PRIMARY KEY, number TEXT, customer_id TEXT NOT NULL REFERENCES customers(id),
  quote_id TEXT REFERENCES quotes(id), deal_id TEXT, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft','confirmed','partially_delivered','delivered','invoiced','cancelled')),
  currency TEXT NOT NULL, subtotal_cents INTEGER NOT NULL DEFAULT 0, discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0,
  warehouse_id TEXT REFERENCES warehouses(id), notes TEXT, terms TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS so_lines (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES sales_orders(id), line_no INTEGER NOT NULL,
  product_id TEXT REFERENCES products(id), description TEXT NOT NULL,
  qty_milli INTEGER NOT NULL, delivered_milli INTEGER NOT NULL DEFAULT 0,
  invoiced_milli INTEGER NOT NULL DEFAULT 0, unit_price_cents INTEGER NOT NULL,
  discount_bp INTEGER NOT NULL DEFAULT 0, tax_id TEXT REFERENCES taxes(id),
  net_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS sales_deliveries (
  id TEXT PRIMARY KEY, number TEXT, order_id TEXT REFERENCES sales_orders(id),
  customer_id TEXT NOT NULL REFERENCES customers(id), date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id), notes TEXT,
  posted_at TEXT, posted_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS delivery_lines (
  id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES sales_deliveries(id),
  so_line_id TEXT REFERENCES so_lines(id), product_id TEXT NOT NULL REFERENCES products(id),
  qty_milli INTEGER NOT NULL, unit_cost_cents INTEGER NOT NULL);

-- ── CRM ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS deal_stages (
  id TEXT PRIMARY KEY, pipeline_id TEXT NOT NULL REFERENCES pipelines(id), name TEXT NOT NULL,
  sort_order INTEGER NOT NULL, probability_bp INTEGER NOT NULL DEFAULT 0,
  is_won INTEGER NOT NULL DEFAULT 0, is_lost INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS crm_accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, industry TEXT, website TEXT, phone TEXT, email TEXT,
  address_json TEXT, owner_id TEXT REFERENCES users(id), customer_id TEXT REFERENCES customers(id),
  source TEXT, annual_revenue_cents INTEGER, employees INTEGER, notes TEXT,
  custom_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_crmacc_name ON crm_accounts(name);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES crm_accounts(id),
  first_name TEXT NOT NULL, last_name TEXT, title TEXT, email TEXT, phone TEXT, mobile TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0, notes TEXT, custom_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_contact_account ON contacts(account_id);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT, email TEXT, phone TEXT,
  source TEXT, status TEXT NOT NULL DEFAULT 'new'
  CHECK (status IN ('new','contacted','qualified','converted','disqualified')),
  estimated_value_cents INTEGER NOT NULL DEFAULT 0, owner_id TEXT REFERENCES users(id),
  notes TEXT, disqualify_reason TEXT, converted_account_id TEXT, converted_contact_id TEXT,
  converted_deal_id TEXT, converted_at TEXT, custom_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, account_id TEXT REFERENCES crm_accounts(id),
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id), stage_id TEXT NOT NULL REFERENCES deal_stages(id),
  owner_id TEXT REFERENCES users(id), value_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL, probability_bp INTEGER NOT NULL DEFAULT 0,
  expected_close_date TEXT, status TEXT NOT NULL DEFAULT 'open'
  CHECK (status IN ('open','won','lost')),
  lost_reason TEXT, won_at TEXT, lost_at TEXT, lead_id TEXT, sales_order_id TEXT,
  stage_changed_at TEXT NOT NULL, custom_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_deal_stage ON deals(pipeline_id, stage_id, status);
CREATE INDEX IF NOT EXISTS idx_deal_owner ON deals(owner_id, status);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('call','email','meeting','task','note','stage_changed','system')),
  subject TEXT NOT NULL, body TEXT, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id), due_at TEXT, completed_at TEXT, is_done INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_act_entity ON activities(entity, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_act_due    ON activities(is_done, due_at);

CREATE TABLE IF NOT EXISTS loss_reasons (id TEXT PRIMARY KEY, label TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);

-- ── extensibility & UX state ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY, entity TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','number','money','date','select','bool')),
  is_required INTEGER NOT NULL DEFAULT 0, options_json TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE (entity, key));

CREATE TABLE IF NOT EXISTS custom_values (
  entity TEXT NOT NULL, entity_id TEXT NOT NULL, field_id TEXT NOT NULL REFERENCES custom_fields(id),
  value_text TEXT, value_num INTEGER, value_date TEXT, value_bool INTEGER,
  PRIMARY KEY (entity, entity_id, field_id));
CREATE INDEX IF NOT EXISTS idx_cv_field ON custom_values(field_id, value_text);

CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), entity TEXT NOT NULL,
  name TEXT NOT NULL, config_json TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
  link TEXT, severity TEXT NOT NULL DEFAULT 'info', read_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(read_at, created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  filename TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT, bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_att_entity ON attachments(entity, entity_id);

CREATE TABLE IF NOT EXISTS license_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), edition TEXT NOT NULL DEFAULT 'community',
  licensee TEXT, email TEXT, seats INTEGER NOT NULL DEFAULT 1, features_json TEXT NOT NULL DEFAULT '[]',
  machine_id TEXT, key_hash TEXT, activated_at TEXT, last_seen_at TEXT,
  suspect_clock INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY, entity TEXT NOT NULL, filename TEXT NOT NULL, mapping_json TEXT NOT NULL,
  total_rows INTEGER NOT NULL DEFAULT 0, valid_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'staged',
  staged_json TEXT, committed_at TEXT, created_at TEXT NOT NULL);
`;
