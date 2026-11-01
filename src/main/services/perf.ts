/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The scale harness (requirement R1).
 *
 * Two functions and no more: one that can build a 10k-customer / 10k-product
 * dataset quickly enough to be usable, and one that measures the queries that
 * matter. Both are owner-only channels (`settings.perf.*`) and neither runs on
 * its own.
 *
 * Everything is deterministic — the same `seed` produces the same dataset — so a
 * benchmark number can be reproduced and a regression can be bisected.
 */

import { randomUUID } from 'node:crypto';

import { addDays, nowIso, todayIso } from '../../shared/dates';
import { conn } from '../db/connection';
import { conflict } from '../errors';
import { archiveOldRecords, restoreArchived } from './archive';
import { trialBalance } from './finance.reports';
import { invalidateCache } from './cache';
import { searchGlobal } from './search';

/** mulberry32 — 4 lines, deterministic, good enough for fixtures. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface PerfInput {
  readonly customers?: number;
  readonly products?: number;
  readonly invoices?: number;
  /**
   * Extra balanced two-line journals, on top of the two lines each invoice posts.
   *
   * A real company's ledger is mostly not invoices — payroll, rent, accruals — and
   * the trial balance budget is stated in *journal lines*, so a dataset that only
   * has invoices cannot be measured against it. 50 000 of these alongside 100 000
   * invoices puts the ledger at 300 000 lines.
   */
  readonly journals?: number;
  readonly seed?: number;
}

export interface PerfResult {
  readonly customers: number;
  readonly products: number;
  readonly invoices: number;
  readonly journalLines: number;
  readonly ms: number;
}

const FIRST_NAMES = ['Ada', 'Grace', 'Alan', 'Edsger', 'Barbara', 'Ken', 'Donald', 'Margaret'];
const LAST_NAMES = ['Lovelace', 'Hopper', 'Turing', 'Dijkstra', 'Liskov', 'Thompson', 'Knuth', 'Hamilton'];
const CITIES = ['Springfield', 'Shelbyville', 'Ogdenville', 'North Haverbrook', 'Capital City'];
const NOUNS = ['Widget', 'Bracket', 'Housing', 'Coupler', 'Bearing', 'Gasket', 'Bushing', 'Flange'];

/**
 * Builds a synthetic dataset. One transaction, batches of 500 rows, so a
 * 10k/10k/10k run takes seconds rather than minutes and cannot leave a half-built
 * company behind if it fails.
 */
