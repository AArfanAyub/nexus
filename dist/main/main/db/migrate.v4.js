"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.V4_VERSION = exports.MIGRATION_V4_SQL = void 0;
/**
 * Migration v4 — the CRM pass (T09) and the admin pass (T10).
 *
 * Three kinds of change:
 *
 *   1. `leads` is rebuilt. The v1 CHECK allowed `disqualified`; the product now
 *      speaks of a lead being **lost**, with a reason, because a lead that is
 *      neither converted nor lost is indistinguishable from one nobody has called
 *      yet. The rebuild also adds `score` (0–100, used to sort the inbox) and
 *      `loss_reason`. Existing `disqualified` rows are carried over as `lost`
 *      with their `disqualify_reason` preserved, so no history is rewritten.
 *   2. Columns the CRM screens read but v1 never had: account health, a contact
 *      owner, a deal's primary contact, and a colour token on each stage so the
 *      Kanban dot is data rather than a hard-coded list in the renderer.
 *   3. Indexes for every foreign key the CRM and admin lists filter on. A list
 *      screen that sorts by expected close date on 10k deals is a full scan
 *      without one.
 *
 * The whole file runs inside the migration runner's transaction, so a failure
 * leaves v3 intact.
 */
exports.MIGRATION_V4_SQL = `
-- ── 1. leads: status vocabulary + score + loss reason (table rebuild) ────────
CREATE TABLE IF NOT EXISTS leads_v4 (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT, email TEXT, phone TEXT,
  source TEXT, status TEXT NOT NULL DEFAULT 'new'
  CHECK (status IN ('new','contacted','qualified','converted','lost')),
  score INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  estimated_value_cents INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT REFERENCES users(id),
  notes TEXT, loss_reason TEXT,
  converted_account_id TEXT, converted_contact_id TEXT, converted_deal_id TEXT,
  converted_at TEXT,
  custom_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO leads_v4
  (id, name, company, email, phone, source, status, score, estimated_value_cents,
   owner_id, notes, loss_reason, converted_account_id, converted_contact_id,
   converted_deal_id, converted_at, custom_json, created_at, updated_at)
SELECT
   id, name, company, email, phone, source,
   CASE WHEN status = 'disqualified' THEN 'lost' ELSE status END,
   0, estimated_value_cents,
   owner_id, notes, disqualify_reason, converted_account_id, converted_contact_id,
   converted_deal_id, converted_at, custom_json, created_at, updated_at
FROM leads;
DROP TABLE leads;
ALTER TABLE leads_v4 RENAME TO leads;

-- ── 2. the columns the CRM screens read ─────────────────────────────────────
-- Health is a judgement, not a formula: an account manager sets it. Green is the
-- default so a new account is never accidentally flagged as at risk.
ALTER TABLE crm_accounts ADD COLUMN health TEXT NOT NULL DEFAULT 'green';
ALTER TABLE crm_accounts ADD COLUMN domain TEXT;
ALTER TABLE contacts ADD COLUMN owner_id TEXT REFERENCES users(id);
ALTER TABLE deals ADD COLUMN primary_contact_id TEXT REFERENCES contacts(id);
ALTER TABLE deal_stages ADD COLUMN color TEXT NOT NULL DEFAULT 'accent';

-- ── 3. indexes for the list filters ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lead_status   ON leads(status, created_at);
CREATE INDEX IF NOT EXISTS idx_lead_owner    ON leads(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_deal_close    ON deals(expected_close_date, status);
CREATE INDEX IF NOT EXISTS idx_deal_account  ON deals(account_id, status);
CREATE INDEX IF NOT EXISTS idx_deal_contact  ON deals(primary_contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contact_owner ON contacts(owner_id);
CREATE INDEX IF NOT EXISTS idx_act_owner_due ON activities(owner_id, is_done, due_at);
CREATE INDEX IF NOT EXISTS idx_act_open_due  ON activities(is_done, completed_at, due_at);
CREATE INDEX IF NOT EXISTS idx_stage_pipeline ON deal_stages(pipeline_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_import_status ON import_batches(status, created_at);

-- ── 4. the default pipeline needs colour tokens ─────────────────────────────
-- Ordered by sort_order so the board reads left-to-right in the intended hues.
UPDATE deal_stages SET color = CASE sort_order % 6
  WHEN 0 THEN 'info' WHEN 1 THEN 'accent' WHEN 2 THEN 'accent'
  WHEN 3 THEN 'warning' WHEN 4 THEN 'warning' ELSE 'success' END
WHERE color = 'accent';
`;
exports.V4_VERSION = 4;
//# sourceMappingURL=migrate.v4.js.map