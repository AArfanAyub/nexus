/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * End-to-end operations driver (development only, never shipped).
 *
 * Walks the purchasing and sales chains over the real bridge:
 *
 *   onboarding → sign in → product, warehouse, location, customer, vendor →
 *   PO for 100 → receive 40 → bill it (three-way match) → sell 10 →
 *   deliver 10 → invoice what was delivered → reconcile
 *
 * The last step is the one that matters: the inventory control account on the
 * trial balance must equal the valuation report to the cent. If a receipt posted
 * to the wrong account, or COGS used a different cost than the valuation did,
 * this is where it shows.
 *
 * Usage:
 *   npx electron . --remote-debugging-port=9223 --user-data-dir=/tmp/nexus-ops
 *   node scripts/e2e-ops.mjs
 */

import process from 'node:process';

const PORT = Number(process.env.NEXUS_CDP_PORT ?? 9223);
const ENDPOINT = `http://127.0.0.1:${PORT}/json/list`;
const DEADLINE_MS = 90_000;

const ADMIN = { username: 'owner', password: 'Quiet-Harbor-92x' };

const ONBOARDING = {
  company: { name: 'Northwind Supply', legalName: 'Northwind Supply LLC', taxId: '27AAPFU0939F1ZV' },
  presetId: 'wholesale_retail',
  currency: 'USD',
  fiscalStartMonth: 1,
  admin: { username: ADMIN.username, fullName: 'Ada Owner', email: 'owner@northwind.test', password: ADMIN.password },
  loadDemo: false,
};

const today = new Date().toISOString().slice(0, 10);
const steps = [];

