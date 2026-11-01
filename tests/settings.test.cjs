/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * T04 acceptance tests: numbering gaplessness, preset atomicity, custom-field
 * validation and module/permission filtering.
 *
 * These run against a real sql.js database in a temp directory and call the
 * service functions directly — no Electron, no IPC, so a failure points at the
 * business rule rather than the transport.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const DIST = path.join(__dirname, '..', 'dist', 'main', 'main');
const { initConnection, conn } = require(path.join(DIST, 'db', 'connection.js'));
const { migrate } = require(path.join(DIST, 'db', 'migrate.js'));
const seed = require(path.join(DIST, 'db', 'seed.js'));
const settings = require(path.join(DIST, 'services', 'settings.js'));
const usersService = require(path.join(DIST, 'services', 'users.js'));
const SHARED = path.join(__dirname, '..', 'dist', 'main', 'shared');
const { visibleModules, isModuleEnabled, MODULES } = require(path.join(SHARED, 'modules.js'));
const { ROLE_PRESETS } = require(path.join(SHARED, 'permissions.js'));

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-settings-'));
const DB_FILE = path.join(WORK_DIR, 'nexus.db');
const WASM_FILE = require.resolve('sql.js/dist/sql-wasm.wasm');

let ready = false;

async function bootstrap() {
  if (ready) return;
  await initConnection({ wasmPath: WASM_FILE, filePath: DB_FILE });
  migrate();
  usersService.ensureRolePresets();
  const at = new Date().toISOString();
  conn().run(
    `INSERT INTO companies (id, name, legal_name, tax_id, address_json, logo_path, base_currency,
       fiscal_year_start_month, date_format, number_format, industry_preset, created_at, updated_at)
     VALUES ('co-1', 'Test Co', NULL, NULL, NULL, NULL, 'USD', 1, 'yyyy-MM-dd', '1,234.56', NULL, ?, ?)`,
    [at, at],
  );
  conn().tx(() => seed.applyPreset('wholesale_retail', 'USD'));
  ready = true;
}

test('T04-01 a preset writes a valid chart of accounts, taxes and a pipeline', async () => {
  await bootstrap();

  const accounts = conn().one('SELECT COUNT(*) AS total FROM accounts');
  assert.ok(Number(accounts.total) >= 20, `expected a 20+ account chart, saw ${accounts.total}`);

  const postable = conn().one('SELECT COUNT(*) AS total FROM accounts WHERE is_postable = 1');
  assert.ok(Number(postable.total) > 0);

  const orphans = conn().one(
    'SELECT COUNT(*) AS total FROM accounts WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM accounts)',
  );
  assert.equal(Number(orphans.total), 0, 'every parent_id must resolve');

  const taxes = conn().one('SELECT COUNT(*) AS total FROM taxes');
  assert.ok(Number(taxes.total) >= 2, 'the preset seeds at least two tax rates');

  const stages = conn().one('SELECT COUNT(*) AS total FROM deal_stages');
  assert.ok(Number(stages.total) >= 3, 'the preset seeds a pipeline');

  const journals = conn().all('SELECT code FROM journals ORDER BY code');
  assert.deepEqual(
    journals.map((row) => row.code),
    ['BNK', 'CSH', 'GEN', 'PUR', 'SAL', 'STK'],
    'the posting engine needs all six journals to exist',
  );
});

test('T04-02 numbering is gapless and previews without consuming', async () => {
  await bootstrap();

  const saved = settings.saveSequence({ docType: 'invoice', prefix: 'INV-', padding: 5 });
  assert.equal(saved.prefix, 'INV-');
  assert.equal(saved.padding, 5);

  // Three previews must not move the counter (BR-08).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(settings.previewNumber('invoice').next, 'INV-00001');
  }

  const year = settings.ensureFiscalYear(1);
  const numbers = [];
  conn().tx(() => {
    for (let index = 0; index < 3; index += 1) {
      numbers.push(settings.nextNumber('invoice', year.id));
    }
  });

  assert.deepEqual(numbers, ['INV-00001', 'INV-00002', 'INV-00003']);
  assert.equal(settings.previewNumber('invoice').next, 'INV-00004');

  // Deleting a draft never touched the sequence: drafts have no number at all.
  const sequence = settings.listSequences().find((entry) => entry.docType === 'invoice');
  assert.equal(sequence.nextValue, 4);
});

