/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * T09/T10 acceptance tests — CRM, global search, dashboard, import/export,
 * backup/restore and the audit viewer.
 *
 * Same shape as `ops.test.cjs`: real services against a real sql.js database, no
 * Electron and no IPC. Each test asserts a property whose absence would be a
 * defect a customer would eventually hit:
 *
 *   T09-01  a lead converts into exactly one account, contact and deal
 *   T09-02  a converted lead refuses a second conversion
 *   T09-03  conversion is atomic — a forced failure at the deal insert leaves
 *           zero new rows and an untouched lead
 *   T09-04  the preview and the commit agree, because they share one code path
 *   T09-05  a stage from another pipeline is refused, naming `stageId`
 *   T09-06  a legal move recomputes the probability and writes one activity
 *   T09-07  a no-op move writes no activity at all
 *   T09-08  a loss needs a reason, stored on the deal *and* on the timeline
 *   T09-09  dropping a card on the won stage closes the deal
 *   T09-10  column aggregates equal the sum of the cards under them
 *   T09-11  `perColumn` caps the cards but never the column's own totals
 *   T09-12  win rate, cycle days, leaderboard and loss reasons match the rows
 *   T09-13  average cycle is `null`, not `0`, when nothing has won
 *   T09-14  search groups by kind and caps each group
 *   T09-15  the palette caps tighter than the search screen
 *   T09-16  `%` and `_` in a term are literal, not wildcards
 *   T09-17  recent items de-duplicate by route and cap at eight
 *   T10-01  the prior period is the same length and ends the day before
 *   T10-02  every KPI has twelve sparkline points
 *   T10-03  a reversed custom range resolves to the same window
 *   T10-04  the warm path is served from cache
 *   T10-05  a deal move invalidates the dashboard
 *   T10-06  200 rows with 3 bad ones commits exactly 197
 *   T10-07  a duplicate key inside the file is reported as a duplicate
 *   T10-08  a committed batch refuses a second commit
 *   T10-09  money coercion accepts "1,234.56" and refuses "twelve"
 *   T10-10  a backup's manifest checksum matches the file it describes
 *   T10-11  a tampered copy and a newer schema version are both refused
 *   T10-12  restore rewinds the database and leaves a pre-restore copy
 *   T10-13  the audit viewer filters by entity and action
 *   T10-14  the diff splits added / changed / removed
 *   T10-15  the hash chain still verifies after every mutation above
 *   T10-16  every palette permission exists in the catalogue
 *   T10-17  a viewer sees no actions; the owner sees all of them
 *
 * Run with `npm test` (which builds `dist/main` first).
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-t10-'));
const DB_FILE = path.join(WORK_DIR, 'nexus.db');
const BACKUP_DIR = path.join(WORK_DIR, 'backups');

/**
 * `resolveWasmPath()` and `resolveDatabasePath()` both read Electron's `app`,
 * and `backup.create` opens a second database to integrity-check the copy it is
 * about to write — so unlike `core.test.cjs` we cannot simply inject the wasm
 * path. Stubbing the module is the smallest honest way to run these services in
 * plain Node; nothing else about Electron is touched.
 */
const ELECTRON_STUB = {
  app: {
    isPackaged: false,
    getPath: () => WORK_DIR,
    getAppPath: () => path.join(__dirname, '..'),
  },
};
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB;
  return originalLoad.call(this, request, parent, isMain);
};

const DIST = path.join(__dirname, '..', 'dist', 'main', 'main');
/** Shared code is emitted once, next to `main/`, not inside it. */
const SHARED = path.join(__dirname, '..', 'dist', 'main', 'shared');
const { initConnection, conn } = require(path.join(DIST, 'db', 'connection.js'));
const { migrate } = require(path.join(DIST, 'db', 'migrate.js'));
const { SCHEMA_VERSION } = require(path.join(DIST, 'db', 'schema.js'));
const seed = require(path.join(DIST, 'db', 'seed.js'));
const settings = require(path.join(DIST, 'services', 'settings.js'));
const usersService = require(path.join(DIST, 'services', 'users.js'));
const crm = require(path.join(DIST, 'services', 'crm.js'));
const dashboard = require(path.join(DIST, 'services', 'dashboard.js'));
const search = require(path.join(DIST, 'services', 'search.js'));
const importexport = require(path.join(DIST, 'services', 'importexport.js'));
const backup = require(path.join(DIST, 'services', 'backup.js'));
const audit = require(path.join(DIST, 'services', 'audit.js'));
const cache = require(path.join(DIST, 'services', 'cache.js'));
const admin = require(path.join(DIST, 'ipc.admin.js'));
const permissions = require(path.join(SHARED, 'permissions.js'));

const WASM_FILE = require.resolve('sql.js/dist/sql-wasm.wasm');
const SCOPE = { actorId: 'user-crm', actorName: 'Crm Operator' };
const TODAY = new Date().toISOString().slice(0, 10);

let ready = false;

// ── fixture ──────────────────────────────────────────────────────────────────