function note(step, detail) {
  steps.push({ step, detail });
  console.log(`  \u2713 ${step}${detail === undefined ? '' : ` \u2014 ${detail}`}`);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function findPage() {
  const started = Date.now();
  while (Date.now() - started < DEADLINE_MS) {
    try {
      const response = await fetch(ENDPOINT);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // The debugger port is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no renderer page appeared on port ${PORT} within ${DEADLINE_MS} ms`);
}

function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  return {
    async send(method, params = {}) {
      await opened;
      nextId += 1;
      const id = nextId;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`renderer threw: ${text}`);
  }
  return result.result.value;
}

/** Invokes a channel and throws on refusal, so every step asserts. */
async function invoke(client, channel, payload = {}) {
  const result = await evaluate(
    client,
    `window.nexus.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`,
  );
  if (!result || !result.ok) {
    throw new Error(`${channel} refused: ${JSON.stringify(result?.error ?? result)}`);
  }
  return result.data;
}


async function main() {
  const page = await findPage();
  const client = connect(page.webSocketDebuggerUrl);

  try {
    // ── 0. a working company ────────────────────────────────────────────────
    const status = await invoke(client, 'onboarding.status');
    if (!status.complete) {
      await invoke(client, 'onboarding.complete', ONBOARDING);
      note('onboarding.complete', 'company, chart of accounts, 12 periods');
    } else {
      note('onboarding.status', 'already set up');
    }
    await invoke(client, 'auth.login', ADMIN);
    note('auth.login', ADMIN.username);

    // ── 1. the master data the chains need ──────────────────────────────────
    const warehouse = await invoke(client, 'entity.save', {
      entity: 'warehouses',
      values: { code: 'WH1', name: 'Main warehouse', is_active: 1 },
    });
    const location = await invoke(client, 'entity.save', {
      entity: 'locations',
      values: { warehouse_id: warehouse.id, code: 'A1', name: 'Aisle 1', is_active: 1 },
    });
    const product = await invoke(client, 'entity.save', {
      entity: 'products',
      values: {
        sku: 'WIDGET-1',
        name: 'Widget',
        uom: 'unit',
        cost_method: 'avco',
        base_price_cents: 3000,
        standard_cost_cents: 1000,
        reorder_point_milli: 20000,
        is_stock_tracked: 1,
        is_active: 1,
      },
    });
    const customer = await invoke(client, 'entity.save', {
      entity: 'customers',
      values: { code: 'C-1', name: 'Acme Retail', payment_terms_days: 30, credit_limit_cents: 0, currency: 'USD', is_active: 1 },
    });
    const vendor = await invoke(client, 'entity.save', {
      entity: 'vendors',
      values: { code: 'V-1', name: 'Contoso Supply', payment_terms_days: 30, currency: 'USD', is_active: 1 },
    });
    note('masters', `${warehouse.code} / ${location.code} / ${product.sku}`);

    // ── 2. purchase order for 100, confirmed ────────────────────────────────
    const po = await invoke(client, 'purchasing.po.save', {
      vendorId: vendor.id,
      date: today,
      expectedDate: today,
      warehouseId: warehouse.id,
      lines: [{ productId: product.id, description: 'Widget', qtyMilli: 100_000, unitPriceCents: 1000 }],
    });
    const confirmed = await invoke(client, 'purchasing.po.confirm', { id: po.id });
    check(confirmed.status === 'confirmed', `expected a confirmed PO, got ${confirmed.status}`);
    check(confirmed.number !== null, 'confirming must allocate an order number');
    note('purchasing.po.confirm', confirmed.number);

    // ── 3. receive 40 of 100 ────────────────────────────────────────────────
    const receiptDraft = await invoke(client, 'purchasing.receipt.create', {
      poId: po.id,
      vendorId: vendor.id,
      date: today,
      warehouseId: warehouse.id,
      locationId: location.id,
      lines: [{ poLineId: confirmed.lines[0].id, productId: product.id, qtyMilli: 40_000, unitCostCents: 1000 }],
    });
    const receipt = await invoke(client, 'purchasing.receipt.post', { id: receiptDraft.id });
    check(receipt.status === 'posted', 'the receipt must post');

    const afterPartial = await invoke(client, 'purchasing.po.get', { id: po.id });
    check(afterPartial.status === 'partially_received', `expected partially_received, got ${afterPartial.status}`);
    check(afterPartial.lines[0].receivedMilli === 40_000, '40 received');
    check(afterPartial.lines[0].remainingMilli === 60_000, '60 outstanding');
    note('receipt 40/100', `${afterPartial.status}, 60 outstanding`);

    const onHand = await invoke(client, 'inventory.stock.onHand', { productId: product.id });
    check(onHand.qtyMilli === 40_000, `expected 40 on hand, got ${onHand.qtyMilli}`);
    note('stock', `${onHand.qtyMilli / 1000} on hand`);

    // ── 4. bill the receipt: three-way match inside tolerance ───────────────
    const prefill = await invoke(client, 'purchasing.bill.fromReceipt', { id: receipt.id });
    const bill = await invoke(client, 'finance.bills.save', prefill);
    const match = await invoke(client, 'finance.bills.match', { id: bill.id });
    check(match.withinTolerance === true, `the match should pass: ${match.reasons.join(' ')}`);
    check(match.lines[0].billedMilli === 40_000, 'the bill bills what was received');
    const postedBill = await invoke(client, 'finance.bills.post', { id: bill.id });
    check(postedBill.status === 'posted', 'the bill must post');
    note('3-way match', `${postedBill.number}, cleared ${match.lines[0].receivedMilli / 1000} received`);

    // ── 5. sell 10, deliver 10 ──────────────────────────────────────────────
    const order = await invoke(client, 'sales.order.save', {
      customerId: customer.id,
      date: today,
      warehouseId: warehouse.id,
      lines: [{ productId: product.id, description: 'Widget', qtyMilli: 10_000, unitPriceCents: 3000 }],
    });
    const confirmedOrder = await invoke(client, 'sales.order.confirm', { id: order.id });
    check(confirmedOrder.status === 'confirmed', 'the order must confirm');

    const soLine = confirmedOrder.lines[0];
    const deliveryDraft = await invoke(client, 'sales.delivery.create', {
      orderId: order.id,
      customerId: customer.id,
      date: today,
      warehouseId: warehouse.id,
      lines: [{ soLineId: soLine.id, productId: product.id, qtyMilli: 10_000 }],
    });
    const delivery = await invoke(client, 'sales.delivery.post', { id: deliveryDraft.id });
    check(delivery.status === 'posted', 'the delivery must post');

    const afterDelivery = await invoke(client, 'sales.order.get', { id: order.id });
    check(afterDelivery.status === 'delivered', `expected delivered, got ${afterDelivery.status}`);
    const stockAfter = await invoke(client, 'inventory.stock.onHand', { productId: product.id });
    check(stockAfter.qtyMilli === 30_000, `expected 30 on hand, got ${stockAfter.qtyMilli}`);
    note('delivery', `${stockAfter.qtyMilli / 1000} left after delivering 10`);

    // ── 6. invoice the delivered quantity only ──────────────────────────────
    const invoicePrefill = await invoke(client, 'sales.order.invoice', { id: order.id });
    check(invoicePrefill.lines.length === 1, 'one billable line');
    check(invoicePrefill.lines[0].qtyMilli === 10_000, 'only the delivered quantity is billable');
    const invoice = await invoke(client, 'finance.invoices.save', invoicePrefill);
    const postedInvoice = await invoke(client, 'finance.invoices.post', { id: invoice.id });
    check(postedInvoice.status === 'posted', 'the invoice must post');
    await invoke(client, 'sales.order.markInvoiced', {
      orderId: order.id,
      invoiceId: postedInvoice.id,
      lines: [{ productId: product.id, qtyMilli: 10_000 }],
    });
    const afterInvoice = await invoke(client, 'sales.order.get', { id: order.id });
    check(afterInvoice.status === 'invoiced', `expected invoiced, got ${afterInvoice.status}`);
    note('invoice', `${postedInvoice.number} for 10 delivered`);

    // ── 7. the reconciliation that proves the whole chain ───────────────────
    const valuation = await invoke(client, 'inventory.valuation', {});
    const trial = await invoke(client, 'finance.reports.trialBalance', { asOf: today });
    check(trial.balanced === true, 'the trial balance must still balance');

    const inventoryAccount = trial.rows.find((row) => row.code === '1210') ?? trial.rows.find((row) => row.code === '1200');
    check(inventoryAccount, 'the chart must have an inventory account');
    check(
      inventoryAccount.balanceCents === valuation.totalValueCents,
      `inventory GL ${inventoryAccount.balanceCents} must equal valuation ${valuation.totalValueCents}`,
    );
    note(
      'reconcile',
      `GL ${(inventoryAccount.balanceCents / 100).toFixed(2)} = valuation ${(valuation.totalValueCents / 100).toFixed(2)}`,
    );

    // COGS must equal what the delivery released, and the accrual must be clear.
    const cogs = trial.rows.find((row) => row.code === '5010');
    check(cogs && cogs.balanceCents === 10_000, `COGS should be 100.00, got ${cogs?.balanceCents}`);
    /*
     * The accrual is raised by the *receipt*, not by the order: 40 units landed,
     * so GRNI was credited 400.00, and the bill then debited it back. The 60 units
     * still on order were never received and so were never accrued. Everything
     * that was received has been billed, which leaves GRNI at exactly zero — a
     * non-zero balance here means a receipt or a bill posted its half twice.
     */
    const grni = trial.rows.find((row) => row.code === '2110');
    check(
      (grni?.balanceCents ?? 0) === 0,
      `GRNI must be clear once every receipt is billed, got ${grni?.balanceCents ?? 0}`,
    );
    note('cogs + accrual', `COGS ${(cogs.balanceCents / 100).toFixed(2)}, GRNI ${((grni?.balanceCents ?? 0) / 100).toFixed(2)}`);

    console.log(`\nE2E OPS PASSED — ${steps.length} steps`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`\nE2E OPS FAILED — ${error.message}`);
  process.exitCode = 1;
});
