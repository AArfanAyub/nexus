/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The four reports and the general ledger (T05, US-21/22).
 *
 * Every figure is aggregated in SQL over `journal_lines` joined to *posted*
 * entries only — drafts never influence a report. No report stores a balance, so
 * a report can never disagree with the ledger.
 *
 * Sign conventions, applied once here so the renderer never flips a number:
 *   - assets and expenses are debit-positive
 *   - liabilities, equity and income are credit-positive
 *   - `trialBalance` is the exception: it shows raw debit and credit columns,
 *     because that is what a trial balance *is*.
 */

import type {
  AccountType,
  BalanceSheet,
  CashFlow,
  CashFlowLine,
  LedgerPage,
  LedgerRow,
  ProfitAndLoss,
  ReportGroup,
  ReportRow,
  TrialBalance,
  TrialBalanceRow,
} from '../../shared/finance';
import { addMonths, todayIso } from '../../shared/dates';
import { cents, sumCents, type Cents } from '../../shared/money';
import { archivedBalances } from './archive';
import { cached } from './cache';
import { conn } from '../db/connection';
import { notFound } from '../errors';

interface BalanceRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly debit: number;
  readonly credit: number;
}

/**
 * Raw debit/credit totals per account up to and including `asOf`.
 *
 * Archived entries are unioned back in (R1): a report that silently ignored the
 * cold store would show a different profit after a housekeeping run, which is
 * the one thing an accounting system may never do.
 *
 * The date filter reads `journal_lines.posted_date`, not the parent entry (v6).
 * Joining the parent meant one b-tree descent per entry — 150 000 of them, 12 µs
 * each — and no index could remove it, because the date lived on the other side
 * of the join.
 *
 * ## Two plans, chosen by the range, both measured (`docs/PERF.md`)
 *
 * A **whole-history** report (the trial balance, the balance sheet) visits every
 * line, so the win is grouping without a temporary B-tree: scanning the
 * account-first index lets the groups stream, 200 ms against 800 ms for the
 * planner's own choice. A **period** report (a month's P&L) visits a slice, so
 * the win is the other way round — the date-first index finds the slice and
 * stops, 25 ms against 200 ms for a full scan. SQLite cannot tell the two apart
 * from the SQL, so the range decides.
 */
const FULL_HISTORY = '0000-01-01';

