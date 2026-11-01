/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * End-to-end finance driver (development only, never shipped).
 *
 * Drives the real application over CDP — preload bridge → IPC dispatcher →
 * services → sql.js — and walks the exact path a finance user walks:
 *
 *   onboarding → sign in → create an invoice → post it → read the ledger and the
 *   trial balance → take a partial payment → check the status and the balance →
 *   reverse the entry → confirm the trial balance is still balanced
 *
 * Every step asserts, so a failure names the step rather than "something broke".
 *
 * Usage:
 *   npx electron . --remote-debugging-port=9223
 *   node scripts/e2e-finance.mjs
 */

import process from 'node:process';

const PORT = Number(process.env.NEXUS_CDP_PORT ?? 9223);
const ENDPOINT = `http://127.0.0.1:${PORT}/json/list`;
const DEADLINE_MS = 90_000;

const ADMIN = { username: 'owner', password: 'Quiet-Harbor-92x' };

const ONBOARDING = {
  company: { name: 'Northwind Trading', legalName: 'Northwind Trading LLC', taxId: '27AAPFU0939F1ZV' },
  presetId: 'wholesale_retail',
  currency: process.env.NEXUS_E2E_CURRENCY ?? 'MYR',
  fiscalStartMonth: 1,
  admin: { username: ADMIN.username, fullName: 'Ada Owner', email: 'owner@northwind.test', password: ADMIN.password },
  loadDemo: false,
};

const today = new Date().toISOString().slice(0, 10);
const steps = [];

