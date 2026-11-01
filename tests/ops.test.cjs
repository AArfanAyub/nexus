/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * T07/T08 acceptance tests — inventory, purchasing, sales.
 *
 * Same shape as `finance.test.cjs`: real services against a real sql.js database,
 * no Electron and no IPC. Each test asserts a property that would be a defect in
 * production:
 *
 *   T07-01  a transfer keeps company-wide on-hand constant (BR-12)
 *   T07-02  issuing more than is on hand is refused and names the available qty
 *   T07-03  the same issue succeeds with the permission and a reason, and audits it
 *   T07-04  an adjustment with a reason moves stock and writes a variance entry
 *   T07-05  FIFO consumes oldest-first, so COGS reflects the oldest layer
 *   T07-06  valuation is identical before and after a quant rebuild (cache is derived)
 *   T07-07  a receipt posts Dr Inventory / Cr GRNI, not an expense
 *   T08-01  a 100-unit PO receives 40 → partially_received, then 60 → received
 *   T08-02  over-receipt is refused and names the outstanding quantity
 *   T08-03  3-way match: inside tolerance posts, outside tolerance is an exception
 *   T08-04  an exception posts only with the approval permission and a reason
 *   T08-05  price resolution falls through an expired customer list to the default
 *   T08-06  an expired quote refuses to convert, and the override is audited
 *   T08-07  a delivery posts COGS, reduces stock, and invoice-from-order bills only
 *           what was delivered
 *   T08-08  confirming an order over the credit limit is refused without the override
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');

const DIST = path.join(__dirname, '..', 'dist', 'main', 'main');
/** Shared code is emitted once, next to `main/`, not inside it. */
const SHARED = path.join(__dirname, '..', 'dist', 'main', 'shared');
const { initConnection, conn } = require(path.join(DIST, 'db', 'connection.js'));
const { migrate } = require(path.join(DIST, 'db', 'migrate.js'));
const seed = require(path.join(DIST, 'db', 'seed.js'));
const settings = require(path.join(DIST, 'services', 'settings.js'));
const usersService = require(path.join(DIST, 'services', 'users.js'));
const finance = require(path.join(DIST, 'services', 'finance.js'));
const inventory = require(path.join(DIST, 'services', 'inventory.js'));
const purchasing = require(path.join(DIST, 'services', 'purchasing.js'));
const sales = require(path.join(DIST, 'services', 'sales.js'));
const audit = require(path.join(DIST, 'services', 'audit.js'));
const schemas = require(path.join(SHARED, 'schemas.js'));

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ops-'));
const DB_FILE = path.join(WORK_DIR, 'nexus.db');
const WASM_FILE = require.resolve('sql.js/dist/sql-wasm.wasm');

const SCOPE = { actorId: 'user-ops', actorName: 'Ops Operator' };
const ALL_PERMISSIONS = new Set([
  'inventory.stock.allow_negative',
  'sales.quotation.override_expiry',
  'sales.order.override_credit',
]);
const NO_PERMISSIONS = new Set();
const TODAY = new Date().toISOString().slice(0, 10);

let ready = false;
let customerId = '';
let vendorId = '';
let warehouseId = '';
let locA = '';
let locB = '';
let fifoProduct = '';
let avcoProduct = '';