function isoDaysFromNow(days) {
  const date = new Date(`${TODAY}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isoStampDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

async function bootstrap() {
  if (ready) return;
  await initConnection({ wasmPath: WASM_FILE, filePath: DB_FILE });
  migrate();
  usersService.ensureRolePresets();

  const at = new Date().toISOString();
  conn().run(
    `INSERT INTO companies (id, name, legal_name, tax_id, address_json, logo_path, base_currency,
       fiscal_year_start_month, date_format, number_format, industry_preset, created_at, updated_at)
     VALUES ('co-1', 'T10 Co', NULL, NULL, NULL, NULL, 'USD', 1, 'yyyy-MM-dd', '1,234.56', NULL, ?, ?)`,
    [at, at],
  );
  conn().tx(() => seed.applyPreset('wholesale_retail', 'USD'));
  settings.ensureFiscalYear(1);

  conn().run(
    `INSERT INTO users (id, username, full_name, email, password_hash, password_salt, password_algo,
       must_change_password, is_active, is_owner, prefs_json, failed_attempts, created_at, updated_at)
     VALUES ('user-crm', 'crm', 'Crm Operator', NULL, 'x', 'x', 'scrypt-n16384-r8-p1',
       0, 1, 1, '{}', 0, ?, ?)`,
    [at, at],
  );
  conn().run(
    `INSERT INTO users (id, username, full_name, email, password_hash, password_salt, password_algo,
       must_change_password, is_active, is_owner, prefs_json, failed_attempts, created_at, updated_at)
     VALUES ('user-rep', 'rep', 'Rita Rep', NULL, 'x', 'x', 'scrypt-n16384-r8-p1',
       0, 1, 0, '{}', 0, ?, ?)`,
    [at, at],
  );

  ready = true;
}

/**
 * A pipeline nobody else touches.
 *
 * Every analytics test gets its own, because `analytics()` aggregates the whole
 * period for a pipeline and a shared one would make a "2 of 3 won" assertion
 * inherit whatever the previous test closed. `pipelineId` is the only isolation
 * boundary the service offers, so it is the one we use.
 */
let pipelineSeq = 0;
function freshPipeline() {
  pipelineSeq += 1;
  const pipeline = crm.savePipeline({ name: `Acceptance ${String(pipelineSeq)}` });
  const open = crm.saveStage({ pipelineId: pipeline.id, name: 'Open', probabilityBp: 1000, sortOrder: 0 });
  const mid = crm.saveStage({ pipelineId: pipeline.id, name: 'Mid', probabilityBp: 5000, sortOrder: 1 });
  const won = crm.saveStage({
    pipelineId: pipeline.id,
    name: 'Won',
    probabilityBp: 10_000,
    sortOrder: 2,
    isWon: true,
  });
  const lost = crm.saveStage({
    pipelineId: pipeline.id,
    name: 'Lost',
    probabilityBp: 0,
    sortOrder: 3,
    isLost: true,
    color: 'danger',
  });
  return { pipelineId: pipeline.id, open: open.id, mid: mid.id, won: won.id, lost: lost.id };
}

function mkAccount(name) {
  const id = randomUUID();
  const at = new Date().toISOString();
  conn().run(
    `INSERT INTO crm_accounts (id, name, industry, website, phone, email, address_json, owner_id,
       customer_id, source, annual_revenue_cents, employees, notes, custom_json, health, domain,
       created_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', 'green', NULL, ?, ?)`,
    [id, name, at, at],
  );
  return id;
}

/** A deal inserted straight into the table, so `created_at` can be back-dated. */
function mkDeal({ pipelineId, stageId, name, valueCents, probabilityBp, ownerId = null, createdAt = null }) {
  const id = randomUUID();
  const at = new Date().toISOString();
  conn().run(
    `INSERT INTO deals (id, name, account_id, pipeline_id, stage_id, owner_id, value_cents, currency,
       probability_bp, expected_close_date, status, lost_reason, won_at, lost_at, lead_id,
       sales_order_id, stage_changed_at, custom_json, primary_contact_id, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 'USD', ?, NULL, 'open', NULL, NULL, NULL, NULL, NULL, ?, '{}', NULL, ?, ?)`,
    [id, name, pipelineId, stageId, ownerId, valueCents, probabilityBp, at, createdAt ?? at, at],
  );
  return id;
}

function mkLead(name, { email = null, company = null, status = 'new' } = {}) {
  const id = randomUUID();
  const at = new Date().toISOString();
  conn().run(
    `INSERT INTO leads (id, name, company, email, phone, source, status, score, estimated_value_cents,
       owner_id, notes, loss_reason, converted_account_id, converted_contact_id, converted_deal_id,
       converted_at, custom_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'referral', ?, 40, 500000, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', ?, ?)`,
    [id, name, company, email, status, at, at],
  );
  return id;
}

function countRows(table) {
  return Number(conn().one(`SELECT COUNT(*) AS total FROM ${table}`).total);
}

function activityCount(entityId) {
  return Number(
    conn().one('SELECT COUNT(*) AS total FROM activities WHERE entity = ? AND entity_id = ?', ['deals', entityId])
      .total,
  );
}

function convertInput(leadId, pipelineId, overrides = {}) {
  return {
    leadId,
    account: { name: overrides.accountName ?? 'Acme Rockets' },
    contact: { firstName: overrides.firstName ?? 'Ada', lastName: 'Lovelace' },
    deal: {
      name: overrides.dealName ?? 'Acme — fleet rollout',
      pipelineId,
      valueCents: overrides.valueCents ?? 1_250_000,
      expectedCloseDate: isoDaysFromNow(30),
    },
  };
}

// ── T09 lead conversion ──────────────────────────────────────────────────────

test('T09-01 a lead converts into exactly one account, one contact and one deal', async () => {
  await bootstrap();
  const { pipelineId, open } = freshPipeline();
  const leadId = mkLead('Acme Rockets', { email: 'ada@acme.test', company: 'Acme' });
  const accountsBefore = countRows('crm_accounts');
  const contactsBefore = countRows('contacts');
  const dealsBefore = countRows('deals');

  const result = crm.convertLead(convertInput(leadId, pipelineId), SCOPE);

  assert.equal(countRows('crm_accounts'), accountsBefore + 1);
  assert.equal(countRows('contacts'), contactsBefore + 1);
  assert.equal(countRows('deals'), dealsBefore + 1);

  const lead = conn().one('SELECT * FROM leads WHERE id = ?', [leadId]);
  assert.equal(lead.status, 'converted');
  assert.equal(lead.converted_account_id, result.accountId);
  assert.equal(lead.converted_contact_id, result.contactId);
  assert.equal(lead.converted_deal_id, result.dealId);
  assert.ok(lead.converted_at, 'a converted lead must say when');

  const deal = conn().one('SELECT * FROM deals WHERE id = ?', [result.dealId]);
  assert.equal(deal.stage_id, open, 'a deal with no stage named lands in the first column');
  assert.equal(deal.probability_bp, 1000, 'probability comes from the stage, never from the form');
  assert.equal(deal.lead_id, leadId, 'the deal must remember the lead it came from');
  assert.equal(deal.value_cents, 1_250_000);

  const contact = conn().one('SELECT * FROM contacts WHERE id = ?', [result.contactId]);
  assert.equal(contact.account_id, result.accountId);
  assert.equal(contact.first_name, 'Ada');
  assert.equal(contact.is_primary, 1);

  assert.equal(activityCount(result.dealId), 1, 'the conversion is on the deal timeline');
});

test('T09-02 a lead cannot be converted twice', async () => {
  await bootstrap();
  const { pipelineId } = freshPipeline();
  const leadId = mkLead('Twice Ltd');
  crm.convertLead(convertInput(leadId, pipelineId, { accountName: 'Twice Account' }), SCOPE);

  assert.throws(
    () => crm.convertLead(convertInput(leadId, pipelineId, { accountName: 'Second Account' }), SCOPE),
    (error) => {
      assert.equal(error.code, 'CONFLICT');
      assert.match(error.message, /already been converted/i);
      return true;
    },
  );
  assert.equal(
    conn().one('SELECT COUNT(*) AS total FROM crm_accounts WHERE name = ?', ['Second Account']).total,
    0,
    'a refused conversion must not leave a half-made account',
  );
});

test('T09-03 conversion is atomic: a failure at the deal insert leaves nothing behind', async () => {
  await bootstrap();
  const { pipelineId } = freshPipeline();
  const leadId = mkLead('Atomic Industries');
  const accountsBefore = countRows('crm_accounts');
  const contactsBefore = countRows('contacts');
  const dealsBefore = countRows('deals');

  // The account and contact inserts run before the deal insert, so a failure at
  // the third statement is the exact case a hand-rolled transaction gets wrong.
  conn().run(
    "CREATE TRIGGER t10_force_deal_failure BEFORE INSERT ON deals BEGIN SELECT RAISE(ABORT, 'forced'); END;",
  );
  let thrown = null;
  try {
    crm.convertLead(convertInput(leadId, pipelineId, { accountName: 'Should Not Exist' }), SCOPE);
  } catch (error) {
    thrown = error;
  } finally {
    conn().run('DROP TRIGGER t10_force_deal_failure');
  }

  assert.ok(thrown, 'the forced failure must surface, not be swallowed');
  assert.equal(countRows('crm_accounts'), accountsBefore, 'the account insert must have rolled back');
  assert.equal(countRows('contacts'), contactsBefore, 'the contact insert must have rolled back');
  assert.equal(countRows('deals'), dealsBefore);

  const lead = conn().one('SELECT status, converted_deal_id FROM leads WHERE id = ?', [leadId]);
  assert.equal(lead.status, 'new', 'a failed conversion must leave the lead convertible');
  assert.equal(lead.converted_deal_id, null);

  // And the retry, now that the obstacle is gone, must work.
  const result = crm.convertLead(convertInput(leadId, pipelineId, { accountName: 'Should Not Exist' }), SCOPE);
  assert.equal(countRows('crm_accounts'), accountsBefore + 1);
  assert.equal(conn().one('SELECT status FROM leads WHERE id = ?', [leadId]).status, 'converted');
  assert.ok(result.dealId);
});

test('T09-04 the conversion preview promises exactly what the commit creates', async () => {
  await bootstrap();
  const { pipelineId, mid } = freshPipeline();
  const leadId = mkLead('Preview Partners', { email: 'p@preview.test' });
  const input = {
    leadId,
    account: { name: 'Preview Partners Ltd' },
    contact: { firstName: 'Grace', lastName: 'Hopper' },
    deal: { name: 'Preview — platform', pipelineId, stageId: mid, valueCents: 750_000 },
  };

  const preview = crm.previewConversion(input);
  assert.deepEqual(preview.blocked, []);
  assert.equal(preview.willCreate.account.name, 'Preview Partners Ltd');
  assert.equal(preview.willCreate.deal.valueCents, 750_000);
  assert.equal(preview.willCreate.deal.stageName, 'Mid');

  const result = crm.convertLead(input, SCOPE);
  const account = conn().one('SELECT name FROM crm_accounts WHERE id = ?', [result.accountId]);
  const deal = conn().one('SELECT name, value_cents, stage_id FROM deals WHERE id = ?', [result.dealId]);
  assert.equal(account.name, preview.willCreate.account.name);
  assert.equal(deal.name, preview.willCreate.deal.name);
  assert.equal(deal.value_cents, preview.willCreate.deal.valueCents);
  assert.equal(deal.stage_id, mid);
});

// ── T09 the kanban ───────────────────────────────────────────────────────────

test('T09-05 a stage from a different pipeline is refused and names the field', async () => {
  await bootstrap();
  const first = freshPipeline();
  const second = freshPipeline();
  const dealId = mkDeal({
    pipelineId: first.pipelineId,
    stageId: first.open,
    name: 'Cross-pipeline deal',
    valueCents: 100_000,
    probabilityBp: 1000,
  });

  assert.throws(
    () => crm.moveStage({ id: dealId, stageId: second.mid }, SCOPE),
    (error) => {
      assert.equal(error.code, 'VALIDATION');
      assert.equal(error.details.field, 'stageId');
      return true;
    },
  );
  assert.equal(
    conn().one('SELECT stage_id FROM deals WHERE id = ?', [dealId]).stage_id,
    first.open,
    'a refused move must not change the card',
  );
});

test('T09-06 a legal move recomputes the probability and writes exactly one activity', async () => {
  await bootstrap();
  const { pipelineId, open, mid } = freshPipeline();
  const dealId = mkDeal({ pipelineId, stageId: open, name: 'Move me', valueCents: 400_000, probabilityBp: 1000 });
  const before = activityCount(dealId);

  const card = crm.moveStage({ id: dealId, stageId: mid, note: 'Client asked for a proposal' }, SCOPE);

  assert.equal(card.stageId, mid);
  assert.equal(card.probabilityBp, 5000, 'the card carries the new stage probability');
  const stored = conn().one('SELECT probability_bp, stage_id FROM deals WHERE id = ?', [dealId]);
  assert.equal(stored.probability_bp, 5000, 'and so does the row, not just the projection');
  assert.equal(stored.stage_id, mid);
  assert.equal(activityCount(dealId), before + 1, 'one move, one timeline entry');

  const activity = conn().one(
    "SELECT type, subject, body FROM activities WHERE entity = 'deals' AND entity_id = ? ORDER BY created_at DESC LIMIT 1",
    [dealId],
  );
  assert.equal(activity.type, 'stage_changed');
  assert.match(activity.subject, /Mid/);
  assert.equal(activity.body, 'Client asked for a proposal');
});

test('T09-07 dropping a card on the stage it is already in writes no activity', async () => {
  await bootstrap();
  const { pipelineId, open } = freshPipeline();
  const dealId = mkDeal({ pipelineId, stageId: open, name: 'Stay put', valueCents: 10_000, probabilityBp: 1000 });
  const before = activityCount(dealId);

  const card = crm.moveStage({ id: dealId, stageId: open }, SCOPE);

  assert.equal(card.stageId, open);
  assert.equal(activityCount(dealId), before, 'a no-op drop is not history');
});

test('T09-08 a loss needs a reason, and the reason lands on the deal and the timeline', async () => {
  await bootstrap();
  const { pipelineId, open, lost } = freshPipeline();
  const dealId = mkDeal({ pipelineId, stageId: open, name: 'Doomed', valueCents: 300_000, probabilityBp: 1000 });

  assert.throws(
    () => crm.closeLost({ id: dealId, reason: '   ' }, SCOPE),
    (error) => {
      assert.equal(error.code, 'VALIDATION');
      assert.equal(error.details.field, 'reason');
      return true;
    },
  );
  assert.equal(
    conn().one('SELECT status FROM deals WHERE id = ?', [dealId]).status,
    'open',
    'a refused close must leave the deal open',
  );

  assert.throws(
    () => crm.moveStage({ id: dealId, stageId: lost }, SCOPE),
    (error) => {
      assert.equal(error.code, 'CONFLICT');
      assert.match(error.message, /reason/i);
      return true;
    },
    'dragging onto the lost column must not be a silent loss',
  );

  const card = crm.closeLost({ id: dealId, reason: 'Lost to a cheaper competitor', note: 'Price only' }, SCOPE);
  assert.equal(card.probabilityBp, 0, 'a lost deal is worth nothing in the forecast');
  const stored = conn().one('SELECT status, lost_reason, stage_id FROM deals WHERE id = ?', [dealId]);
  assert.equal(stored.status, 'lost');
  assert.equal(stored.lost_reason, 'Lost to a cheaper competitor');
  assert.equal(stored.stage_id, lost);

  const activity = conn().one(
    "SELECT subject, body FROM activities WHERE entity = 'deals' AND entity_id = ? ORDER BY created_at DESC LIMIT 1",
    [dealId],
  );
  assert.match(activity.subject, /Lost — Lost to a cheaper competitor/);
  assert.equal(activity.body, 'Price only');

  assert.throws(
    () => crm.closeLost({ id: dealId, reason: 'Again' }, SCOPE),
    (error) => {
      assert.equal(error.code, 'CONFLICT');
      return true;
    },
  );
});

test('T09-09 dropping a card on the won stage closes the deal', async () => {
  await bootstrap();
  const { pipelineId, open, won } = freshPipeline();
  const dealId = mkDeal({ pipelineId, stageId: open, name: 'Sure thing', valueCents: 900_000, probabilityBp: 1000 });

  const card = crm.moveStage({ id: dealId, stageId: won }, SCOPE);
  assert.equal(card.probabilityBp, 10_000);

  const stored = conn().one('SELECT status, won_at, probability_bp FROM deals WHERE id = ?', [dealId]);
  assert.equal(stored.status, 'won');
  assert.ok(stored.won_at, 'a won deal must say when');
  assert.equal(stored.probability_bp, 10_000);

  assert.throws(
    () => crm.moveStage({ id: dealId, stageId: open }, SCOPE),
    (error) => {
      assert.equal(error.code, 'CONFLICT');
      return true;
    },
    'a closed deal must not be draggable back into the pipeline',
  );
});

test('T09-10 column aggregates equal the sum of the cards beneath them', async () => {
  await bootstrap();
  const { pipelineId, open, mid } = freshPipeline();
  mkDeal({ pipelineId, stageId: open, name: 'A', valueCents: 100_000, probabilityBp: 1000 });
  mkDeal({ pipelineId, stageId: open, name: 'B', valueCents: 250_000, probabilityBp: 1000 });
  mkDeal({ pipelineId, stageId: mid, name: 'C', valueCents: 500_000, probabilityBp: 5000 });

  const board = crm.board({ pipelineId });

  const openColumn = board.columns.find((column) => column.stage.id === open);
  assert.ok(openColumn);
  assert.equal(openColumn.count, 2);
  assert.equal(openColumn.valueCents, 350_000);
  assert.equal(openColumn.weightedCents, 35_000, '100k and 250k at 10 % is 35k of forecast');

  const midColumn = board.columns.find((column) => column.stage.id === mid);
  assert.ok(midColumn);
  assert.equal(midColumn.weightedCents, 250_000);

  // The header must equal the cards: a column whose total disagrees with its
  // own cards is the single most damaging thing a Kanban can do.
  for (const column of board.columns) {
    const sum = column.deals.reduce((total, card) => total + card.valueCents, 0);
    const weighted = column.deals.reduce(
      (total, card) => total + Math.round((card.valueCents * card.probabilityBp) / 10_000),
      0,
    );
    assert.equal(column.valueCents, sum, `column ${column.stage.name} value disagrees with its cards`);
    assert.equal(column.weightedCents, weighted, `column ${column.stage.name} forecast disagrees with its cards`);
  }
  assert.equal(board.totals.count, 3);
  assert.equal(board.totals.valueCents, 850_000);
});

test('T09-11 perColumn caps the cards but never the column totals', async () => {
  await bootstrap();
  const { pipelineId, open } = freshPipeline();
  for (let index = 0; index < 5; index += 1) {
    mkDeal({ pipelineId, stageId: open, name: `Card ${String(index)}`, valueCents: 10_000, probabilityBp: 1000 });
  }

  const board = crm.board({ pipelineId, perColumn: 2 });
  const column = board.columns.find((entry) => entry.stage.id === open);
  assert.ok(column);
  assert.equal(column.deals.length, 2, 'the board is not a place to page through five hundred deals');
  assert.equal(column.count, 5, 'the count is the truth, not the number of cards rendered');
  assert.equal(column.valueCents, 50_000, 'so is the value');
});

// ── T09 analytics ────────────────────────────────────────────────────────────

test('T09-12 analytics agrees with the rows: win rate, cycle, leaderboard, loss reasons', async () => {
  await bootstrap();
  const { pipelineId, open, won, lost } = freshPipeline();
  const from = isoDaysFromNow(-30);
  // The period ends *today*, on purpose: a deal closed today must be inside it.
  // A `to` of tomorrow would hide an upper bound that sorts below the timestamp
  // it is compared against.
  const to = TODAY;

  const fastWin = mkDeal({
    pipelineId,
    stageId: open,
    name: 'Fast win',
    valueCents: 100_000,
    probabilityBp: 1000,
    ownerId: 'user-crm',
    createdAt: isoStampDaysAgo(10),
  });
  const slowWin = mkDeal({
    pipelineId,
    stageId: open,
    name: 'Slow win',
    valueCents: 300_000,
    probabilityBp: 1000,
    ownerId: 'user-rep',
    createdAt: isoStampDaysAgo(20),
  });
  const aLoss = mkDeal({
    pipelineId,
    stageId: open,
    name: 'A loss',
    valueCents: 200_000,
    probabilityBp: 1000,
    ownerId: 'user-rep',
    createdAt: isoStampDaysAgo(5),
  });
  const stillOpen = mkDeal({
    pipelineId,
    stageId: open,
    name: 'Still open',
    valueCents: 400_000,
    probabilityBp: 1000,
  });

  crm.moveStage({ id: fastWin, stageId: won }, SCOPE);
  crm.moveStage({ id: slowWin, stageId: won }, SCOPE);
  crm.closeLost({ id: aLoss, reason: 'No budget this year' }, SCOPE);
  assert.equal(conn().one('SELECT status FROM deals WHERE id = ?', [stillOpen]).status, 'open');

  const report = crm.analytics({ from, to }, pipelineId);

  assert.equal(report.kpis.wonCents, 400_000);
  assert.equal(report.kpis.lostCents, 200_000);
  assert.equal(report.kpis.wonCount, 2);
  assert.equal(report.kpis.lostCount, 1);
  assert.equal(report.kpis.winRateBp, 6667, 'two of three decided deals is 66.67 %');
  assert.equal(report.kpis.avgDealCents, 200_000, 'the mean of 100k and 300k');
  assert.equal(report.kpis.openCents, 400_000, 'the open pipeline is what is still in play');
  assert.equal(report.kpis.weightedCents, 40_000, '400k at 10 %');

  assert.equal(report.kpis.avgCycleDays, 15, 'ten days and twenty days average to fifteen');

  const rep = report.owners.find((owner) => owner.ownerId === 'user-rep');
  assert.ok(rep, 'the leaderboard must include the rep');
  assert.equal(rep.wonCount, 1);
  assert.equal(rep.lostCount, 1);
  assert.equal(rep.winRateBp, 5000);
  const lead = report.owners[0];
  assert.equal(lead.ownerId, 'user-rep', 'the leaderboard is ordered by won value');

  assert.equal(report.lossReasons.length, 1);
  assert.equal(report.lossReasons[0].reason, 'No budget this year');
  assert.equal(report.lossReasons[0].count, 1);
  assert.equal(report.lossReasons[0].valueCents, 200_000);

  const openFunnel = report.funnel.find((stage) => stage.stageId === open);
  assert.ok(openFunnel);
  assert.equal(openFunnel.count, 1);
  assert.equal(openFunnel.valueCents, 400_000);
});

test('T09-13 average cycle is null, not zero, when nothing has been won', async () => {
  await bootstrap();
  const { pipelineId } = freshPipeline();

  const report = crm.analytics({ from: isoDaysFromNow(-30), to: TODAY }, pipelineId);

  assert.equal(report.kpis.wonCount, 0);
  assert.equal(report.kpis.avgCycleDays, null, 'zero would read as "won in no time at all"');
  assert.equal(report.kpis.winRateBp, 0);
  assert.deepEqual(report.lossReasons, []);
});

// ── T09 search ───────────────────────────────────────────────────────────────

test('T09-14 search groups by kind and caps each group', async () => {
  await bootstrap();
  const prefix = `Zephyr${String(Date.now()).slice(-6)}`;
  for (let index = 0; index < 11; index += 1) {
    mkAccount(`${prefix} Holdings ${String(index).padStart(2, '0')}`);
  }
  mkLead(`${prefix} Prospect`);

  const result = search.searchGlobal(prefix);

  const group = result.groups.find((entry) => entry.kind === 'crmAccount');
  assert.ok(group, 'accounts must be a group of their own');
  assert.equal(group.rows.length, 8, 'the default limit is eight per group');
  assert.ok(
    result.groups.some((entry) => entry.kind === 'lead'),
    'a lead with the same prefix is a separate group',
  );
  for (const entry of result.groups) {
    assert.ok(entry.label.length > 0, 'every group is labelled — the palette renders the label');
    assert.ok(entry.rows.length <= 8);
    for (const row of entry.rows) {
      assert.equal(row.kind, entry.kind);
      assert.match(row.route, /^\//, 'every hit must be able to navigate somewhere');
    }
  }

  const filtered = search.searchGlobal(prefix, { kinds: ['lead'] });
  assert.equal(filtered.groups.length, 1);
  assert.equal(filtered.groups[0].kind, 'lead');
});

test('T09-15 the palette caps tighter than the search screen', async () => {
  await bootstrap();
  const prefix = `Quasar${String(Date.now()).slice(-6)}`;
  for (let index = 0; index < 9; index += 1) {
    mkAccount(`${prefix} Ltd ${String(index)}`);
  }

  const palette = search.searchPalette(prefix);
  const group = palette.groups.find((entry) => entry.kind === 'crmAccount');
  assert.ok(group);
  assert.equal(group.rows.length, 4, 'a launcher shows four, not eight');

  assert.deepEqual(search.searchGlobal('   ').groups, [], 'an empty term is not a query');
});

test('T09-16 LIKE metacharacters in a term are literal', async () => {
  await bootstrap();
  const marker = `Pct${String(Date.now()).slice(-6)}`;
  mkAccount(`${marker} 100% Cotton`);
  mkAccount(`${marker} Plain`);

  const percent = search.searchGlobal(`${marker} 100%`);
  const names = percent.groups.flatMap((group) => group.rows.map((row) => row.title));
  assert.deepEqual(names, [`${marker} 100% Cotton`], 'a typed % must not become a wildcard');

  const underscore = search.searchGlobal(`${marker} Pl_n`);
  assert.deepEqual(
    underscore.groups.flatMap((group) => group.rows.map((row) => row.title)),
    [],
    'a typed _ must not match any single character',
  );
});

test('T09-17 recent items de-duplicate by route and cap at eight', async () => {
  await bootstrap();
  search.clearRecent();

  for (let index = 0; index < 12; index += 1) {
    search.pushRecent({
      id: `id-${String(index)}`,
      title: `Record ${String(index)}`,
      subtitle: '',
      kind: 'invoice',
      route: `/finance/invoices?focus=${String(index)}`,
    });
  }
  assert.equal(search.listRecent().length, 8, 'a launcher that lists twelve recents is a second screen');

  const again = search.pushRecent({
    id: 'id-5',
    title: 'Record 5',
    subtitle: '',
    kind: 'invoice',
    route: '/finance/invoices?focus=5',
  });
  assert.equal(again[0].route, '/finance/invoices?focus=5', 're-opening a record moves it to the front');
  assert.equal(
    again.filter((entry) => entry.route === '/finance/invoices?focus=5').length,
    1,
    'and does not duplicate it',
  );
  assert.deepEqual(search.clearRecent(), []);
});

// ── T10 dashboard ────────────────────────────────────────────────────────────

test('T10-01 the prior period is the same length and ends the day before', async () => {
  await bootstrap();
  const period = dashboard.resolvePeriod({ period: 'custom', from: '2026-03-05', to: '2026-03-21' });

  assert.equal(period.from, '2026-03-05');
  assert.equal(period.to, '2026-03-21');
  assert.equal(period.priorTo, '2026-03-04', 'the prior window must end the day before the current one starts');

  const days = (a, b) =>
    Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000) + 1;
  assert.equal(
    days(period.priorFrom, period.priorTo),
    days(period.from, period.to),
    'comparing a 17-day range to a 30-day month is a lie',
  );

  const month = dashboard.resolvePeriod({ period: 'month' });
  assert.equal(month.from.slice(8), '01', 'the month view starts on the first');
  assert.equal(month.priorTo < month.from, true);
});

test('T10-02 every KPI carries twelve sparkline points and a null delta from a zero base', async () => {
  await bootstrap();
  // A window in the distant past, so every prior figure is genuinely zero.
  const summary = dashboard.summary({ period: 'custom', from: '2001-01-01', to: '2001-01-31' });

  assert.equal(summary.kpis.length, 6);
  const keys = summary.kpis.map((kpi) => kpi.key);
  assert.deepEqual(keys, ['revenue', 'expenses', 'profit', 'openAr', 'pipeline', 'lowStock']);

  for (const kpi of summary.kpis) {
    assert.equal(kpi.sparkline.length, 12, `${kpi.key} must have twelve points so tiles are comparable`);
    assert.ok(kpi.unit === 'money' || kpi.unit === 'count');
    assert.ok(typeof kpi.higherIsBetter === 'boolean');
    assert.match(kpi.href, /^\//);
  }

  const revenue = summary.kpis.find((kpi) => kpi.key === 'revenue');
  assert.ok(revenue);
  assert.equal(revenue.value, 0);
  assert.equal(revenue.delta, 0);
  assert.equal(revenue.deltaPct, null, '+Infinity % is worse than a dash');

  assert.equal(summary.series.length, 12, 'the twelve-month chart has twelve points');
  assert.ok(Array.isArray(summary.attention));
  assert.ok(Array.isArray(summary.activity));
  assert.ok(typeof summary.ms === 'number');
});

test('T10-03 a reversed custom range resolves to the same window', async () => {
  await bootstrap();
  const forward = dashboard.resolvePeriod({ period: 'custom', from: '2026-02-01', to: '2026-02-28' });
  const reversed = dashboard.resolvePeriod({ period: 'custom', from: '2026-02-28', to: '2026-02-01' });

  assert.equal(reversed.from, forward.from);
  assert.equal(reversed.to, forward.to);
  assert.equal(reversed.priorFrom, forward.priorFrom);

  const fallback = dashboard.resolvePeriod({ period: 'custom' });
  assert.equal(fallback.key, 'month', 'a custom request with no dates falls back rather than inventing a range');
});

test('T10-04 the warm path is served from the cache', async () => {
  await bootstrap();
  cache.resetCache();

  const request = { period: 'custom', from: '2002-01-01', to: '2002-01-31' };
  const cold = dashboard.summary(request);
  const coldStats = cache.cacheStats();
  assert.equal(coldStats.misses, 1, 'the first call must compute');

  const started = Date.now();
  const warm = dashboard.summary(request);
  const elapsed = Date.now() - started;

  const warmStats = cache.cacheStats();
  assert.equal(warmStats.hits, 1, 'the second call must be a hit');
  assert.equal(warm, cold, 'a hit returns the stored value, not a recomputation');
  assert.ok(elapsed < 150, `the warm path must be under 150 ms (was ${String(elapsed)} ms)`);
  assert.equal(dashboard.summaryKey(request), `dashboard:custom:2002-01-01:2002-01-31`);
});

test('T10-05 moving a deal invalidates the dashboard and the pipeline slice follows', async () => {
  await bootstrap();
  cache.resetCache();
  const request = { period: 'month' };

  const before = dashboard.summary(request);
  const sliceBefore = before.pipeline.find((slice) => slice.name === 'New');
  assert.ok(sliceBefore, 'the default pipeline has a New column');

  const pipeline = crm.listPipelines().find((entry) => entry.isDefault);
  assert.ok(pipeline);
  const newStage = pipeline.stages.find((stage) => stage.name === 'New');
  const qualified = pipeline.stages.find((stage) => stage.name === 'Qualified');
  assert.ok(newStage && qualified);

  const dealId = mkDeal({
    pipelineId: pipeline.id,
    stageId: newStage.id,
    name: 'Dashboard probe',
    valueCents: 1_000_000,
    probabilityBp: 1000,
  });
  cache.invalidateCache('dashboard:');

  const withDeal = dashboard.summary(request);
  assert.notEqual(withDeal, before, 'a write must not be served from the stale entry');
  const newAfter = withDeal.pipeline.find((slice) => slice.stageId === newStage.id);
  assert.ok(newAfter);
  assert.equal(newAfter.count, sliceBefore.count + 1);

  crm.moveStage({ id: dealId, stageId: qualified.id }, SCOPE);
  const afterMove = dashboard.summary(request);
  const qualifiedSlice = afterMove.pipeline.find((slice) => slice.stageId === qualified.id);
  assert.ok(qualifiedSlice);
  assert.ok(qualifiedSlice.count >= 1, 'the move must be visible without waiting for the TTL');
  assert.equal(
    afterMove.pipeline.find((slice) => slice.stageId === newStage.id).count,
    sliceBefore.count,
    'and it must have left the column it came from',
  );
});

// ── T10 import ───────────────────────────────────────────────────────────────

function writeCsv(name, lines) {
  const file = path.join(WORK_DIR, name);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function mappingOf(parseResult) {
  const mapping = {};
  for (const column of parseResult.columns) {
    if (column.field) mapping[column.header] = column.field;
  }
  return mapping;
}

test('T10-06 200 rows with three bad ones imports exactly 197', async () => {
  await bootstrap();
  const stamp = String(Date.now()).slice(-6);
  const lines = ['Code,Name,Email,Payment terms (days)'];
  for (let index = 0; index < 197; index += 1) {
    lines.push(`IMP${stamp}-${String(index).padStart(3, '0')},Customer ${String(index)},c${String(index)}@imp.test,30`);
  }
  // Three rejects: no code, no name, and a code that appears twice.
  lines.push(`,No Code,cust-nocode@imp.test,30`);
  lines.push(`IMP${stamp}-BAD,,noname@imp.test,30`);
  lines.push(`IMP${stamp}-000,Duplicate,dup@imp.test,30`);

  const file = writeCsv(`import-${stamp}.csv`, lines);
  const parsed = importexport.parse('customers', file);
  assert.equal(parsed.totalRows, 200);
  assert.ok(parsed.headers.includes('Code'));

  const report = importexport.validate(parsed.batchId, mappingOf(parsed));
  assert.equal(report.totalRows, 200);
  assert.equal(report.validRows, 197, 'the good rows must not be held hostage by the bad ones');
  assert.equal(report.duplicateRows, 1);
  assert.equal(report.invalidRows, 2);
  assert.equal(report.errors.length, 3);
  assert.ok(report.byField.length > 0, 'the summary names the fields that went wrong');
  assert.equal(report.preview.length, 10);

  const before = countRows('customers');
  const progress = [];
  const result = importexport.commit(parsed.batchId, SCOPE, (entry) => progress.push(entry));

  assert.equal(result.inserted, 197);
  assert.equal(result.updated, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 3);
  assert.equal(result.errorCsvPath, null, 'nothing failed at insert time, so there is no error file');
  assert.equal(countRows('customers'), before + 197);
  assert.ok(progress.length >= 1, 'a 10 000-row file must report progress');
  assert.equal(progress.at(-1).done, progress.at(-1).total);

  const stored = conn().one('SELECT payment_terms_days, currency FROM customers WHERE code = ?', [
    `IMP${stamp}-000`,
  ]);
  assert.equal(stored.payment_terms_days, 30, 'a typed column arrives typed');
});

test('T10-07 a duplicate key inside the file is reported as a duplicate, not as invalid', async () => {
  await bootstrap();
  const stamp = String(Date.now()).slice(-6);
  const file = writeCsv(`dupes-${stamp}.csv`, [
    'Code,Name',
    `DUP${stamp},First`,
    `DUP${stamp},Second`,
    `OK${stamp},Third`,
  ]);

  const parsed = importexport.parse('customers', file);
  const report = importexport.validate(parsed.batchId, mappingOf(parsed));

  assert.equal(report.validRows, 2);
  assert.equal(report.duplicateRows, 1);
  assert.equal(report.invalidRows, 0, 'a duplicate is present, not wrong — the operator needs to know which');
  const duplicate = report.errors.find((error) => error.kind === 'duplicate');
  assert.ok(duplicate);
  assert.match(duplicate.reason, /appears twice/i);

  // Once the file is committed the key really exists, so the *next* file is
  // judged against the database rather than against itself.
  importexport.commit(parsed.batchId, SCOPE);

  const clashFile = writeCsv(`dupes2-${stamp}.csv`, ['Code,Name', `DUP${stamp},Renamed`]);
  const clash = importexport.parse('customers', clashFile);
  const strict = importexport.validate(clash.batchId, mappingOf(clash));
  assert.equal(strict.duplicateRows, 1);
  assert.equal(strict.validRows, 0, 'a code that already exists is not a new customer');
  assert.match(strict.errors[0].reason, /already exists/i);

  // With `updateExisting` the same row is an update, and it must update rather
  // than insert a second customer with the same code.
  const before = countRows('customers');
  const updateFile = writeCsv(`dupes3-${stamp}.csv`, ['Code,Name', `DUP${stamp},Renamed`]);
  const updateParsed = importexport.parse('customers', updateFile);
  const updateReport = importexport.validate(updateParsed.batchId, mappingOf(updateParsed), true);
  assert.equal(updateReport.validRows, 1, 'an update is a valid row when the operator asked for updates');

  const applied = importexport.commit(updateParsed.batchId, SCOPE);
  assert.equal(applied.updated, 1);
  assert.equal(applied.inserted, 0);
  assert.equal(countRows('customers'), before, 'an update must not add a row');
  assert.equal(conn().one('SELECT name FROM customers WHERE code = ?', [`DUP${stamp}`]).name, 'Renamed');
});

test('T10-08 a committed batch refuses a second commit', async () => {
  await bootstrap();
  const stamp = String(Date.now()).slice(-6);
  const file = writeCsv(`once-${stamp}.csv`, ['Code,Name', `ONCE${stamp}-A,Alpha`, `ONCE${stamp}-B,Beta`]);
  const parsed = importexport.parse('customers', file);

  assert.throws(
    () => importexport.commit(parsed.batchId, SCOPE),
    (error) => {
      assert.equal(error.code, 'CONFLICT');
      assert.match(error.message, /[Vv]alidate/);
      return true;
    },
    'committing before validating would insert whatever the file said, unchecked',
  );

  importexport.validate(parsed.batchId, mappingOf(parsed));
  const first = importexport.commit(parsed.batchId, SCOPE);
  assert.equal(first.inserted, 2);

  const before = countRows('customers');
  assert.throws(
    () => importexport.commit(parsed.batchId, SCOPE),
    (error) => {
      assert.equal(error.code, 'CONFLICT');
      return true;
    },
    'a double-clicked Import button must not insert the file twice',
  );
  assert.equal(countRows('customers'), before);
});

test('T10-09 money coercion accepts what a spreadsheet actually contains', async () => {
  await bootstrap();
  assert.equal(importexport.parseMoneyToCents('1,234.56'), 123_456);
  assert.equal(importexport.parseMoneyToCents('$1,000'), 100_000);
  assert.equal(importexport.parseMoneyToCents('0'), 0);
  assert.equal(importexport.parseMoneyToCents('-5.50'), -550);
  assert.equal(importexport.parseMoneyToCents(''), null);
  assert.equal(importexport.parseMoneyToCents('twelve'), null);

  const stamp = String(Date.now()).slice(-6);
  const file = writeCsv(`money-${stamp}.csv`, [
    'Code,Name,Credit limit',
    `M${stamp}-1,Good,"1,234.56"`,
    `M${stamp}-2,Bad,twelve`,
  ]);
  const parsed = importexport.parse('customers', file);
  const report = importexport.validate(parsed.batchId, mappingOf(parsed));

  assert.equal(report.validRows, 1);
  assert.equal(report.invalidRows, 1);
  assert.match(report.errors[0].reason, /not an amount/i);
  assert.equal(report.preview[0].credit_limit_cents, '123456');
});

// ── T10 backup ───────────────────────────────────────────────────────────────

test('T10-10 a backup carries a manifest whose checksum matches the file', async () => {
  await bootstrap();
  const result = await backup.create(BACKUP_DIR, SCOPE);

  assert.ok(fs.existsSync(result.path));
  assert.ok(fs.existsSync(`${result.path}.manifest.json`));
  assert.equal(result.manifest.integrity, 'ok');
  assert.equal(result.manifest.bytes, fs.statSync(result.path).size);
  // The manifest records the schema of the file it copied, so it has to be the
  // build's own version — not a literal that needs editing on every migration.
  assert.equal(result.manifest.schemaVersion, SCHEMA_VERSION);
  assert.match(result.manifest.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.manifest.company, 'T10 Co');
  assert.ok(result.manifest.counts.users >= 2, 'an empty-looking backup should be suspicious');

  const manifest = await backup.verify(result.path);
  assert.equal(manifest.sha256, result.manifest.sha256);
  assert.equal(manifest.integrity, 'ok');

  const listed = backup.list(BACKUP_DIR);
  assert.ok(listed.some((entry) => entry.path === result.path));
  assert.ok(listed.every((entry) => entry.manifestValid), 'every entry we wrote has a readable manifest');
});

test('T10-11 a tampered copy and a newer schema version are both refused', async () => {
  await bootstrap();
  const result = await backup.create(BACKUP_DIR, SCOPE);

  const tampered = path.join(BACKUP_DIR, 'tampered.db');
  const bytes = fs.readFileSync(result.path);
  const flipped = Buffer.from(bytes);
  flipped[Math.floor(flipped.length / 2)] ^= 0xff;
  fs.writeFileSync(tampered, flipped);
  fs.copyFileSync(`${result.path}.manifest.json`, `${tampered}.manifest.json`);

  await assert.rejects(
    () => backup.verify(tampered),
    (error) => {
      assert.equal(error.code, 'CONFLICT');
      assert.match(error.message, /checksum/i);
      return true;
    },
  );

  const future = path.join(BACKUP_DIR, 'from-the-future.db');
  fs.copyFileSync(result.path, future);
  const manifest = JSON.parse(fs.readFileSync(`${result.path}.manifest.json`, 'utf8'));
  fs.writeFileSync(
    `${future}.manifest.json`,
    JSON.stringify({ ...manifest, schemaVersion: 99, filename: 'from-the-future.db' }),
    'utf8',
  );
  await assert.rejects(
    () => backup.verify(future),
    (error) => {
      assert.equal(error.code, 'CONFLICT');
      assert.match(error.message, /schema v99/);
      return true;
    },
  );

  const orphan = path.join(BACKUP_DIR, 'orphan.db');
  fs.copyFileSync(result.path, orphan);
  await assert.rejects(
    () => backup.verify(orphan),
    (error) => {
      assert.equal(error.code, 'CONFLICT');
      assert.match(error.message, /manifest/i);
      return true;
    },
  );
});

test('T10-12 restore rewinds the database and leaves a pre-restore copy', async () => {
  await bootstrap();
  const stamp = String(Date.now()).slice(-6);
  const keepCode = `KEEP${stamp}`;
  const goneCode = `GONE${stamp}`;
  const at = new Date().toISOString();
  const insertCustomer = (code, name) => {
    conn().run(
      `INSERT INTO customers (id, code, name, legal_name, tax_id, email, phone, address_json,
         payment_terms_days, price_list_id, credit_limit_cents, currency, is_active, notes,
         custom_json, crm_account_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, 30, NULL, 0, 'USD', 1, NULL, '{}', NULL, ?, ?)`,
      [randomUUID(), code, name, at, at],
    );
  };

  insertCustomer(keepCode, 'Kept Before The Backup');
  // The dispatcher marks the image dirty after every write; a service called
  // directly from a test has to do it itself, or `flushNow()` has nothing to
  // flush and the backup captures whatever was last persisted.
  conn().markDirty();
  const snapshot = await backup.create(BACKUP_DIR, SCOPE);

  insertCustomer(goneCode, 'Added After The Backup');
  conn().markDirty();
  const probe = audit.append({
    actorId: SCOPE.actorId,
    actorName: SCOPE.actorName,
    entity: 'test_probe',
    entityId: 'after-backup',
    action: 'probe',
    after: { note: 'this row must not survive the restore' },
  });
  conn().flushNow();

  const result = await backup.restore(snapshot.path, SCOPE);
  assert.equal(result.requiresLogin, true, 'a restore invalidates every session');
  assert.equal(result.integrity, 'ok');

  assert.equal(
    conn().one('SELECT COUNT(*) AS total FROM customers WHERE code = ?', [keepCode]).total,
    1,
    'the snapshot keeps what it held',
  );
  assert.equal(
    conn().one('SELECT COUNT(*) AS total FROM customers WHERE code = ?', [goneCode]).total,
    0,
    'and drops what was written after it — that is what rewinding means',
  );
  assert.equal(audit.bySeq(probe.seq), null, 'the audit log rewinds with the data it describes');

  const copies = backup.preRestoreCopies(DB_FILE);
  assert.ok(copies.length >= 1, 'the pre-restore copy is the undo, and it must be on disk');
  assert.ok(fs.existsSync(copies[0]));

  // The restored database must still be a working one, chain and all.
  assert.equal(audit.verify().ok, true);
  assert.equal(countRows('customers') > 0, true);
});

// ── T10 audit viewer ─────────────────────────────────────────────────────────

test('T10-13 the audit viewer filters by entity and action', async () => {
  await bootstrap();
  const probe = audit.append({
    actorId: SCOPE.actorId,
    actorName: SCOPE.actorName,
    entity: 'test_filter',
    entityId: 'probe-1',
    action: 'filter_probe',
    after: { ok: true },
  });
  audit.append({
    actorId: SCOPE.actorId,
    actorName: SCOPE.actorName,
    entity: 'test_filter',
    entityId: 'probe-2',
    action: 'other_probe',
    after: { ok: true },
  });
  audit.append({
    actorId: 'someone-else',
    actorName: 'Someone Else',
    entity: 'unrelated',
    entityId: 'probe-3',
    action: 'filter_probe',
    after: { ok: true },
  });

  const byEntity = audit.list({ entity: 'test_filter' });
  assert.equal(byEntity.total, 2);
  assert.ok(byEntity.rows.every((row) => row.entity === 'test_filter'));

  const byAction = audit.list({ entity: 'test_filter', action: 'filter_probe' });
  assert.equal(byAction.total, 1);
  assert.equal(byAction.rows[0].seq, probe.seq);

  const byActor = audit.list({ actorId: 'someone-else' });
  assert.ok(byActor.rows.every((row) => row.actorId === 'someone-else'));

  const paged = audit.list({ entity: 'test_filter', limit: 1 });
  assert.equal(paged.rows.length, 1);
  assert.equal(paged.total, 2, 'the total is the filtered count, not the page length');
});

test('T10-14 the diff splits added, changed and removed fields', async () => {
  await bootstrap();
  const entry = audit.append({
    actorId: SCOPE.actorId,
    actorName: SCOPE.actorName,
    entity: 'test_diff',
    entityId: 'probe',
    action: 'update',
    before: { name: 'Old name', status: 'open', obsolete: 'gone' },
    after: { name: 'New name', status: 'open', added: 'fresh' },
  });

  const diff = admin.diffEntry(entry.seq);
  assert.equal(diff.seq, entry.seq);
  assert.deepEqual(diff.added.map((change) => change.field), ['added']);
  assert.deepEqual(diff.removed.map((change) => change.field), ['obsolete']);
  assert.deepEqual(diff.changed.map((change) => change.field), ['name']);

  const renamed = diff.changed[0];
  assert.equal(renamed.before, 'Old name');
  assert.equal(renamed.after, 'New name');
  assert.equal(diff.added[0].before, null, 'an added field had nothing before it');
  assert.equal(diff.removed[0].after, null);

  assert.throws(
    () => admin.diffEntry(999_999),
    (error) => {
      assert.equal(error.code, 'NOT_FOUND');
      return true;
    },
  );
});

test('T10-15 the hash chain still verifies after every mutation above', async () => {
  await bootstrap();
  const result = audit.verify();
  assert.equal(result.ok, true, `the chain broke at seq ${String(result.brokenAtSeq)}`);
  assert.ok(result.checked > 0);

  // And a tampered row is caught, which is the only thing that makes the
  // "Verify chain" button worth pressing.
  const row = conn().one('SELECT seq, after_json FROM audit_log ORDER BY seq DESC LIMIT 1');
  conn().run('UPDATE audit_log SET after_json = ? WHERE seq = ?', ['{"tampered":true}', row.seq]);
  const broken = audit.verify();
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAtSeq, Number(row.seq));
  conn().run('UPDATE audit_log SET after_json = ? WHERE seq = ?', [row.after_json, row.seq]);
  assert.equal(audit.verify().ok, true, 'restoring the row restores the chain');
});

// ── T09 the palette ──────────────────────────────────────────────────────────

/** Reads the palette's declared permissions straight from the component. */
function palettePermissions() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'components', 'CommandPalette.tsx'),
    'utf8',
  );
  const sections = {};
  for (const name of ['ROUTES', 'ACTIONS']) {
    const start = source.indexOf(`const ${name}: readonly`);
    assert.ok(start >= 0, `${name} must be declared in the palette`);
    const end = source.indexOf('\n];', start);
    assert.ok(end > start, `${name} must be a closed array`);
    sections[name] = [...source.slice(start, end).matchAll(/permission: '([^']+)'/g)].map((match) => match[1]);
  }
  return sections;
}