export function generatePerfDataset(input: PerfInput = {}): PerfResult {
  const customers = Math.min(Math.max(Math.trunc(input.customers ?? 1000), 0), 20_000);
  const products = Math.min(Math.max(Math.trunc(input.products ?? 1000), 0), 20_000);
  const invoices = Math.min(Math.max(Math.trunc(input.invoices ?? 1000), 0), 100_000);
  const journals = Math.min(Math.max(Math.trunc(input.journals ?? 0), 0), 100_000);
  const random = prng(input.seed ?? 20_261_031);
  const started = Date.now();
  const at = nowIso();
  const today = todayIso();

  const company = conn().one<{ base_currency: string }>('SELECT base_currency FROM companies LIMIT 1');
  if (!company) throw conflict('Set up the company before generating a performance dataset.');
  const currency = company.base_currency;

  const period = conn().one<{ id: string }>('SELECT id FROM periods ORDER BY start_date LIMIT 1');
  if (!period) throw conflict('No accounting period exists yet.');
  const journal = conn().one<{ id: string }>('SELECT id FROM journals WHERE code = ?', ['SAL']);
  const ar = conn().one<{ id: string }>('SELECT id FROM accounts WHERE code = ?', ['1100']);
  const revenue = conn().one<{ id: string }>('SELECT id FROM accounts WHERE code = ?', ['4010']);
  if (!journal || !ar || !revenue) throw conflict('The chart of accounts is incomplete — apply a preset first.');

  // The extra journals are accruals: cost in, liability up. Both accounts are
  // found by type rather than by code, because a preset may number them
  // differently and a perf harness that only works for one preset is a trap.
  const expense = conn().one<{ id: string }>(
    "SELECT id FROM accounts WHERE type = 'expense' AND is_postable = 1 AND deleted_at IS NULL ORDER BY code LIMIT 1",
  );
  const liability = conn().one<{ id: string }>(
    "SELECT id FROM accounts WHERE type = 'liability' AND is_postable = 1 AND deleted_at IS NULL ORDER BY code LIMIT 1",
  );
  if (journals > 0 && (!expense || !liability)) {
    throw conflict('The chart of accounts has no postable expense and liability account to accrue against.');
  }

  const customerIds: string[] = [];
  const productIds: string[] = [];

  conn().tx(() => {
    for (let index = 0; index < customers; index += 1) {
      const id = randomUUID();
      customerIds.push(id);
      const first = FIRST_NAMES[Math.floor(random() * FIRST_NAMES.length)] ?? 'Ada';
      const last = LAST_NAMES[Math.floor(random() * LAST_NAMES.length)] ?? 'Lovelace';
      conn().run(
        `INSERT INTO customers (id, code, name, email, phone, address_json, payment_terms_days,
           credit_limit_cents, currency, is_active, custom_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 30, 500000, ?, 1, '{}', ?, ?)`,
        [
          id,
          `PC-${String(index + 1).padStart(6, '0')}`,
          `${first} ${last} ${String(index + 1)}`,
          `perf${String(index + 1)}@example.test`,
          `+1 555 ${String(1000 + (index % 8999))}`,
          JSON.stringify({ city: CITIES[index % CITIES.length] ?? 'Springfield', country: 'US' }),
          currency,
          at,
          at,
        ],
      );
    }

    for (let index = 0; index < products; index += 1) {
      const id = randomUUID();
      productIds.push(id);
      const noun = NOUNS[index % NOUNS.length] ?? 'Widget';
      conn().run(
        `INSERT INTO products (id, sku, name, uom, cost_method, standard_cost_cents, base_price_cents,
           is_stock_tracked, is_active, custom_json, created_at, updated_at)
         VALUES (?, ?, ?, 'unit', 'avco', ?, ?, 0, 1, '{}', ?, ?)`,
        [
          id,
          `PSKU-${String(index + 1).padStart(6, '0')}`,
          `${noun} ${String(index + 1)}`,
          1_000 + (index % 5_000),
          1_500 + (index % 9_000),
          at,
          at,
        ],
      );
    }

    // Each invoice is posted with a balanced two-line journal, so the trial
    // balance has something real to aggregate.
    for (let index = 0; index < invoices; index += 1) {
      const customerId = customerIds[index % Math.max(customerIds.length, 1)] ?? '';
      if (!customerId) break;
      const amount = 1_000 + Math.floor(random() * 500_000);
      const date = addDays(today, -(index % 1095));
      const invoiceId = randomUUID();
      const entryId = randomUUID();
      // Anything older than a quarter is settled, which is both realistic and
      // what makes the archive path reachable: an unpaid invoice is deliberately
      // not archivable.
      const settled = date < addDays(today, -90);

      conn().run(
        `INSERT INTO invoices (id, number, customer_id, date, due_date, status, currency,
           subtotal_cents, discount_cents, tax_cents, total_cents, paid_cents, custom_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, '{}', ?, ?)`,
        [
          invoiceId,
          `PINV-${String(index + 1).padStart(6, '0')}`,
          customerId,
          date,
          addDays(date, 30),
          settled ? 'paid' : 'posted',
          currency,
          amount,
          amount,
          settled ? amount : 0,
          at,
          at,
        ],
      );
      conn().run(
        `INSERT INTO journal_entries (id, number, journal_id, date, period_id, memo, status,
           source_type, source_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'posted', 'invoice', ?, ?, ?)`,
        [entryId, `PJE-${String(index + 1).padStart(6, '0')}`, journal.id, date, period.id, `Perf invoice ${String(index + 1)}`, invoiceId, at, at],
      );
      conn().run(
        `INSERT INTO journal_lines (id, entry_id, line_no, account_id, debit_cents, credit_cents, description, posted_date)
         VALUES (?, ?, 1, ?, ?, 0, ?, ?)`,
        [randomUUID(), entryId, ar.id, amount, `Invoice ${String(index + 1)}`, date],
      );
      conn().run(
        `INSERT INTO journal_lines (id, entry_id, line_no, account_id, debit_cents, credit_cents, description, posted_date)
         VALUES (?, ?, 2, ?, 0, ?, ?, ?)`,
        [randomUUID(), entryId, revenue.id, amount, `Invoice ${String(index + 1)}`, date],
      );
    }

    // Balanced accruals, so the ledger reaches the size the trial-balance budget
    // is stated at without unbalancing the books.
    for (let index = 0; index < journals && expense && liability; index += 1) {
      const amount = 500 + Math.floor(random() * 200_000);
      const date = addDays(today, -(index % 1095));
      const entryId = randomUUID();
      conn().run(
        `INSERT INTO journal_entries (id, number, journal_id, date, period_id, memo, status,
           source_type, source_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'posted', 'manual', NULL, ?, ?)`,
        [
          entryId,
          `PMJ-${String(index + 1).padStart(6, '0')}`,
          journal.id,
          date,
          period.id,
          `Perf accrual ${String(index + 1)}`,
          at,
          at,
        ],
      );
      conn().run(
        `INSERT INTO journal_lines (id, entry_id, line_no, account_id, debit_cents, credit_cents, description, posted_date)
         VALUES (?, ?, 1, ?, ?, 0, ?, ?)`,
        [randomUUID(), entryId, expense.id, amount, `Accrual ${String(index + 1)}`, date],
      );
      conn().run(
        `INSERT INTO journal_lines (id, entry_id, line_no, account_id, debit_cents, credit_cents, description, posted_date)
         VALUES (?, ?, 2, ?, 0, ?, ?, ?)`,
        [randomUUID(), entryId, liability.id, amount, `Accrual ${String(index + 1)}`, date],
      );
    }
  });
  conn().markDirty();
  invalidateCache('report:');

  const lines = conn().one<{ total: number }>('SELECT COUNT(*) AS total FROM journal_lines');
  return {
    customers,
    products,
    invoices,
    journalLines: Number(lines?.total ?? 0),
    ms: Date.now() - started,
  };
}