function isoDaysFromNow(days) {
  const date = new Date(`${TODAY}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
     VALUES ('co-1', 'Ops Co', NULL, NULL, NULL, NULL, 'USD', 1, 'yyyy-MM-dd', '1,234.56', NULL, ?, ?)`,
    [at, at],
  );
  conn().tx(() => seed.applyPreset('wholesale_retail', 'USD'));
  settings.ensureFiscalYear(1);

  conn().run(
    `INSERT INTO users (id, username, full_name, email, password_hash, password_salt, password_algo,
       must_change_password, is_active, is_owner, prefs_json, failed_attempts, created_at, updated_at)
     VALUES ('user-ops', 'operator', 'Ops Operator', NULL, 'x', 'x', 'scrypt-n16384-r8-p1',
       0, 1, 1, '{}', 0, ?, ?)`,
    [at, at],
  );

  customerId = randomUUID();
  conn().run(
    `INSERT INTO customers (id, code, name, legal_name, tax_id, email, phone, address_json, payment_terms_days,
       credit_limit_cents, currency, is_active, notes, custom_json, created_at, updated_at)
     VALUES (?, 'C-001', 'Northwind Traders', NULL, NULL, NULL, NULL, NULL, 30, 100000, 'USD', 1, NULL, '{}', ?, ?)`,
    [customerId, at, at],
  );

  vendorId = randomUUID();
  conn().run(
    `INSERT INTO vendors (id, code, name, legal_name, tax_id, email, phone, address_json, payment_terms_days,
       currency, is_active, notes, custom_json, created_at, updated_at)
     VALUES (?, 'V-001', 'Contoso Supply', NULL, NULL, NULL, NULL, NULL, 30, 'USD', 1, NULL, '{}', ?, ?)`,
    [vendorId, at, at],
  );

  warehouseId = randomUUID();
  conn().run('INSERT INTO warehouses (id, code, name, address_json, is_active, created_at, updated_at) VALUES (?, ?, ?, NULL, 1, ?, ?)', [
    warehouseId,
    'WH1',
    'Main warehouse',
    at,
    at,
  ]);
  locA = randomUUID();
  locB = randomUUID();
  conn().run('INSERT INTO locations (id, warehouse_id, code, name, is_active) VALUES (?, ?, ?, ?, 1)', [
    locA,
    warehouseId,
    'A1',
    'Aisle 1',
  ]);
  conn().run('INSERT INTO locations (id, warehouse_id, code, name, is_active) VALUES (?, ?, ?, ?, 1)', [
    locB,
    warehouseId,
    'A2',
    'Aisle 2',
  ]);

  fifoProduct = randomUUID();
  conn().run(
    `INSERT INTO products (id, sku, barcode, name, description, uom, category, cost_method,
       standard_cost_cents, base_price_cents, tax_id, reorder_point_milli, is_stock_tracked, is_active,
       income_account_id, expense_account_id, inventory_account_id, custom_json, created_at, updated_at)
     VALUES (?, 'SKU-FIFO', NULL, 'FIFO widget', NULL, 'unit', 'Widgets', 'fifo',
       0, 2000, NULL, 20000, 1, 1, NULL, NULL, NULL, '{}', ?, ?)`,
    [fifoProduct, at, at],
  );

  avcoProduct = randomUUID();
  conn().run(
    `INSERT INTO products (id, sku, barcode, name, description, uom, category, cost_method,
       standard_cost_cents, base_price_cents, tax_id, reorder_point_milli, is_stock_tracked, is_active,
       income_account_id, expense_account_id, inventory_account_id, custom_json, created_at, updated_at)
     VALUES (?, 'SKU-AVCO', NULL, 'Average widget', NULL, 'unit', 'Widgets', 'avco',
       0, 3000, NULL, 0, 1, 1, NULL, NULL, NULL, '{}', ?, ?)`,
    [avcoProduct, at, at],
  );

  ready = true;
}

function onHand(productId) {
  return inventory.onHandTotal(productId);
}

/**
 * A product nobody else has touched.
 *
 * The tests share one database (bootstrap is expensive), so a test that used the
 * module-level product would inherit whatever the previous test left on hand —
 * which is exactly how a "refused" assertion starts passing for the wrong reason.
 * Every quantity-sensitive test makes its own product instead.
 */
let skuSeq = 0;
function freshProduct(costMethod = 'avco') {
  skuSeq += 1;
  const id = randomUUID();
  const at = new Date().toISOString();
  conn().run(
    `INSERT INTO products (id, sku, barcode, name, description, uom, category, cost_method,
       standard_cost_cents, base_price_cents, tax_id, reorder_point_milli, is_stock_tracked, is_active,
       income_account_id, expense_account_id, inventory_account_id, custom_json, created_at, updated_at)
     VALUES (?, ?, NULL, ?, NULL, 'unit', 'Widgets', ?, 0, 3000, NULL, 0, 1, 1, NULL, NULL, NULL, '{}', ?, ?)`,
    [id, `SKU-${String(skuSeq).padStart(4, '0')}`, `Widget ${String(skuSeq)}`, costMethod, at, at],
  );
  return id;
}