test('T04-03 a failure inside the onboarding transaction leaves zero rows', async () => {
  await bootstrap();

  const accountsBefore = Number(conn().one('SELECT COUNT(*) AS total FROM accounts').total);

  // Simulate the demo step throwing after the preset has already written rows.
  assert.throws(() => {
    conn().tx(() => {
      seed.applyPreset('manufacturing', 'USD');
      throw new Error('forced failure at the demo step');
    });
  }, /forced failure/);

  const accountsAfter = Number(conn().one('SELECT COUNT(*) AS total FROM accounts').total);
  assert.equal(accountsAfter, accountsBefore, 'the preset must roll back with the transaction');

  const companies = Number(conn().one('SELECT COUNT(*) AS total FROM companies').total);
  assert.equal(companies, 1, 'no partial company row survives');
});

test('T04-04 a required custom field blocks an empty save (US-49)', async () => {
  await bootstrap();

  settings.saveCustomField({
    entity: 'customers',
    key: 'GSTIN',
    label: 'GSTIN',
    type: 'text',
    isRequired: true,
  });

  assert.throws(() => settings.validateCustomValues('customers', {}), /required/i);
  assert.throws(() => settings.validateCustomValues('customers', { GSTIN: '   ' }), /required/i);

  // A value satisfies it, and unknown keys are ignored rather than rejected.
  settings.validateCustomValues('customers', { GSTIN: '27AAPFU0939F1ZV', somethingElse: 1 });

  // Wrong type for a numeric field is refused.
  settings.saveCustomField({ entity: 'products', key: 'weight_kg', label: 'Weight', type: 'number' });
  assert.throws(() => settings.validateCustomValues('products', { weight_kg: 'heavy' }), /number/i);
  settings.validateCustomValues('products', { weight_kg: 12.5 });
});

test('T04-05 custom values round-trip through the value table', async () => {
  await bootstrap();

  settings.setCustomValues('customers', 'customer-1', { GSTIN: '27AAPFU0939F1ZV' });
  const stored = settings.getCustomValues('customers', 'customer-1');
  assert.equal(stored.GSTIN, '27AAPFU0939F1ZV');

  settings.setCustomValues('customers', 'customer-1', { GSTIN: null });
  assert.equal(settings.getCustomValues('customers', 'customer-1').GSTIN, undefined);
});