function note(step, detail) {
  steps.push({ step, detail });
  console.log(`  ✓ ${step}${detail === undefined ? '' : ` — ${detail}`}`);
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
      note('onboarding.complete', 'seeded a company, a chart of accounts and 12 periods');
    } else {
      note('onboarding.status', 'already set up');
    }

    const session = await invoke(client, 'auth.session');
    if (!session.user) {
      await invoke(client, 'auth.login', ADMIN);
      note('auth.login', ADMIN.username);
    } else {
      note('auth.session', session.user.username);
    }

    // ── 1. a customer to invoice ────────────────────────────────────────────
    let customers = await invoke(client, 'entity.list', { entity: 'customers', limit: 1 });
    if (customers.total === 0) {
      await invoke(client, 'entity.save', {
        entity: 'customers',
        values: { name: 'Northwind Traders', code: 'C-001', is_active: 1, currency: 'USD' },
      });
      customers = await invoke(client, 'entity.list', { entity: 'customers', limit: 1 });
    }
    check(customers.total >= 1, 'a customer must exist before invoicing');
    const customerId = customers.rows[0].id;
    note('entity.list customers', `${String(customers.total)} available`);

    // ── 2. create and post an invoice ───────────────────────────────────────
    const invoice = await invoke(client, 'finance.invoices.save', {
      customerId,
      date: today,
      dueDate: today,
      currency: 'USD',
      lines: [{ description: 'Consulting — 10 days', qtyMilli: 10_000, unitPriceCents: 25_000 }],
    });
    check(invoice.totalCents === 250_000, `expected a 2500.00 total, saw ${String(invoice.totalCents)}`);
    check(invoice.status === 'draft', 'a saved invoice must start as a draft');
    note('finance.invoices.save', `draft ${String(invoice.totalCents)} cents`);

    const posted = await invoke(client, 'finance.invoices.post', { id: invoice.id });
    check(posted.status === 'posted', 'posting must set the status to posted');
    check(Boolean(posted.number), 'posting must allocate a number');
    note('finance.invoices.post', posted.number);

    // ── 3. the ledger and the trial balance ─────────────────────────────────
    const entry = await invoke(client, 'finance.journals.get', { id: posted.journalEntryId });
    const debits = entry.lines.reduce((sum, line) => sum + line.debitCents, 0);
    const credits = entry.lines.reduce((sum, line) => sum + line.creditCents, 0);
    check(debits === credits, `the entry must balance: ${String(debits)} vs ${String(credits)}`);
    check(debits === 250_000, 'the entry must equal the invoice total');
    note('finance.journals.get', `${String(entry.lines.length)} lines, balanced at ${String(debits)}`);

    const receivable = entry.lines.find((line) => line.accountCode.startsWith('11'));
    check(receivable && receivable.debitCents === 250_000, 'the entry must debit trade receivables');
    note('ledger', `Dr ${receivable.accountCode} ${receivable.accountName}`);

    const tbBefore = await invoke(client, 'finance.reports.trialBalance', { asOf: today });
    check(tbBefore.balanced, 'the trial balance must be balanced after posting');
    const gl = await invoke(client, 'finance.reports.generalLedger', {
      accountId: receivable.accountId,
      from: `${today.slice(0, 4)}-01-01`,
      to: today,
    });
    check(gl.rows.length >= 1, 'the general ledger must show the posting');
    note('finance.reports.trialBalance', `balanced, ${String(tbBefore.rows.length)} accounts`);

    // ── 4. a partial payment ────────────────────────────────────────────────
    const payment = await invoke(client, 'finance.payments.create', {
      direction: 'in',
      partnerType: 'customer',
      partnerId: customerId,
      date: today,
      method: 'bank',
      reference: 'E2E-001',
      amountCents: 100_000,
      currency: 'USD',
    });
    check(payment.unallocatedCents === 100_000, 'a new payment starts fully unallocated');
    await invoke(client, 'finance.payments.allocate', {
      id: payment.id,
      allocations: [{ invoiceId: posted.id, amountCents: 100_000 }],
    });
    note('finance.payments.allocate', '1000.00 of 2500.00');

    const partly = await invoke(client, 'finance.invoices.get', { id: posted.id });
    check(partly.paidCents === 100_000, `expected 1000.00 paid, saw ${String(partly.paidCents)}`);
    check(partly.balanceCents === 150_000, `expected 1500.00 open, saw ${String(partly.balanceCents)}`);
    check(partly.status === 'partially_paid', `expected partially_paid, saw ${partly.status}`);
    note('finance.invoices.get', `${partly.status}, ${String(partly.balanceCents)} open`);

    // ── 5. over-allocation is refused, not clamped ──────────────────────────
    const over = await evaluate(
      client,
      `window.nexus.invoke('finance.payments.allocate', ${JSON.stringify({
        id: payment.id,
        allocations: [{ invoiceId: posted.id, amountCents: 1 }],
      })})`,
    );
    check(over.ok === false, 'allocating more than the payment holds must be refused');
    note('finance.payments.allocate (over)', over.error.message.slice(0, 72));

    // ── 6. reverse the entry, and the ledger still balances ─────────────────
    const mirror = await invoke(client, 'finance.journals.reverse', {
      id: posted.journalEntryId,
      reason: 'End-to-end check',
    });
    check(mirror.reversesId === posted.journalEntryId, 'the reversal must point at the original');
    check(
      mirror.lines[0].debitCents === entry.lines[0].creditCents,
      'the reversal must swap the debit and the credit',
    );
    note('finance.journals.reverse', mirror.number ?? 'mirror entry');

    const original = await invoke(client, 'finance.journals.get', { id: posted.journalEntryId });
    check(original.lines[0].debitCents === 250_000, 'the original entry must be untouched');

    const tbAfter = await invoke(client, 'finance.reports.trialBalance', { asOf: today });
    check(tbAfter.balanced, 'the trial balance must still be balanced after a reversal');
    note('finance.reports.trialBalance', `balanced after reversal, ${String(tbAfter.rows.length)} accounts`);

    // ── 7. the printable document renders ───────────────────────────────────
    const preview = await invoke(client, 'documents.pdf.preview', { docType: 'invoice', id: posted.id });
    check(typeof preview.html === 'string' && preview.html.includes('doc-preview'), 'the preview must render');
    check(preview.html.includes(posted.number), 'the preview must carry the invoice number');
    note('documents.pdf.preview', `${String(preview.html.length)} bytes of A4 markup`);

    // ── 8. reports are consistent with each other ───────────────────────────
    const sheet = await invoke(client, 'finance.reports.balanceSheet', { asOf: today });
    check(sheet.balanced, 'the balance sheet must satisfy A = L + E');
    const pnl = await invoke(client, 'finance.reports.pnl', { from: `${today.slice(0, 4)}-01-01`, to: today });
    check(
      pnl.netCurrentCents === pnl.income.currentCents - pnl.expense.currentCents,
      'net profit must equal income minus expense',
    );
    const flow = await invoke(client, 'finance.reports.cashFlow', { from: `${today.slice(0, 4)}-01-01`, to: today });
    check(
      flow.openingCents + flow.operatingCents + flow.investingCents + flow.financingCents === flow.closingCents,
      'the cash flow statement must reconcile to closing cash',
    );
    note('reports', 'balance sheet, P&L and cash flow all agree');

    console.log(`\nE2E PASSED — ${String(steps.length)} steps`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`\nE2E FAILED: ${error.message}`);
  process.exitCode = 1;
});