/** GL balance of an account code, signed as a debit-positive balance. */
function glBalance(code) {
  const row = conn().one(
    `SELECT COALESCE(SUM(jl.debit_cents), 0) AS dr, COALESCE(SUM(jl.credit_cents), 0) AS cr
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE a.code = ?`,
    [code],
  );
  return Number(row.dr) - Number(row.cr);
}

function receipt(productId, qty, cost, toLocationId = locA) {
  return inventory.postMove(
    {
      type: 'receipt',
      productId,
      toLocationId,
      qtyMilli: qty,
      unitCostCents: cost,
      movedAt: TODAY,
    },
    SCOPE,
  );
}

// ── inventory ────────────────────────────────────────────────────────────────

test('T07-01 a transfer keeps company-wide on-hand constant and moves the per-location balance', async () => {
  await bootstrap();
  const product = freshProduct();
  receipt(product, 100_000, 1000);
  const before = onHand(product);
  const atA = inventory.onHandAt(product, locA);

  const result = inventory.postMove(
    { type: 'transfer', productId: product, fromLocationId: locA, toLocationId: locB, qtyMilli: 30_000 },
    SCOPE,
  );

  assert.equal(onHand(product), before, 'a transfer must not change the total');
  assert.equal(inventory.onHandAt(product, locA), atA - 30_000);
  assert.equal(inventory.onHandAt(product, locB), 30_000);
  assert.equal(result.move.type, 'transfer');
  assert.equal(result.journalEntryId, null, 'a transfer posts no journal — same company, same account');
  assert.equal(result.move.fromLocationId, locA);
  assert.equal(result.move.toLocationId, locB);
});

test('T07-02 issuing more than is on hand is refused and names the available quantity', async () => {
  await bootstrap();
  const product = freshProduct();
  receipt(product, 10_000, 1000);

  assert.throws(
    () =>
      inventory.postMove(
        { type: 'issue', productId: product, fromLocationId: locA, qtyMilli: -15_000 },
        SCOPE,
        NO_PERMISSIONS,
      ),
    (error) => {
      assert.equal(error.code, 'CONFLICT');
      assert.match(error.message, /Only 10\.000/);
      return true;
    },
  );
  assert.equal(inventory.onHandAt(product, locA), 10_000, 'a refused issue must not move stock');
});

test('T07-03 the same issue succeeds with the permission and a reason, and writes an audit row', async () => {
  await bootstrap();
  const product = freshProduct();
  receipt(product, 10_000, 1000);
  const before = audit.list({ entity: 'stock_moves' }).total;

  const result = inventory.postMove(
    {
      type: 'issue',
      productId: product,
      fromLocationId: locA,
      qtyMilli: -15_000,
      reason: 'Emergency despatch authorised by the warehouse manager',
      allowNegative: true,
    },
    SCOPE,
    ALL_PERMISSIONS,
  );

  assert.equal(result.override, true);
  assert.equal(inventory.onHandAt(product, locA), -5000, 'the override really does go negative');

  const rows = audit.list({ entity: 'stock_moves' });
  assert.ok(rows.total > before, 'the override must add an audit row');
  const override = rows.rows.find((row) => row.action === 'override_negative_stock');
  assert.ok(override, 'the audit row names the override');
});

test('T07-04 an adjustment needs a reason, moves stock, and posts a variance entry', async () => {
  await bootstrap();
  const product = freshProduct();
  receipt(product, 50_000, 1000);

  assert.throws(
    () => inventory.postMove({ type: 'adjustment', productId: product, toLocationId: locA, qtyMilli: -3000 }, SCOPE),
    /reason/i,
  );

  const varianceBefore = glBalance('5030');
  const result = inventory.postMove(
    {
      type: 'adjustment',
      productId: product,
      fromLocationId: locA,
      qtyMilli: -3000,
      reason: 'Stock count found three damaged units',
    },
    SCOPE,
  );

  assert.equal(inventory.onHandAt(product, locA), 47_000);
  assert.equal(result.move.type, 'adjustment');
  // Three units at 10.00 is 30.00 of value, and a loss debits the variance account.
  assert.equal(glBalance('5030') - varianceBefore, 3000, 'the loss is valued at cost');
});