function balancesTo(asOf: string, from = FULL_HISTORY): readonly BalanceRow[] {
  // `INDEXED BY` is safe here: v6 creates the index, and a build without it
  // could not have produced a v6 database in the first place.
  const scan =
    from === FULL_HISTORY
      ? 'journal_lines INDEXED BY idx_jl_account_date_cover'
      : 'journal_lines';
  const live = conn().all<BalanceRow>(
    `SELECT a.id, a.code, a.name, a.type, g.debit, g.credit
       FROM (SELECT account_id,
                    COALESCE(SUM(debit_cents), 0) AS debit,
                    COALESCE(SUM(credit_cents), 0) AS credit
               FROM ${scan}
              WHERE posted_date >= ? AND posted_date <= ?
              GROUP BY account_id) g
       JOIN accounts a ON a.id = g.account_id
      ORDER BY a.code`,
    [from, asOf],
  );

  const archived = archivedBalances(from, asOf);
  if (archived.size === 0) return live;

  const merged = new Map<string, BalanceRow>();
  for (const row of live) merged.set(row.id, { ...row });
  for (const [accountId, totals] of archived) {
    const existing = merged.get(accountId);
    if (existing) {
      merged.set(accountId, {
        ...existing,
        debit: Number(existing.debit) + totals.debit,
        credit: Number(existing.credit) + totals.credit,
      });
      continue;
    }
    const account = conn().one<{ id: string; code: string; name: string; type: AccountType }>(
      'SELECT id, code, name, type FROM accounts WHERE id = ?',
      [accountId],
    );
    if (account) merged.set(accountId, { ...account, debit: totals.debit, credit: totals.credit });
  }
  return [...merged.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function signed(type: AccountType, debit: number, credit: number): number {
  return type === 'asset' || type === 'expense' ? debit - credit : credit - debit;
}

/**
 * The trial balance. `balanced` is computed, not assumed — the renderer shows it
 * as an explicit check (T05 acceptance #4).
 */
export function trialBalance(asOf: string): TrialBalance {
  return cached(`report:trialBalance:${asOf}`, 30_000, () => computeTrialBalance(asOf));
}

function computeTrialBalance(asOf: string): TrialBalance {
  const rows: TrialBalanceRow[] = balancesTo(asOf).map((row) => ({
    accountId: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    debitCents: Number(row.debit),
    creditCents: Number(row.credit),
    balanceCents: Number(row.debit) - Number(row.credit),
  }));

  const debit = rows.reduce((total, row) => total + row.debitCents, 0);
  const credit = rows.reduce((total, row) => total + row.creditCents, 0);
  return {
    asOf,
    rows,
    totals: { debitCents: debit, creditCents: credit },
    balanced: debit === credit,
  };
}

/** Opening balance, one page of movements and the running balance. */
export function generalLedger(
  accountId: string,
  from: string,
  to: string,
  page = 1,
  pageSize = 100,
): LedgerPage {
  const account = conn().one<{ id: string; code: string; name: string; type: AccountType }>(
    'SELECT id, code, name, type FROM accounts WHERE id = ?',
    [accountId],
  );
  if (!account) throw notFound('Account');

  const opening = conn().one<{ debit: number; credit: number }>(
    `SELECT COALESCE(SUM(l.debit_cents), 0) AS debit, COALESCE(SUM(l.credit_cents), 0) AS credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ? AND e.status = 'posted' AND e.date < ?`,
    [accountId, from],
  );
  const openingCents = signed(account.type, Number(opening?.debit ?? 0), Number(opening?.credit ?? 0));

  const size = Math.min(Math.max(Math.trunc(pageSize), 1), 500);
  const current = Math.max(Math.trunc(page), 1);
  const offset = (current - 1) * size;

  const rows = conn().all<{
    entry_id: string;
    line_id: string;
    date: string;
    number: string | null;
    memo: string | null;
    description: string | null;
    debit_cents: number;
    credit_cents: number;
  }>(
    `SELECT e.id AS entry_id, l.id AS line_id, e.date, e.number, e.memo, l.description,
            l.debit_cents, l.credit_cents
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ?
      ORDER BY e.date, e.created_at, l.line_no
      LIMIT ? OFFSET ?`,
    [accountId, from, to, size, offset],
  );

  // The running balance starts at the opening figure, so the column is
  // continuous when the operator pages forward.
  let running = openingCents;
  const mapped: LedgerRow[] = rows.map((row) => {
    running += signed(account.type, Number(row.debit_cents), Number(row.credit_cents));
    return {
      entryId: row.entry_id,
      lineId: row.line_id,
      date: row.date,
      number: row.number,
      memo: row.memo,
      description: row.description,
      debitCents: Number(row.debit_cents),
      creditCents: Number(row.credit_cents),
      runningCents: running,
    };
  });

  const total = conn().one<{ total: number }>(
    `SELECT COUNT(*) AS total
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ?`,
    [accountId, from, to],
  );

  return {
    accountId,
    accountCode: account.code,
    accountName: account.name,
    from,
    to,
    openingCents,
    closingCents: running,
    rows: mapped,
    total: Number(total?.total ?? 0),
    page: current,
    pageSize: size,
  };
}

function group(
  id: string,
  label: string,
  type: AccountType,
  current: readonly BalanceRow[],
  comparative: readonly BalanceRow[],
): ReportGroup {
  const comparativeByAccount = new Map(comparative.map((row) => [row.id, row]));
  const rows: ReportRow[] = current
    .filter((row) => row.type === type)
    .map((row) => ({
      accountId: row.id,
      code: row.code,
      name: row.name,
      currentCents: signed(type, Number(row.debit), Number(row.credit)),
      comparativeCents: (() => {
        const other = comparativeByAccount.get(row.id);
        return other ? signed(type, Number(other.debit), Number(other.credit)) : 0;
      })(),
    }))
    // A zero row in both columns is noise on a P&L.
    .filter((row) => row.currentCents !== 0 || row.comparativeCents !== 0);

  return {
    id,
    label,
    rows,
    currentCents: rows.reduce((total, row) => total + row.currentCents, 0),
    comparativeCents: rows.reduce((total, row) => total + row.comparativeCents, 0),
  };
}

/** The immediately preceding range of the same length — the default comparative. */
export function comparativeRange(from: string, to: string): { readonly from: string; readonly to: string } {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const days = Math.max(Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1, 1);
  const previousEnd = new Date(start.getTime() - 86_400_000);
  const previousStart = new Date(previousEnd.getTime() - (days - 1) * 86_400_000);
  return {
    from: previousStart.toISOString().slice(0, 10),
    to: previousEnd.toISOString().slice(0, 10),
  };
}

export function profitAndLoss(from: string, to: string, comparative = true): ProfitAndLoss {
  const range = comparative ? comparativeRange(from, to) : { from, to };
  const current = balancesTo(to, from);
  const previous = comparative ? balancesTo(range.to, range.from) : [];

  const income = group('income', 'Income', 'income', current, previous);
  const expense = group('expense', 'Expenses', 'expense', current, previous);

  return {
    from,
    to,
    comparativeFrom: range.from,
    comparativeTo: range.to,
    income,
    expense,
    netCurrentCents: income.currentCents - expense.currentCents,
    netComparativeCents: income.comparativeCents - expense.comparativeCents,
  };
}

/**
 * Assets = Liabilities + Equity, including current-year earnings.
 *
 * The identity is not "close enough": double entry guarantees
 * `Σ(debit − credit) = 0`, so folding `income − expense` into equity makes the
 * two sides equal to the cent at any date (T05 acceptance #5).
 */
export function balanceSheet(asOf: string, comparative = true): BalanceSheet {
  const comparativeAsOf = comparative ? addMonths(asOf, -12) : asOf;
  const current = balancesTo(asOf);
  const previous = comparative ? balancesTo(comparativeAsOf) : [];

  const assets = group('assets', 'Assets', 'asset', current, previous);
  const liabilities = group('liabilities', 'Liabilities', 'liability', current, previous);
  const equityAccounts = group('equity', 'Equity', 'equity', current, previous);

  const earnings = (rows: readonly BalanceRow[]): number => {
    const income = rows
      .filter((row) => row.type === 'income')
      .reduce((total, row) => total + signed('income', Number(row.debit), Number(row.credit)), 0);
    const expense = rows
      .filter((row) => row.type === 'expense')
      .reduce((total, row) => total + signed('expense', Number(row.debit), Number(row.credit)), 0);
    return income - expense;
  };

  const retainedCents = earnings(current);
  const retainedComparativeCents = earnings(previous);

  const equity: ReportGroup = {
    ...equityAccounts,
    rows: [
      ...equityAccounts.rows,
      {
        accountId: '__retained__',
        code: '3900',
        name: 'Current year earnings',
        currentCents: retainedCents,
        comparativeCents: retainedComparativeCents,
      },
    ],
    currentCents: equityAccounts.currentCents + retainedCents,
    comparativeCents: equityAccounts.comparativeCents + retainedComparativeCents,
  };

  const totalAssetsCents = assets.currentCents;
  const totalLiabilitiesCents = liabilities.currentCents;
  const totalEquityCents = equity.currentCents;

  return {
    asOf,
    comparativeAsOf,
    assets,
    liabilities,
    equity,
    retainedCents,
    retainedComparativeCents,
    totalAssetsCents,
    totalLiabilitiesCents,
    totalEquityCents,
    balanced: totalAssetsCents === totalLiabilitiesCents + totalEquityCents,
  };
}

/**
 * Indirect cash flow.
 *
 * Every non-cash account falls into exactly one bucket, so
 * `opening + operating + investing + financing === closing` holds by
 * construction — the residual line exists only to make a mis-coded chart
 * visible rather than to hide a gap.
 */
export function cashFlow(from: string, to: string): CashFlow {
  const before = conn().one<{ total: number }>(
    `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE e.status = 'posted' AND e.date < ? AND a.type = 'asset' AND a.code LIKE '10%'`,
    [from],
  );
  const after = conn().one<{ total: number }>(
    `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE e.status = 'posted' AND e.date <= ? AND a.type = 'asset' AND a.code LIKE '10%'`,
    [to],
  );
  const openingCents = Number(before?.total ?? 0);
  const closingCents = Number(after?.total ?? 0);

  const pnl = profitAndLoss(from, to, false);

  /** Movement of a code-prefix bucket over the range, in debit-positive terms. */
  const movement = (types: readonly AccountType[], prefixes: readonly string[]): number => {
    const placeholders = types.map(() => '?').join(', ');
    const like = prefixes.map(() => 'a.code LIKE ?').join(' OR ');
    const row = conn().one<{ total: number }>(
      `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE e.status = 'posted' AND e.date >= ? AND e.date <= ?
          AND a.type IN (${placeholders}) AND (${like})`,
      [from, to, ...types, ...prefixes],
    );
    return Number(row?.total ?? 0);
  };

  // Assets: a debit-positive increase consumes cash, hence the minus signs.
  const receivables = -movement(['asset'], ['11%']);
  const inventory = -movement(['asset'], ['12%']);
  const otherCurrentAssets = -movement(['asset'], ['13%', '14%']);
  const fixedAssets = -movement(['asset'], ['15%', '16%', '17%', '18%', '19%']);

  // Liabilities and equity: a credit-positive increase is a source of cash.
  const payables = -movement(['liability'], ['20%']);
  const taxLiabilities = -movement(['liability'], ['22%']);
  const otherLiabilities = -movement(['liability'], ['21%', '23%', '24%', '25%', '26%', '27%', '28%', '29%']);
  const equityMovement = -movement(['equity'], ['3%']);

  const operatingCents =
    pnl.netCurrentCents + receivables + inventory + otherCurrentAssets + payables + taxLiabilities;
  const investingCents = fixedAssets;
  const financingCents = otherLiabilities + equityMovement;
  const netCents = closingCents - openingCents;
  const residual = netCents - (operatingCents + investingCents + financingCents);

  const lines: CashFlowLine[] = [
    { label: 'Net profit for the period', currentCents: pnl.netCurrentCents },
    { label: 'Change in receivables', currentCents: receivables },
    { label: 'Change in inventory', currentCents: inventory },
    { label: 'Change in other current assets', currentCents: otherCurrentAssets },
    { label: 'Change in payables', currentCents: payables },
    { label: 'Change in tax payable', currentCents: taxLiabilities },
    { label: 'Purchase of fixed assets', currentCents: fixedAssets },
    { label: 'Change in other liabilities', currentCents: otherLiabilities },
    { label: 'Change in equity', currentCents: equityMovement },
  ];
  if (residual !== 0) {
    lines.push({ label: 'Unclassified movements', currentCents: residual });
  }

  return {
    from,
    to,
    openingCents,
    operatingCents: operatingCents + residual,
    investingCents,
    financingCents,
    netCents,
    closingCents,
    lines,
  };
}

/** Total of the ledger at a date, in debit-positive cents. Used by the tests. */
export function controlTotalAt(asOf: string): Cents {
  const rows = balancesTo(asOf);
  return sumCents(rows.map((row) => cents(Number(row.debit) - Number(row.credit))));
}

/** Convenience for the dashboard: this year's P&L to date. */
export function yearToDateProfit(asOf = todayIso()): number {
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  return profitAndLoss(yearStart, asOf, false).netCurrentCents;
}