test('T04-06 the base currency is frozen once entries are posted (BR-23)', async () => {
  await bootstrap();

  // Before any entry: allowed.
  const first = settings.setBaseCurrency('EUR');
  assert.equal(first.refused, undefined);
  assert.equal(settings.getCompany().baseCurrency, 'EUR');

  // Post an entry, then try again.
  const year = settings.ensureFiscalYear(1);
  const period = conn().one('SELECT id FROM periods WHERE fiscal_year_id = ? ORDER BY start_date LIMIT 1', [year.id]);
  const journal = conn().one("SELECT id FROM journals WHERE code = 'GEN'");
  const account = conn().one('SELECT id FROM accounts LIMIT 1');
  conn().run(
    `INSERT INTO journal_entries (id, number, journal_id, date, period_id, memo, status, source_type, source_id,
       reverses_id, posted_at, posted_by, created_at, updated_at)
     VALUES ('je-1', 'JE-00001', ?, '2026-01-05', ?, NULL, 'posted', 'manual', NULL, NULL, ?, 'test', ?, ?)`,
    [journal.id, period.id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
  );
  void account;

  const second = settings.setBaseCurrency('USD');
  assert.ok(second.refused, 'a posted ledger must refuse a base-currency change');
  assert.equal(settings.getCompany().baseCurrency, 'EUR', 'the refused change left the currency alone');
});

test('T04-08 the demo dataset is dashboard-ready and removable in isolation', async () => {
  await bootstrap();

  const seeded = seed.seedDemo();
  assert.ok(seeded.created > 0, 'seedDemo must report what it wrote');
  assert.equal(seed.demoLoaded(), true);

  const count = (table) => Number(conn().one(`SELECT COUNT(*) AS total FROM ${table}`).total);
  assert.ok(count('customers') >= 3, `customers: ${count('customers')}`);
  assert.ok(count('vendors') >= 3, `vendors: ${count('vendors')}`);
  assert.ok(count('products') >= 8, `products: ${count('products')}`);
  assert.ok(count('invoices') >= 6, `invoices: ${count('invoices')}`);
  assert.ok(count('deals') >= 5, `deals: ${count('deals')}`);
  assert.ok(count('warehouses') >= 1, `warehouses: ${count('warehouses')}`);
  assert.ok(count('locations') >= 2, `locations: ${count('locations')}`);
  assert.ok(count('stock_moves') > 0, `stock_moves: ${count('stock_moves')}`);
  assert.ok(count('stock_quants') > 0, `stock_quants: ${count('stock_quants')}`);
  assert.ok(count('activities') > 0, `activities: ${count('activities')}`);

  // The stock quants must agree with the receipts they were derived from.
  const drift = conn().one(
    `SELECT COUNT(*) AS total FROM stock_quants q
      WHERE q.qty_milli <> (SELECT COALESCE(SUM(m.qty_milli), 0) FROM stock_moves m
                             WHERE m.product_id = q.product_id AND m.to_location_id = q.location_id)`,
  );
  assert.equal(Number(drift.total), 0, 'every quant equals the sum of its receipts');

  // A row the user created themselves must survive `removeDemo`.
  const at = new Date().toISOString();
  conn().run(
    `INSERT INTO customers (id, code, name, currency, created_at, updated_at)
     VALUES ('cust-manual', 'C-9000', 'Hand Entered Co', 'USD', ?, ?)`,
    [at, at],
  );

  const removed = seed.removeDemo();
  assert.ok(removed.removed > 0, 'removeDemo must report what it deleted');
  assert.equal(seed.demoLoaded(), false, 'the demo index is cleared');

  assert.equal(count('customers'), 1, 'only the hand-entered customer is left');
  assert.equal(conn().one('SELECT name FROM customers').name, 'Hand Entered Co');
  for (const table of ['vendors', 'products', 'invoices', 'deals', 'warehouses', 'stock_moves', 'stock_quants']) {
    assert.equal(count(table), 0, `${table} still holds demo rows`);
  }
  assert.equal(count('invoice_lines'), 0, 'demo invoice lines are deleted with their invoices');
});

test('T04-09 the industry preset decides which modules exist', async () => {
  // `services` has no inventory at all.
  const servicesPreset = 'services';
  const inventory = MODULES.find((module) => module.id === 'inventory');
  assert.ok(inventory);
  assert.equal(isModuleEnabled(inventory, servicesPreset), false);
  assert.equal(isModuleEnabled(inventory, 'wholesale_retail'), true);

  const allPermissions = new Set(ROLE_PRESETS.owner.permissions);
  const servicesModules = visibleModules(servicesPreset, allPermissions).map((module) => module.id);
  assert.equal(servicesModules.includes('inventory'), false);
  assert.equal(servicesModules.includes('finance'), true);

  // A role without finance permissions sees no finance module, even when enabled.
  const viewerPermissions = new Set(ROLE_PRESETS.viewer.permissions);
  const viewerModules = visibleModules('wholesale_retail', viewerPermissions).map((module) => module.id);
  assert.equal(viewerModules.includes('finance'), true, 'the viewer preset is read-everything');

  const noFinance = new Set([...viewerPermissions].filter((permission) => !permission.startsWith('finance.')));
  const restricted = visibleModules('wholesale_retail', noFinance).map((module) => module.id);
  assert.equal(restricted.includes('finance'), false, 'a module needs at least one of its permissions');
});