test('T07-05 FIFO consumes the oldest layer first, so COGS follows the old price', async () => {
  await bootstrap();
  const product = freshProduct('fifo');
  // Two receipts at different prices, then an issue smaller than the first layer.
  receipt(product, 10_000, 1000);
  receipt(product, 10_000, 2000);

  const cogsBefore = glBalance('5010');
  const result = inventory.postMove(
    { type: 'issue', productId: product, fromLocationId: locA, qtyMilli: -6000 },
    SCOPE,
  );

  // 6 units out of the 10 that cost 10.00 must cost 60.00 (6000 cents), not the
  // 15.00 average the second layer would have implied.
  assert.equal(result.move.valueCents, 6000);
  assert.equal(glBalance('5010') - cogsBefore, 6000);

  const remaining = conn().all(
    "SELECT remaining_milli, unit_cost_cents FROM stock_layers WHERE product_id = ? AND remaining_milli > 0 ORDER BY received_at",
    [product],
  );
  assert.equal(remaining.length, 2);
  assert.equal(Number(remaining[0].remaining_milli), 4000, 'the oldest layer is partly consumed');
  assert.equal(Number(remaining[0].unit_cost_cents), 1000);
  assert.equal(Number(remaining[1].remaining_milli), 10_000, 'the newer layer is untouched');
});

test('T07-06 valuation is identical before and after a quant rebuild', async () => {
  await bootstrap();
  const fifo = freshProduct('fifo');
  const avco = freshProduct();
  receipt(fifo, 5000, 1500);
  receipt(avco, 8000, 900);
  inventory.postMove({ type: 'issue', productId: fifo, fromLocationId: locA, qtyMilli: -2000 }, SCOPE);

  const before = inventory.valuationReport(TODAY);
  inventory.rebuildQuants();
  const after = inventory.valuationReport(TODAY);

  assert.deepEqual(after.rows, before.rows, 'the cache is derived — a rebuild cannot change the valuation');
  assert.equal(after.totalValueCents, before.totalValueCents);
});

test('T07-07 a receipt posts Dr Inventory / Cr GRNI, never an expense', async () => {
  await bootstrap();
  const inventoryBefore = glBalance('1210');
  const grniBefore = glBalance('2110');
  const expenseBefore = glBalance('6010');

  receipt(freshProduct(), 10_000, 2500);

  assert.equal(glBalance('1210') - inventoryBefore, 25_000, 'inventory is debited');
  assert.equal(glBalance('2110') - grniBefore, -25_000, 'the accrual is credited');
  assert.equal(glBalance('6010') - expenseBefore, 0, 'receiving goods must not touch the P&L');
});

// ── purchasing ───────────────────────────────────────────────────────────────

/** The product the current PO is for. Each PO gets its own so stock cannot leak. */
let poProduct = '';

function makePo(qtyMilli = 100_000, unitPriceCents = 1000) {
  poProduct = freshProduct();
  const po = purchasing.savePo({
    vendorId,
    date: TODAY,
    expectedDate: isoDaysFromNow(7),
    warehouseId,
    lines: [{ productId: poProduct, description: 'Average widget', qtyMilli, unitPriceCents }],
  });
  return purchasing.confirmPo(po.id);
}

function receiveAgainst(po, qtyMilli, unitCostCents) {
  const detail = purchasing.getPo(po.id);
  const line = detail.lines[0];
  const draft = purchasing.saveReceipt({
    poId: po.id,
    vendorId,
    date: TODAY,
    warehouseId,
    locationId: locA,
    lines: [{ poLineId: line.id, productId: poProduct, qtyMilli, unitCostCents }],
  });
  return purchasing.postReceipt(draft.id, SCOPE);
}

test('T08-01 a 100-unit PO receives 40 → partially_received, then 60 → received', async () => {
  await bootstrap();
  const po = makePo(100_000);
  assert.equal(po.status, 'confirmed');

  const first = receiveAgainst(po, 40_000, 1000);
  assert.equal(first.status, 'posted');
  let detail = purchasing.getPo(po.id);
  assert.equal(detail.status, 'partially_received');
  assert.equal(detail.lines[0].receivedMilli, 40_000);
  assert.equal(detail.lines[0].remainingMilli, 60_000);

  receiveAgainst(po, 60_000, 1000);
  detail = purchasing.getPo(po.id);
  assert.equal(detail.status, 'received');
  assert.equal(detail.lines[0].remainingMilli, 0);
  assert.equal(inventory.onHandTotal(poProduct), 100_000);
});