test('T10-16 every palette permission exists in the catalogue', async () => {
  await bootstrap();
  const { ROUTES, ACTIONS } = palettePermissions();

  assert.ok(ACTIONS.length >= 15, 'the palette must offer the create flows, not only navigation');
  assert.ok(ROUTES.length >= 30, 'and it must be able to reach every screen');

  for (const key of [...ROUTES, ...ACTIONS]) {
    assert.ok(permissions.isPermission(key), `the palette references an unknown permission: ${key}`);
  }
  for (const key of ACTIONS) {
    assert.ok(
      Object.values(permissions.ROLE_PRESETS).some((preset) => preset.permissions.includes(key)),
      `no role can ever see the action guarded by ${key}`,
    );
  }
});

/**
 * Every channel in the admin surface whose handler is `async`.
 *
 * The dispatcher runs a mutating handler inside a transaction and refuses one
 * that returns a promise, so an async channel that is not classified as
 * self-auditing fails with INTERNAL on its first click — which is exactly how
 * the Backup button behaved until this test existed.
 */
function asyncAdminChannels() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.admin.ts'), 'utf8');
  const blocks = source.split('register({').slice(1);
  const out = [];
  for (const block of blocks) {
    const channel = /channel: '([^']+)'/.exec(block);
    if (channel && /handler: async/.test(block)) out.push(channel[1]);
  }
  return out;
}