export interface BenchmarkRow {
  readonly name: string;
  readonly ms: number;
  readonly detail: string;
}

export interface BenchmarkResult {
  readonly rows: readonly BenchmarkRow[];
  readonly totalMs: number;
  readonly counts: { readonly customers: number; readonly invoices: number; readonly journalLines: number };
}

function time(name: string, detail: string, run: () => string): BenchmarkRow {
  const started = process.hrtime.bigint();
  const note = run();
  const ms = Number(process.hrtime.bigint() - started) / 1_000_000;
  return { name, ms: Math.round(ms * 100) / 100, detail: `${detail}${note}` };
}

/** Measures the five queries that decide whether the app feels fast. */
export function benchmark(): BenchmarkResult {
  const counts = {
    customers: Number(conn().one<{ total: number }>('SELECT COUNT(*) AS total FROM customers')?.total ?? 0),
    invoices: Number(conn().one<{ total: number }>('SELECT COUNT(*) AS total FROM invoices')?.total ?? 0),
    journalLines: Number(conn().one<{ total: number }>('SELECT COUNT(*) AS total FROM journal_lines')?.total ?? 0),
  };

  const rows: BenchmarkRow[] = [
    time('customers page 1', 'page 1, 200 rows: ', () => {
      const page = conn().all('SELECT id, name, code FROM customers ORDER BY name LIMIT 200 OFFSET 0');
      return `${String(page.length)} rows`;
    }),
    // Deep paging is the case an OFFSET-based list actually has to survive: a
    // 10 000-customer book paged 200 at a time reaches page 50, and the invoice
    // list reaches page 500 at 100 000 documents.
    time('customers page 900', 'page 900, 200 rows (OFFSET 179 800): ', () => {
      const page = conn().all('SELECT id, name, code FROM customers ORDER BY name LIMIT 200 OFFSET 179800');
      return `${String(page.length)} rows`;
    }),
    time('invoice KPI', 'SUM(total_cents) over all invoices: ', () => {
      const row = conn().one<{ total: number }>(
        "SELECT COALESCE(SUM(total_cents - paid_cents), 0) AS total FROM invoices WHERE status IN ('posted','partially_paid')",
      );
      return `sum ${String(row?.total ?? 0)}`;
    }),
    time('trial balance', `${String(counts.journalLines)} journal lines: `, () => {
      invalidateCache('report:');
      const report = trialBalance(todayIso());
      return `${String(report.rows.length)} accounts, balanced=${String(report.balanced)}`;
    }),
    // Two terms, because they exercise different paths. `Perf` matches nothing,
    // so every master source also runs its `%term%` fallback — the worst case a
    // typo produces. `Ada` matches a customer, so the prefix pass wins and the
    // fallback is skipped.
    time('global search', 'search for "Perf" (no match — the worst case): ', () => {
      const result = searchGlobal('Perf', { limit: 20 });
      return `${String(result.groups.reduce((total, group) => total + group.rows.length, 0))} hits`;
    }),
    time('global search (hit)', 'prefix search for "Ada": ', () => {
      const result = searchGlobal('Ada', { limit: 20 });
      return `${String(result.groups.reduce((total, group) => total + group.rows.length, 0))} hits`;
    }),
    time('archive round trip', 'archive one invoice then restore it: ', () => {
      const target = conn().one<{ id: string }>(
        "SELECT id FROM invoices WHERE status = 'posted' ORDER BY date LIMIT 1",
      );
      if (!target) return 'nothing to archive';
      archiveOldRecords({ before: todayIso(), tables: ['invoices'], limit: 1 });
      const archived = conn().one<{ id: string }>('SELECT id FROM archive_records LIMIT 1');
      if (!archived) return 'nothing archived';
      restoreArchived(archived.id);
      return 'restored 1';
    }),
  ];

  return {
    rows,
    totalMs: Math.round(rows.reduce((total, row) => total + row.ms, 0) * 100) / 100,
    counts,
  };
}