test('T08-02 over-receipt is refused and names the outstanding quantity', async () => {
  await bootstrap();
  const po = makePo(100_000);
  receiveAgainst(po, 40_000, 1000);

  const detail = purchasing.getPo(po.id);
  assert.throws(
    () =>
      purchasing.saveReceipt({
        poId: po.id,
        vendorId,
        date: TODAY,
        warehouseId,
        locationId: locA,
        lines: [{ poLineId: detail.lines[0].id, productId: poProduct, qtyMilli: 61_000, unitCostCents: 1000 }],
      }),
    (error) => {
      assert.equal(error.code, 'CONFLICT');
      assert.match(error.message, /Only 60\.000/);
      return true;
    },
  );
  assert.equal(inventory.onHandTotal(poProduct), 40_000, 'a refused receipt moves no stock');
});

/** Builds a draft bill from the last posted receipt. */
function billFromLastReceipt(priceCents, qtyMilli) {
  const receipts = purchasing.listReceipts({ poId: undefined, status: 'posted', pageSize: 1 });
  const receipt = receipts.rows[0];
  const prefill = purchasing.billFromReceipt(receipt.id);
  const lines = prefill.lines.map((line) => ({
    ...line,
    qtyMilli,
    unitPriceCents: priceCents,
  }));
  return finance.saveBill({ ...prefill, lines }, SCOPE);
}

test('T08-03 a bill inside tolerance posts; one outside tolerance becomes an exception', async () => {
  await bootstrap();
  const po = makePo(100_000, 1000);
  receiveAgainst(po, 100_000, 1000);

  // +1.9 % — inside both the 2 % and the 50.00 caps.
  const inside = billFromLastReceipt(1019, 100_000);
  const match = purchasing.billMatch(inside.id);
  assert.equal(match.withinTolerance, true, `expected a pass, got: ${match.reasons.join(' ')}`);
  const grniBefore = glBalance('2110');
  const posted = finance.postBill(inside.id, SCOPE);
  assert.equal(posted.status, 'posted');
  assert.equal(posted.number !== null, true, 'a posted bill has a number');
  /*
   * GRNI is a liability, so `glBalance` (debit-positive) sits at −100 000 after the
   * receipt credits it. The bill debits the accrual at the **PO** price, so the
   * balance moves by +100 000 and the 19.00 difference goes to price variance.
   */
  assert.equal(glBalance('2110') - grniBefore, 100_000, 'the receipt accrual is cleared at PO price');

  // +2.5 % — outside the percentage cap.
  const po2 = makePo(100_000, 1000);
  receiveAgainst(po2, 100_000, 1000);
  const outside = billFromLastReceipt(1025, 100_000);
  const badMatch = purchasing.billMatch(outside.id);
  assert.equal(badMatch.withinTolerance, false);
  assert.match(badMatch.reasons.join(' '), /Priced 10\.25 against a PO price of 10\.00/);

  assert.throws(() => finance.postBill(outside.id, SCOPE), /needs approval/);
  const stuck = finance.getBill(outside.id);
  assert.equal(stuck.status, 'match_exception', 'the exception is stored, not just thrown');
  assert.ok(stuck.exceptionReason && stuck.exceptionReason.length > 0);
});

test('T08-04 an exception posts only with the approval permission and a reason, audited', async () => {
  await bootstrap();
  const po = makePo(100_000, 1000);
  receiveAgainst(po, 100_000, 1000);
  const bill = billFromLastReceipt(1100, 100_000);

  assert.throws(() => finance.postBill(bill.id, SCOPE), /needs approval/);
  assert.throws(
    () => finance.postBill(bill.id, SCOPE, { approveException: true }),
    /reason/i,
    'approving without a reason is refused',
  );

  const posted = finance.postBill(bill.id, SCOPE, {
    approveException: true,
    reason: 'Supplier surcharge agreed by the buyer',
  });
  assert.equal(posted.status, 'posted');
  assert.equal(posted.approvedBy, SCOPE.actorId);

  const rows = audit.list({ entity: 'bills' });
  assert.ok(
    rows.rows.some((row) => row.action === 'approve_match_exception'),
    'the approval is audited',
  );
});

// ── sales ────────────────────────────────────────────────────────────────────

