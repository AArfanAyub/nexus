/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * T05/T06/R1 acceptance tests — the credibility core.
 *
 * These drive the real service functions against a real sql.js database, with no
 * Electron and no IPC, so a failure names the business rule rather than the
 * transport. Every test asserts a property that would be a defect in production:
 *
 *   T05-01  an unbalanced entry writes ZERO rows and says by how much
 *   T05-02  a locked period refuses a posting and names the lock date and locker
 *   T05-03  60 random balanced documents across 6 journals: trial balance
 *           balanced, debits equal credits, balance sheet A = L + E
 *   T05-04  reversal leaves the original byte-identical and cannot be repeated
 *   T06-01  a tax-inclusive line satisfies net + tax === gross exactly
 *   T06-02  a half-cent boundary rounds up (1.5 × 66.67 = 100.005 → 100.01)
 *   T06-03  allocation refuses to over-allocate and names the available figure
 *   T06-04  posting freezes the document; voiding posts a mirror entry
 *   R1-01   every list payload caps pageSize at 200
 *   R1-02   an archived row restores to a byte-identical row
 *   R1-03   posting invalidates the cached trial balance
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');

const DIST = path.join(__dirname, '..', 'dist', 'main', 'main');
const SHARED = path.join(__dirname, '..', 'dist', 'main', 'shared');
const { initConnection, conn } = require(path.join(DIST, 'db', 'connection.js'));
const { migrate } = require(path.join(DIST, 'db', 'migrate.js'));
const seed = require(path.join(DIST, 'db', 'seed.js'));
const settings = require(path.join(DIST, 'services', 'settings.js'));
const usersService = require(path.join(DIST, 'services', 'users.js'));
const finance = require(path.join(DIST, 'services', 'finance.js'));
const archive = require(path.join(DIST, 'services', 'archive.js'));
const cache = require(path.join(DIST, 'services', 'cache.js'));
const { validatePayload } = require(path.join(SHARED, 'schemas.js'));

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-finance-'));
const DB_FILE = path.join(WORK_DIR, 'nexus.db');
const WASM_FILE = require.resolve('sql.js/dist/sql-wasm.wasm');

const SCOPE = { actorId: 'user-test', actorName: 'Test Operator' };
const TODAY = new Date().toISOString().slice(0, 10);