test('T10-18 an async handler is always a channel that manages its own transaction', async () => {
  await bootstrap();
  const channels = require(path.join(SHARED, 'channels.js'));
  const asyncChannels = asyncAdminChannels();

  assert.ok(asyncChannels.includes('backup.run'), 'the driver should see the backup channel');
  for (const channel of asyncChannels) {
    assert.ok(
      channels.READ_ONLY_CHANNELS.has(channel) || channels.SELF_AUDITING_CHANNELS.has(channel),
      `${channel} has an async handler but is neither read-only nor self-auditing, so it will fail with INTERNAL`,
    );
  }
  assert.ok(
    channels.SELF_AUDITING_CHANNELS.has('backup.restore'),
    'restore closes the live connection and cannot run inside the dispatcher transaction',
  );
});

test('T10-17 a viewer is never offered an action that changes something', async () => {
  await bootstrap();
  const { ACTIONS } = palettePermissions();
  const owner = permissions.resolvePermissions([permissions.ROLE_PRESETS.owner.permissions]);
  const viewer = permissions.resolvePermissions([permissions.ROLE_PRESETS.viewer.permissions]);
  const sales = permissions.resolvePermissions([permissions.ROLE_PRESETS.sales.permissions]);

  const visible = (role) => ACTIONS.filter((key) => role.has(key));
  const mutates = (key) => /\.(create|write|manage|run|post|convert|delete|void|approve|adjust)$/.test(key);

  assert.equal(visible(owner).length, ACTIONS.length, 'the owner may start everything');
  assert.equal(
    visible(viewer).filter(mutates).length,
    0,
    'a viewer must not be offered a single create flow',
  );
  assert.ok(visible(viewer).length < visible(owner).length);
  assert.ok(visible(sales).length > 0 && visible(sales).length < ACTIONS.length);
  assert.ok(visible(sales).includes('crm.deal.write'));
  assert.ok(visible(sales).includes('sales.quotation.create'));
  assert.equal(visible(sales).includes('settings.backup.run'), false, 'sales cannot take a backup');
  assert.equal(visible(sales).includes('finance.invoice.create'), false, 'sales raises quotes, not invoices');
});