test('T08-05 price resolution falls through an expired customer list to the default list', async () => {
  await bootstrap();

  const defaultList = sales.savePriceList({
    name: 'Standard 2026',
    isDefault: true,
    items: [{ productId: avcoProduct, priceCents: 2800 }],
  });
  const customerList = sales.savePriceList({
    name: 'Northwind contract 2025',
    validFrom: isoDaysFromNow(-400),
    validTo: isoDaysFromNow(-30),
    items: [{ productId: avcoProduct, priceCents: 1500 }],
  });

  conn().run('UPDATE customers SET price_list_id = ? WHERE id = ?', [customerList.id, customerId]);

  const resolved = sales.resolvePrice(avcoProduct, customerId, 1000, TODAY);
  assert.equal(resolved.source, 'default_list', 'an expired list must not be used');
  assert.equal(resolved.priceCents, 2800);
  assert.equal(resolved.listName, defaultList.name);

  // Inside the window the customer list wins.
  conn().run('UPDATE price_lists SET valid_to = ? WHERE id = ?', [isoDaysFromNow(30), customerList.id]);
  const live = sales.resolvePrice(avcoProduct, customerId, 1000, TODAY);
  assert.equal(live.source, 'customer_list');
  assert.equal(live.priceCents, 1500);

  // A contract price beats every list.
  conn().run('UPDATE customers SET custom_json = ? WHERE id = ?', [
    JSON.stringify({ contract_prices: { [avcoProduct]: 1200 } }),
    customerId,
  ]);
  const contract = sales.resolvePrice(avcoProduct, customerId, 1000, TODAY);
  assert.equal(contract.source, 'contract');
  assert.equal(contract.priceCents, 1200);
});

test('T08-06 an expired quote refuses to convert, and the override is audited', async () => {
  await bootstrap();
  const quote = sales.saveQuote({
    customerId,
    date: isoDaysFromNow(-40),
    expiryDate: isoDaysFromNow(-10),
    lines: [{ productId: avcoProduct, description: 'Average widget', qtyMilli: 2000, unitPriceCents: 2800 }],
  });
  assert.equal(quote.isExpired, true);

  assert.throws(() => sales.convertQuoteToOrder(quote.id, SCOPE, {}, NO_PERMISSIONS), /expired/);
  assert.throws(
    () => sales.convertQuoteToOrder(quote.id, SCOPE, { overrideExpiry: true, reason: 'x' }, NO_PERMISSIONS),
    /do not hold the permission/,
  );

  const order = sales.convertQuoteToOrder(
    quote.id,
    SCOPE,
    { overrideExpiry: true, reason: 'Customer accepted late in writing' },
    ALL_PERMISSIONS,
  );
  assert.equal(order.customerId, customerId);
  assert.equal(order.lines[0].qtyMilli, 2000);

  const converted = sales.getQuote(quote.id);
  assert.equal(converted.status, 'converted');
  assert.equal(converted.convertedOrderId, order.id, 'the quote points at its order');
  assert.equal(order.quoteId, quote.id, 'and the order points back');

  const rows = audit.list({ entity: 'quotes' });
  assert.ok(rows.rows.some((row) => row.action === 'override_expiry'), 'the override is audited');
});

test('T08-07 a delivery posts COGS, reduces stock, and the invoice bills only what was delivered', async () => {
  await bootstrap();
  const product = freshProduct();
  receipt(product, 50_000, 1000);

  const order = sales.saveOrder({
    customerId,
    date: TODAY,
    warehouseId,
    lines: [{ productId: product, description: 'Average widget', qtyMilli: 10_000, unitPriceCents: 2800 }],
  });
  sales.confirmOrder(order.id, SCOPE, {}, ALL_PERMISSIONS);

  const soLine = sales.getOrder(order.id).lines[0];
  const draft = sales.saveDelivery({
    orderId: order.id,
    customerId,
    date: TODAY,
    warehouseId,
    lines: [{ soLineId: soLine.id, productId: product, qtyMilli: 4000 }],
  });

  const cogsBefore = glBalance('5010');
  const stockBefore = inventory.onHandTotal(product);
  const posted = sales.postDelivery(draft.id, SCOPE);

  assert.equal(posted.status, 'posted');
  assert.equal(inventory.onHandTotal(product), stockBefore - 4000, 'stock left the building');
  assert.equal(glBalance('5010') - cogsBefore, 4000, 'COGS is 4 × 10.00 = 40.00');

  const afterOrder = sales.getOrder(order.id);
  assert.equal(afterOrder.status, 'partially_delivered');
  assert.equal(afterOrder.lines[0].deliveredMilli, 4000);
  assert.equal(afterOrder.lines[0].remainingMilli, 6000);

  const prefill = sales.invoiceFromOrder(order.id);
  assert.equal(prefill.lines.length, 1);
  assert.equal(prefill.lines[0].qtyMilli, 4000, 'only the delivered quantity is billable');
});