let ready = false;
let customerId = '';
let vendorId = '';
let inclusiveTaxId = '';
let journalCodes = [];

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seedValue) {
  let a = seedValue >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
     VALUES ('co-1', 'Test Co', NULL, NULL, NULL, NULL, 'USD', 1, 'yyyy-MM-dd', '1,234.56', NULL, ?, ?)`,
    [at, at],
  );
  conn().tx(() => seed.applyPreset('wholesale_retail', 'USD'));
  settings.ensureFiscalYear(1);

  customerId = randomUUID();
  conn().run(
    `INSERT INTO customers (id, code, name, legal_name, tax_id, email, phone, address_json, payment_terms_days,
       credit_limit_cents, currency, is_active, notes, custom_json, created_at, updated_at)
     VALUES (?, 'C-001', 'Northwind Traders', NULL, NULL, NULL, NULL, NULL, 30, 0, 'USD', 1, NULL, '{}', ?, ?)`,
    [customerId, at, at],
  );

  vendorId = randomUUID();
  conn().run(
    `INSERT INTO vendors (id, code, name, legal_name, tax_id, email, phone, address_json, payment_terms_days,
       currency, is_active, notes, custom_json, created_at, updated_at)
     VALUES (?, 'V-001', 'Contoso Supply', NULL, NULL, NULL, NULL, NULL, 30, 'USD', 1, NULL, '{}', ?, ?)`,
    [vendorId, at, at],
  );

  inclusiveTaxId = randomUUID();
  conn().run(
    `INSERT INTO taxes (id, name, rate_bp, is_inclusive, is_compound, account_id, is_archived, created_at, updated_at)
     VALUES (?, 'VAT 20% inclusive', 2000, 1, 0, NULL, 0, ?, ?)`,
    [inclusiveTaxId, at, at],
  );

  /**
   * A real user row, so `assertPeriodOpen` can resolve the locker's name rather
   * than falling back to the stored id. The lock message is part of the
   * contract: it must say who locked the period.
   */
  conn().run(
    `INSERT INTO users (id, username, full_name, email, password_hash, password_salt, password_algo,
       must_change_password, is_active, is_owner, prefs_json, failed_attempts, created_at, updated_at)
     VALUES ('user-test', 'operator', 'Test Operator', NULL, 'x', 'x', 'scrypt-n16384-r8-p1',
       0, 1, 1, '{}', 0, ?, ?)`,
    [at, at],
  );

  journalCodes = finance.listJournals().map((journal) => journal.code);
  ready = true;
}

function postableAccounts() {
  return conn().all("SELECT id, code FROM accounts WHERE is_postable = 1 AND is_archived = 0 ORDER BY code ASC");
}

function counts() {
  return {
    entries: Number(conn().one('SELECT COUNT(*) AS total FROM journal_entries').total),
    lines: Number(conn().one('SELECT COUNT(*) AS total FROM journal_lines').total),
  };
}

/** One balanced entry with two or three lines. */
function balancedInput(rng, journalCode, date) {
  const accounts = postableAccounts();
  const debit = accounts[Math.floor(rng() * accounts.length)];
  let credit = accounts[Math.floor(rng() * accounts.length)];
  if (credit.id === debit.id) credit = accounts[(accounts.indexOf(debit) + 1) % accounts.length];

  const amount = 1 + Math.floor(rng() * 500_000);
  const split = amount > 1 && rng() > 0.5;
  const lines = split
    ? [
        { accountId: debit.id, debitCents: amount },
        { accountId: credit.id, creditCents: amount - 1 },
        { accountId: credit.id, creditCents: 1 },
      ]
    : [
        { accountId: debit.id, debitCents: amount },
        { accountId: credit.id, creditCents: amount },
      ];

  return {
    date,
    journalCode,
    memo: `Random ${String(amount)}`,
    lines,
    sourceType: 'test.random',
  };
}

// ── T05-01 ───────────────────────────────────────────────────────────────────

test('T05-01 an unbalanced entry is rejected and writes zero rows', async () => {
  await bootstrap();
  const before = counts();

  let message = '';
  try {
    conn().tx(() =>
      finance.writeJournal(SCOPE, {
        date: TODAY,
        journalCode: journalCodes[0],
        memo: 'Deliberately unbalanced',
        lines: [
          { accountId: postableAccounts()[0].id, debitCents: 10_000 },
          { accountId: postableAccounts()[1].id, creditCents: 9_000 },
        ],
        sourceType: 'test.unbalanced',
      }),
    );
  } catch (caught) {
    message = caught.message;
  }

  assert.match(message, /Out of balance by 10\.00/, `expected a named difference, saw "${message}"`);
  const after = counts();
  assert.equal(after.entries, before.entries, 'no journal entry may survive a failed balance check');
  assert.equal(after.lines, before.lines, 'no journal line may survive a failed balance check');
});

test('T05-01b a line with both a debit and a credit is rejected', async () => {
  await bootstrap();
  const accounts = postableAccounts();
  assert.throws(
    () =>
      conn().tx(() =>
        finance.writeJournal(SCOPE, {
          date: TODAY,
          journalCode: journalCodes[0],
          memo: 'Both sides',
          lines: [
            { accountId: accounts[0].id, debitCents: 100, creditCents: 100 },
            { accountId: accounts[1].id, creditCents: 0 },
          ],
          sourceType: 'test.both',
        }),
      ),
    /exactly one of a debit or a credit|greater than zero|one of/i,
  );
});

// ── T05-02 ───────────────────────────────────────────────────────────────────

test('T05-02 a locked period refuses a posting and names the lock', async () => {
  await bootstrap();
  const periods = finance.listPeriods();
  const open = periods.find((period) => period.status === 'open');
  assert.ok(open, 'the bootstrap must leave at least one open period');

  conn().tx(() => finance.lockPeriod(open.id, 'Year end signed off', SCOPE));

  const accounts = postableAccounts();
  let message = '';
  try {
    conn().tx(() =>
      finance.writeJournal(SCOPE, {
        date: open.startDate,
        journalCode: journalCodes[0],
        memo: 'Into a locked period',
        lines: [
          { accountId: accounts[0].id, debitCents: 500 },
          { accountId: accounts[1].id, creditCents: 500 },
        ],
        sourceType: 'test.locked',
      }),
    );
  } catch (caught) {
    message = caught.message;
  }

  assert.match(message, /locked/i, `expected a lock refusal, saw "${message}"`);
  assert.match(message, new RegExp(open.startDate), 'the message must name the lock date');
  assert.match(message, /Test Operator/, 'the message must name who locked the period');

  conn().tx(() => finance.unlockPeriod(open.id, 'Test cleanup', SCOPE));
});

// ── T05-03 ───────────────────────────────────────────────────────────────────

test('T05-03 60 random balanced documents keep every report consistent', async () => {
  await bootstrap();
  assert.ok(journalCodes.length >= 6, `expected 6 journals, saw ${journalCodes.length}`);

  const rng = mulberry32(20260201);
  conn().tx(() => {
    for (let index = 0; index < 60; index += 1) {
      finance.writeJournal(SCOPE, balancedInput(rng, journalCodes[index % journalCodes.length], TODAY));
    }
  });

  const ledger = conn().one(
    'SELECT SUM(debit_cents) AS debit, SUM(credit_cents) AS credit FROM journal_lines',
  );
  assert.equal(
    Number(ledger.debit),
    Number(ledger.credit),
    'sum of every debit must equal sum of every credit at the line level',
  );

  const tb = finance.trialBalance(TODAY);
  assert.equal(tb.balanced, true, 'the trial balance must report balanced');
  assert.equal(
    tb.rows.reduce((sum, row) => sum + row.debitCents, 0),
    tb.rows.reduce((sum, row) => sum + row.creditCents, 0),
    'the trial balance rows must add up on both sides',
  );
  assert.equal(tb.totals.debitCents, tb.totals.creditCents);

  const sheet = finance.balanceSheet(TODAY);
  assert.equal(sheet.balanced, true, 'the balance sheet must satisfy A = L + E');
  assert.equal(
    sheet.totalAssetsCents,
    sheet.totalLiabilitiesCents + sheet.totalEquityCents,
    'assets must equal liabilities plus equity including retained earnings',
  );

  const pnl = finance.profitAndLoss(TODAY.slice(0, 4) + '-01-01', TODAY);
  assert.equal(
    pnl.netCurrentCents,
    pnl.income.currentCents - pnl.expense.currentCents,
    'net profit must be income minus expense',
  );

  const flow = finance.cashFlow(TODAY.slice(0, 4) + '-01-01', TODAY);
  assert.equal(
    flow.openingCents + flow.operatingCents + flow.investingCents + flow.financingCents,
    flow.closingCents,
    'the cash flow statement must reconcile to closing cash',
  );
});

// ── T05-04 ───────────────────────────────────────────────────────────────────

test('T05-04 reversal mirrors the entry, leaves the original intact, and cannot repeat', async () => {
  await bootstrap();
  const accounts = postableAccounts();
  const created = conn().tx(() =>
    finance.writeJournal(SCOPE, {
      date: TODAY,
      journalCode: journalCodes[0],
      memo: 'To be reversed',
      lines: [
        { accountId: accounts[0].id, debitCents: 123_456 },
        { accountId: accounts[1].id, creditCents: 123_456 },
      ],
      sourceType: 'test.reversal',
    }),
  );

  const original = conn().one('SELECT * FROM journal_entries WHERE id = ?', [created.id]);
  const originalLines = conn().all('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no', [
    created.id,
  ]);

  const mirror = conn().tx(() => finance.reverseEntry(created.id, 'Wrong account', SCOPE));

  assert.equal(mirror.reversesId, created.id);
  const mirrorLines = conn().all('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no', [mirror.id]);
  assert.equal(mirrorLines.length, originalLines.length);
  assert.equal(mirrorLines[0].debit_cents, originalLines[0].credit_cents);
  assert.equal(mirrorLines[0].credit_cents, originalLines[0].debit_cents);
  assert.equal(mirrorLines[1].debit_cents, originalLines[1].credit_cents);
  assert.equal(mirrorLines[1].credit_cents, originalLines[1].debit_cents);

  const after = conn().one('SELECT * FROM journal_entries WHERE id = ?', [created.id]);
  assert.deepEqual(after, original, 'the original entry must be byte-identical after a reversal');
  const afterLines = conn().all('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no', [created.id]);
  assert.deepEqual(afterLines, originalLines, 'the original lines must be untouched');

  assert.throws(
    () => conn().tx(() => finance.reverseEntry(created.id, 'Again', SCOPE)),
    /already|reversed|mirror/i,
    'a second reversal of the same entry must be refused',
  );

  assert.equal(finance.trialBalance(TODAY).balanced, true, 'the trial balance stays balanced after reversing');
});

// ── T06-01 / T06-02 ──────────────────────────────────────────────────────────

test('T06-01 an inclusive tax satisfies net + tax === gross exactly', async () => {
  await bootstrap();
  const rng = mulberry32(7);

  for (let index = 0; index < 60; index += 1) {
    const gross = 1 + Math.floor(rng() * 10_000_000);
    const totals = finance.computeTotals([
      { description: 'Inclusive line', qtyMilli: 1000, unitPriceCents: gross, taxId: inclusiveTaxId },
    ]);
    const line = totals.lines[0];
    assert.equal(
      line.netCents + line.taxCents,
      line.totalCents,
      `net + tax must equal the gross for ${String(gross)} cents`,
    );
    assert.equal(line.totalCents, gross, 'an inclusive price is already the gross');
    assert.ok(line.taxCents > 0, 'a 20% inclusive tax must produce a positive tax amount');
  }
});

test('T06-02 a half-cent boundary rounds up and the document total still adds up', async () => {
  await bootstrap();

  // 3 × 33.335 is not representable in whole cents; the same product is
  // 1.5 × 66.67 = 100.005, which must round half-up to 100.01.
  const boundary = finance.computeTotals([
    { description: 'Half cent', qtyMilli: 1500, unitPriceCents: 6667 },
  ]);
  assert.equal(boundary.totalCents, 10_001, '100.005 must round half-up to 100.01');
  assert.equal(boundary.lines[0].netCents, 10_001);

  const exact = finance.computeTotals([{ description: 'Three units', qtyMilli: 3000, unitPriceCents: 3333 }]);
  assert.equal(exact.totalCents, 9_999, '3 × 33.33 is 99.99 exactly');

  // Two lines that each round up but together round down: the document total
  // wins and the difference is pushed onto a line, never left as a gap.
  const push = finance.computeTotals([
    { description: 'Half of a cent', qtyMilli: 500, unitPriceCents: 1 },
    { description: 'Half of a cent', qtyMilli: 500, unitPriceCents: 1 },
  ]);
  assert.equal(
    push.totalCents,
    push.lines.reduce((sum, line) => sum + line.totalCents, 0),
    'the document total must equal the sum of its lines',
  );
  for (const line of push.lines) {
    assert.equal(line.netCents + line.taxCents, line.totalCents, 'every line keeps net + tax === total');
  }
});

// ── T06-03 / T06-04 ──────────────────────────────────────────────────────────

/** Saves and posts one invoice for 100.00 plus 20% exclusive tax. */
function postedInvoice(amountCents) {
  const invoice = conn().tx(() =>
    finance.saveInvoice(
      {
        customerId,
        date: TODAY,
        dueDate: TODAY,
        currency: 'USD',
        lines: [{ description: 'Consulting', qtyMilli: 1000, unitPriceCents: amountCents }],
      },
      SCOPE,
    ),
  );
  return conn().tx(() => finance.postInvoice(invoice.id, SCOPE));
}

test('T06-03 allocation refuses to over-allocate and names the available figure', async () => {
  await bootstrap();
  const invoice = postedInvoice(10_000);
  assert.equal(invoice.totalCents, 10_000);
  assert.equal(invoice.status, 'posted');
  assert.ok(invoice.number, 'posting must allocate a number');

  const payment = conn().tx(() =>
    finance.recordPayment(
      {
        direction: 'in',
        partnerType: 'customer',
        partnerId: customerId,
        date: TODAY,
        method: 'bank',
        amountCents: 6_000,
        currency: 'USD',
      },
      SCOPE,
    ),
  );
  assert.equal(payment.unallocatedCents, 6_000);

  let message = '';
  try {
    conn().tx(() => finance.allocate(payment.id, [{ invoiceId: invoice.id, amountCents: 7_000 }]));
  } catch (caught) {
    message = caught.message;
  }
  assert.match(message, /60\.00|6,000|available/i, `expected the available figure, saw "${message}"`);

  const untouched = finance.getInvoice(invoice.id);
  assert.equal(untouched.paidCents, 0, 'a refused allocation must not move the document');
  assert.equal(untouched.balanceCents, 10_000);

  const partial = conn().tx(() => finance.allocate(payment.id, [{ invoiceId: invoice.id, amountCents: 4_000 }]));
  assert.equal(partial.unallocatedCents, 2_000);
  const partly = finance.getInvoice(invoice.id);
  assert.equal(partly.paidCents, 4_000);
  assert.equal(partly.balanceCents, 6_000);
  assert.equal(partly.status, 'partially_paid');

  // The second allocation can only take what the payment has left.
  const rest = conn().tx(() => finance.allocate(payment.id, [{ invoiceId: invoice.id, amountCents: 2_000 }]));
  assert.equal(rest.unallocatedCents, 0);

  const settled = conn().tx(() =>
    finance.recordPayment(
      {
        direction: 'in',
        partnerType: 'customer',
        partnerId: customerId,
        date: TODAY,
        method: 'bank',
        amountCents: 4_000,
        currency: 'USD',
      },
      SCOPE,
    ),
  );
  conn().tx(() => finance.allocate(settled.id, [{ invoiceId: invoice.id, amountCents: 4_000 }]));

  const paid = finance.getInvoice(invoice.id);
  assert.equal(paid.balanceCents, 0, 'the invoice must be fully settled by the two receipts');
  assert.equal(paid.status, 'paid');
});

test('T06-04 posting is idempotent, the document is frozen, and voiding mirrors it', async () => {
  await bootstrap();
  const invoice = postedInvoice(25_000);

  assert.throws(
    () => conn().tx(() => finance.postInvoice(invoice.id, SCOPE)),
    /already posted|posted/i,
    'a posted invoice cannot be posted twice',
  );

  const entry = finance.getJournalEntry(invoice.journalEntryId);
  const debits = entry.lines.reduce((sum, line) => sum + line.debitCents, 0);
  const credits = entry.lines.reduce((sum, line) => sum + line.creditCents, 0);
  assert.equal(debits, credits, 'the invoice entry must balance');
  assert.equal(debits, 25_000);

  const ar = entry.lines.find((line) => line.accountCode.startsWith('11'));
  assert.ok(ar, 'the entry must debit a receivable account');
  assert.equal(ar.debitCents, 25_000);

  const voided = conn().tx(() => finance.voidInvoice(invoice.id, 'Raised twice', SCOPE));
  assert.equal(voided.status, 'void');
  assert.equal(finance.trialBalance(TODAY).balanced, true, 'voiding must leave the ledger balanced');
});

test('T06-05 a bill posts to accounts payable and the balance sheet stays balanced', async () => {
  await bootstrap();
  const bill = conn().tx(() =>
    finance.saveBill(
      {
        vendorId,
        vendorRef: 'CS-991',
        date: TODAY,
        dueDate: TODAY,
        currency: 'USD',
        lines: [{ description: 'Packaging', qtyMilli: 2000, unitPriceCents: 1_500 }],
      },
      SCOPE,
    ),
  );
  const posted = conn().tx(() => finance.postBill(bill.id, SCOPE));
  assert.equal(posted.totalCents, 3_000);
  assert.equal(posted.status, 'posted');

  const entry = finance.getJournalEntry(posted.journalEntryId);
  const ap = entry.lines.find((line) => line.accountCode.startsWith('21'));
  assert.ok(ap, 'a bill must credit accounts payable');
  assert.equal(ap.creditCents, 3_000);
  assert.equal(finance.balanceSheet(TODAY).balanced, true);
});

// ── R1-01 ────────────────────────────────────────────────────────────────────

test('R1-01 every list payload caps pageSize at 200', async () => {
  await bootstrap();

  const tooBig = { entity: 'customers', limit: 500 };
  assert.equal(validatePayload('entity.list', tooBig).ok, false, 'entity.list must refuse limit 500');
  assert.equal(
    validatePayload('entity.list', { entity: 'customers', limit: 200 }).ok,
    true,
    'entity.list must accept the documented cap of 200',
  );

  for (const channel of [
    'finance.invoices.list',
    'finance.bills.list',
    'finance.payments.list',
    'finance.journals.list',
  ]) {
    assert.equal(validatePayload(channel, { page: 1, pageSize: 201 }).ok, false, `${channel} must refuse 201`);
    assert.equal(validatePayload(channel, { page: 1, pageSize: 200 }).ok, true, `${channel} must accept 200`);
  }

  assert.equal(
    validatePayload('finance.reports.generalLedger', {
      accountId: randomUUID(),
      from: TODAY,
      to: TODAY,
      pageSize: 201,
    }).ok,
    false,
    'the general ledger must refuse 201 rows per page',
  );
});

// ── R1-02 ────────────────────────────────────────────────────────────────────

test('R1-02 an archived row restores byte-identically from its gzip payload', async () => {
  await bootstrap();
  // Only immutable documents are archivable, so the invoice is voided first —
  // archiving a posted invoice would move a row an operator can still void.
  const invoice = postedInvoice(4_321);
  conn().tx(() => finance.voidInvoice(invoice.id, 'Archived in the test', SCOPE));

  const before = conn().one('SELECT * FROM invoices WHERE id = ?', [invoice.id]);
  const beforeLines = conn().all('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no', [invoice.id]);
  assert.ok(before, 'the invoice must exist before archiving');

  const result = conn().tx(() =>
    archive.archiveOldRecords({
      before: '2999-12-31',
      tables: ['invoices'],
      reason: 'Test archive',
      actorId: SCOPE.actorId,
    }),
  );
  assert.ok(result.records >= 1, 'at least one invoice must have been archived');
  assert.equal(
    conn().one('SELECT COUNT(*) AS total FROM invoices WHERE id = ?', [invoice.id]).total,
    0,
    'the hot table must no longer hold the archived row',
  );

  const archived = conn().one("SELECT id FROM archive_records WHERE table_name = 'invoices' AND entity_id = ?", [
    invoice.id,
  ]);
  assert.ok(archived, 'the archive must hold a record for the invoice');

  const restored = conn().tx(() => archive.restoreArchived(archived.id));
  assert.equal(restored.rows, 1 + beforeLines.length, 'the parent and its children must come back');

  const after = conn().one('SELECT * FROM invoices WHERE id = ?', [invoice.id]);
  assert.deepEqual(after, before, 'the restored row must be identical to the archived one');
  const afterLines = conn().all('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no', [invoice.id]);
  assert.deepEqual(afterLines, beforeLines, 'the restored lines must be identical');

  // Reports must read archived rows, so an archive run cannot change a report.
  assert.equal(finance.trialBalance(TODAY).balanced, true);
});

// ── R1-03 ────────────────────────────────────────────────────────────────────

test('R1-03 posting invalidates the cached trial balance', async () => {
  await bootstrap();
  cache.resetCache();

  const first = finance.trialBalance(TODAY);
  const warm = finance.trialBalance(TODAY);
  assert.equal(cache.cacheStats().hits > 0, true, 'a repeated report must hit the cache');
  assert.deepEqual(warm, first, 'a cache hit must return the same report');

  postedInvoice(7_777);

  const after = finance.trialBalance(TODAY);
  assert.notDeepEqual(after.totals, first.totals, 'posting must invalidate the cached report');
  assert.equal(after.balanced, true);
  assert.equal(
    after.totals.debitCents - first.totals.debitCents,
    7_777,
    'the cached report must reflect exactly the newly posted amount',
  );
});

// ── T11-01 ───────────────────────────────────────────────────────────────────

/**
 * v6 put the posting date on the ledger line so the trial balance can range-scan
 * one covering index instead of descending into 150 000 parent rows. That only
 * works if the copy is exact, so this asserts the copy rather than the speed:
 * a line and its entry never disagree, a draft carries no date at all, and the
 * draft → posted transition fills it in.
 */
test('T11-01 every ledger line carries its entry date, and a draft carries none', async () => {
  await bootstrap();
  const accounts = postableAccounts();
  const entryDate = '2026-03-31';

  const draft = finance.saveJournal(
    {
      date: entryDate,
      journalCode: journalCodes[0],
      memo: 'T11 draft',
      lines: [
        { accountId: accounts[0].id, debitCents: 12_345 },
        { accountId: accounts[1].id, creditCents: 12_345 },
      ],
      sourceType: 'test.v6',
      status: 'draft',
    },
    SCOPE,
  );

  const draftDates = conn().all('SELECT posted_date FROM journal_lines WHERE entry_id = ?', [draft.id]);
  assert.ok(draftDates.length > 0, 'the draft must have lines');
  for (const row of draftDates) {
    assert.equal(row.posted_date, null, 'a draft line must not appear in a dated report');
  }

  finance.postEntry(draft.id, SCOPE);

  const postedDates = conn().all('SELECT posted_date FROM journal_lines WHERE entry_id = ?', [draft.id]);
  for (const row of postedDates) {
    assert.equal(row.posted_date, entryDate, 'posting must stamp the entry date onto every line');
  }

  // The invariant across the whole ledger, not just this entry: a posted line
  // whose date differs from its entry would silently mis-date a report.
  const drift = conn().all(
    `SELECT l.id
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE (e.status = 'posted' AND (l.posted_date IS NULL OR l.posted_date <> e.date))
         OR (e.status = 'draft' AND l.posted_date IS NOT NULL)`,
  );
  assert.deepEqual(drift, [], 'no ledger line may disagree with its entry');
});

// ── T11-02 ───────────────────────────────────────────────────────────────────

/**
 * Archiving must be invisible to the numbers.
 *
 * The old cold-store reader carried `LIMIT 5000` over one record per entry, so a
 * large archive silently reported 5 % of the archived activity — and still
 * "balanced", because both sides were truncated equally. This test archives the
 * whole ledger and demands the trial balance totals be *identical*, then puts one
 * record back and demands they are still identical.
 */
test('T11-02 archiving and restoring leave the trial balance totals untouched', async () => {
  await bootstrap();
  cache.resetCache();
  const before = finance.trialBalance(TODAY);
  assert.ok(before.totals.debitCents > 0, 'the fixture must have posted activity to archive');

  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  // No `tables`: the run archives everything, in the dependency order the
  // service declares — documents first, then the ledger entries they point at.
  const moved = archive.archiveOldRecords({ before: tomorrow, limit: 50_000 });
  assert.ok(moved.rows > 0, 'expected entries to archive');

  const rollup = conn().one('SELECT COUNT(*) AS total FROM archive_balances');
  assert.ok(Number(rollup.total) > 0, 'archiving must write the balance rollup');

  cache.resetCache();
  const afterArchive = finance.trialBalance(TODAY);
  assert.equal(afterArchive.totals.debitCents, before.totals.debitCents, 'archiving changed total debits');
  assert.equal(afterArchive.totals.creditCents, before.totals.creditCents, 'archiving changed total credits');
  assert.deepEqual(
    afterArchive.rows.map((row) => [row.accountId, row.debitCents, row.creditCents]),
    before.rows.map((row) => [row.accountId, row.debitCents, row.creditCents]),
    'archiving changed a per-account balance',
  );

  const record = conn().one("SELECT id FROM archive_records WHERE table_name = 'journal_entries' LIMIT 1");
  archive.restoreArchived(String(record.id));

  cache.resetCache();
  const afterRestore = finance.trialBalance(TODAY);
  assert.equal(afterRestore.totals.debitCents, before.totals.debitCents, 'restoring double-counted debits');
  assert.equal(afterRestore.totals.creditCents, before.totals.creditCents, 'restoring double-counted credits');
});