test('T08-08 confirming an order over the credit limit is refused without the override', async () => {
  await bootstrap();
  // The customer's limit is 1 000.00; this order is 2 800.00.
  const order = sales.saveOrder({
    customerId,
    date: TODAY,
    warehouseId,
    lines: [{ productId: freshProduct(), description: 'Average widget', qtyMilli: 100_000, unitPriceCents: 2800 }],
  });

  const check = sales.checkCredit(customerId, order.totalCents);
  assert.equal(check.withinLimit, false);
  assert.equal(check.creditLimitCents, 100_000);
  assert.equal(check.excessCents, order.totalCents - 100_000);

  assert.throws(() => sales.confirmOrder(order.id, SCOPE, {}, NO_PERMISSIONS), /limit/);
  assert.throws(
    () => sales.confirmOrder(order.id, SCOPE, { overrideCredit: true }, ALL_PERMISSIONS),
    /reason/i,
    'overriding the limit needs a reason',
  );

  const confirmed = sales.confirmOrder(
    order.id,
    SCOPE,
    { overrideCredit: true, reason: 'Board approved a temporary increase' },
    ALL_PERMISSIONS,
  );
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(confirmed.number, 'confirming allocates the order number');
});

/**
 * T08-09 — the IPC boundary must not eat the match columns.
 *
 * This is the regression test for the defect the end-to-end run found.
 * `validatePayload` copies **declared keys only**, so a field the schema forgets
 * is dropped silently between the renderer and the service: no error, no warning,
 * and a bill that "matches" while accruing nothing. Every unit test above calls
 * the service directly and therefore could never have caught it — the schema was
 * the one link in the chain with no coverage.
 */
test('T08-09 the bill schema keeps the match columns, so a posted bill clears its accrual', async () => {
  await bootstrap();
  const po = makePo(100_000, 1000);

  const beforeReceipt = glBalance('2110');
  const received = receiveAgainst(po, 100_000, 1000);
  assert.equal(glBalance('2110') - beforeReceipt, -100_000, 'the receipt accrues 1000.00');

  const prefill = purchasing.billFromReceipt(received.id);
  assert.equal(prefill.poId, po.id, 'the prefill points at the order');
  assert.equal(prefill.lines[0].poPriceCents, 1000, 'the prefill carries the PO price');

  // Exactly what the renderer sends, through the same validator the dispatcher uses.
  const validated = schemas.validatePayload('finance.bills.save', prefill);
  assert.equal(validated.ok, true, `the schema refused the prefill: ${JSON.stringify(validated.issues)}`);
  const payload = validated.value;
  assert.equal(payload.poId, po.id, 'poId survives validation');
  assert.equal(payload.receiptIds.length, 1, 'the receipt link survives validation');
  assert.equal(payload.lines[0].poPriceCents, 1000, 'poPriceCents survives validation');
  assert.equal(payload.lines[0].receivedQtyMilli, 100_000, 'receivedQtyMilli survives validation');

  const bill = finance.saveBill(payload, SCOPE);
  assert.equal(bill.matchState, 'unchecked', 'a fresh bill has not been matched yet');
  const match = purchasing.billMatch(bill.id);
  assert.equal(match.withinTolerance, true, `expected a pass, got: ${match.reasons.join(' ')}`);
  assert.equal(match.lines[0].billedMilli, 100_000);

  const varianceBefore = glBalance('5020');
  assert.equal(finance.postBill(bill.id, SCOPE).status, 'posted');
  assert.equal(
    glBalance('2110'),
    beforeReceipt,
    'the accrual the receipt raised is cleared to the cent — not left standing next to a price variance',
  );
  assert.equal(glBalance('5020'), varianceBefore, 'a bill at the PO price books no price variance');
});
