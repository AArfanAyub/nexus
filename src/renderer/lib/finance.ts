/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Renderer-side finance plumbing (T05/T06, R1).
 *
 * Three things live here and nowhere else:
 *
 *   1. **Query keys.** `fk.*` builders, so `invalidate('invoices')` in one page
 *      refreshes every page that shows invoices. A key that is written inline
 *      in two places is a cache bug waiting to happen.
 *   2. **Typed channel wrappers.** `invoke<T>` needs a `Channel` literal; the
 *      wrappers keep that literal in one file instead of thirty.
 *   3. **Reference data.** The chart of accounts, the journal codes, the
 *      customer/vendor/product/tax lookups every document editor needs. Each is
 *      one `useQuery` keyed on its entity name, so ten open pickers share one
 *      round trip.
 *
 * Nothing here computes money. Amounts arrive as `…Cents` and are formatted with
 * `lib/format`; arithmetic stays in `@shared/money`.
 */

import { useEffect, useMemo, useState } from 'react';

import type {
  AccountNode,
  ArStatus,
  BillDetail,
  BillRow,
  CashFlow,
  CloseChecklistItem,
  DocumentLineInput,
  DocumentTotals,
  InvoiceDetail,
  InvoiceRow,
  JournalEntryDetail,
  JournalEntrySummary,
  JournalFilter,
  LedgerPage,
  PaymentDetail,
  PaymentRow,
  PeriodRow,
  ProfitAndLoss,
  BalanceSheet,
  TrialBalance,
} from '@shared/finance';
import type { Paged } from '@shared/types';

import { invoke } from './api';
import { useQuery } from './useQuery';

// ── query keys ───────────────────────────────────────────────────────────────

/** Stable key builders. A filter is serialised in a fixed field order. */
export const fk = {
  coa: (includeArchived: boolean): string => `coa:${includeArchived ? 'all' : 'live'}`,
  journalCodes: 'journalCodes',
  periods: 'periods',
  close: (fiscalYearId: string): string => `periods:close:${fiscalYearId}`,
  invoices: (filter: object): string => `invoices:${stable(filter)}`,
  invoice: (id: string): string => `invoice:${id}`,
  bills: (filter: object): string => `bills:${stable(filter)}`,
  bill: (id: string): string => `bill:${id}`,
  payments: (filter: object): string => `payments:${stable(filter)}`,
  payment: (id: string): string => `payment:${id}`,
  journals: (filter: object): string => `journals:${stable(filter)}`,
  journal: (id: string): string => `journal:${id}`,
  trialBalance: (asOf: string): string => `tb:${asOf}`,
  pnl: (from: string, to: string, comparative: boolean): string => `pnl:${from}:${to}:${comparative}`,
  balanceSheet: (asOf: string, comparative: boolean): string => `bs:${asOf}:${comparative}`,
  cashFlow: (from: string, to: string): string => `cf:${from}:${to}`,
  ledger: (accountId: string, from: string, to: string, page: number): string =>
    `gl:${accountId}:${from}:${to}:${page}`,
  entity: (entity: string, limit: number): string => `entity:${entity}:${limit}`,
} as const;

/** JSON with sorted keys, so two equal filters always produce one cache entry. */
function stable(value: object): string {
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined && record[key] !== '' && record[key] !== null)
    .sort();
  return keys.map((key) => `${key}=${String(record[key])}`).join('&');
}

// ── typed wrappers ───────────────────────────────────────────────────────────

export function fetchCoa(includeArchived = false): Promise<readonly AccountNode[]> {
  return invoke<readonly AccountNode[]>('finance.coa.tree', { includeArchived });
}

export function fetchJournalCodes(): Promise<readonly { id: string; code: string; name: string; type: string }[]> {
  return invoke('finance.journals.codes', {});
}

export function fetchPeriods(): Promise<readonly PeriodRow[]> {
  return invoke<readonly PeriodRow[]>('finance.periods.list', {});
}

export function fetchCloseChecklist(fiscalYearId: string): Promise<readonly CloseChecklistItem[]> {
  return invoke<readonly CloseChecklistItem[]>('finance.periods.close', { fiscalYearId });
}

export function fetchInvoices(filter: Record<string, unknown>): Promise<Paged<InvoiceRow>> {
  return invoke<Paged<InvoiceRow>>('finance.invoices.list', filter);
}

export function fetchInvoice(id: string): Promise<InvoiceDetail> {
  return invoke<InvoiceDetail>('finance.invoices.get', { id });
}

export function fetchBills(filter: Record<string, unknown>): Promise<Paged<BillRow>> {
  return invoke<Paged<BillRow>>('finance.bills.list', filter);
}

export function fetchBill(id: string): Promise<BillDetail> {
  return invoke<BillDetail>('finance.bills.get', { id });
}

export function fetchPayments(filter: Record<string, unknown>): Promise<Paged<PaymentRow>> {
  return invoke<Paged<PaymentRow>>('finance.payments.list', filter);
}

export function fetchPayment(id: string): Promise<PaymentDetail> {
  return invoke<PaymentDetail>('finance.payments.get', { id });
}

export function fetchJournals(
  filter: JournalFilter,
): Promise<{ readonly rows: readonly JournalEntrySummary[]; readonly total: number }> {
  return invoke('finance.journals.list', filter);
}

export function fetchJournal(id: string): Promise<JournalEntryDetail> {
  return invoke<JournalEntryDetail>('finance.journals.get', { id });
}

export function fetchTrialBalance(asOf: string): Promise<TrialBalance> {
  return invoke<TrialBalance>('finance.reports.trialBalance', { asOf });
}

export function fetchProfitAndLoss(from: string, to: string, comparative: boolean): Promise<ProfitAndLoss> {
  return invoke<ProfitAndLoss>('finance.reports.pnl', { from, to, comparative });
}

export function fetchBalanceSheet(asOf: string, comparative: boolean): Promise<BalanceSheet> {
  return invoke<BalanceSheet>('finance.reports.balanceSheet', { asOf, comparative });
}

export function fetchCashFlow(from: string, to: string): Promise<CashFlow> {
  return invoke<CashFlow>('finance.reports.cashFlow', { from, to });
}

export function fetchLedger(accountId: string, from: string, to: string, page: number): Promise<LedgerPage> {
  return invoke<LedgerPage>('finance.reports.generalLedger', { accountId, from, to, page, pageSize: 100 });
}

/**
 * Totals for an unsaved document.
 *
 * The editor must show per-line tax and the document total while the operator
 * types, and the rounding rules (per-line half-even, document half-up, inclusive
 * tax back-computed) live in `money.ts` on the main side. Asking the main
 * process is the only way to show those numbers without reimplementing them.
 */
export function fetchComputedTotals(
  lines: readonly DocumentLineInput[],
  currency: string,
): Promise<DocumentTotals> {
  return invoke<DocumentTotals>('finance.documents.compute', { currency, lines });
}

// ── hooks ────────────────────────────────────────────────────────────────────

/** The whole chart of accounts, flattened and pre-ordered by the server. */
export function useCoa(includeArchived = false): {
  readonly accounts: readonly AccountNode[];
  readonly byId: ReadonlyMap<string, AccountNode>;
  readonly loading: boolean;
  readonly error: string | null;
} {
  const query = useQuery<readonly AccountNode[]>(fk.coa(includeArchived), () => fetchCoa(includeArchived), {
    staleMs: 60_000,
  });
  const accounts = query.data ?? [];
  const byId = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  return {
    accounts,
    byId,
    loading: query.loading,
    error: query.error ? query.error.message : null,
  };
}

export function useJournalCodes(): readonly { id: string; code: string; name: string; type: string }[] {
  const query = useQuery(fk.journalCodes, fetchJournalCodes, { staleMs: 300_000 });
  return query.data ?? [];
}

export function usePeriods(): {
  readonly periods: readonly PeriodRow[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const query = useQuery<readonly PeriodRow[]>(fk.periods, fetchPeriods, { staleMs: 30_000 });
  return {
    periods: query.data ?? [],
    loading: query.loading,
    error: query.error ? query.error.message : null,
    refresh: query.refresh,
  };
}

export interface LookupRow {
  readonly id: string;
  readonly name: string;
  readonly code?: string;
  readonly [key: string]: unknown;
}

/**
 * A small reference list for a picker (`customers`, `vendors`, `products`,
 * `taxes`, `currencies`). Capped at `limit` because a `<select>` with 10 000
 * `<option>`s is unusable and slow; the document builders search the server
 * instead when a record is not in the first page.
 */
export function useLookup(entity: string, limit = 200): readonly LookupRow[] {
  const query = useQuery<LookupRow[]>(
    fk.entity(entity, limit),
    async () => {
      const page = await invoke<Paged<Record<string, unknown>>>('entity.list', {
        entity,
        limit,
        sort: { key: 'name', dir: 'asc' },
      });
      return page.rows.map((row) => ({
        ...row,
        id: String(row['id'] ?? ''),
        name: String(row['name'] ?? row['full_name'] ?? row['code'] ?? row['id'] ?? ''),
        code: row['code'] === undefined ? undefined : String(row['code']),
      })) as LookupRow[];
    },
    { staleMs: 300_000 },
  );
  return query.data ?? [];
}

/** Debounces a value — the document preview and the search box both use it. */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Counts per status for the segmented tabs.
 *
 * Each status is one `pageSize: 1` call and only `total` is read, which is a
 * covering count in SQLite rather than a row transfer. Six statuses is six
 * cheap local calls, and they run in parallel.
 */
export function useStatusCounts(
  kind: 'invoices' | 'bills',
  statuses: readonly string[],
  base: Record<string, unknown>,
): Readonly<Record<string, number>> {
  const key = `counts:${kind}:${stable(base)}`;
  const query = useQuery<Record<string, number>>(
    key,
    async () => {
      const fetcher = kind === 'invoices' ? fetchInvoices : fetchBills;
      const results = await Promise.all(
        statuses.map(async (status) => {
          const page = await fetcher({ ...base, status, page: 1, pageSize: 1 });
          return [status, page.total] as const;
        }),
      );
      return Object.fromEntries(results) as Record<string, number>;
    },
    { staleMs: 15_000 },
  );
  return query.data ?? {};
}

/** The statuses a document list offers, in reading order. */
export const AR_STATUSES: readonly ArStatus[] = ['draft', 'posted', 'partially_paid', 'overdue', 'paid', 'void'];

// ── small helpers shared by the pages ────────────────────────────────────────

/** `2026-02-01` … `2026-02-28` for the month containing `iso`. */
export function monthRange(iso: string): { readonly from: string; readonly to: string } {
  const [year, month] = iso.split('-');
  const first = `${year ?? '2026'}-${month ?? '01'}-01`;
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return { from: first, to: `${year ?? '2026'}-${month ?? '01'}-${String(lastDay).padStart(2, '0')}` };
}

/** The fiscal year containing `iso`, assuming a calendar year (the default). */
export function yearRange(iso: string): { readonly from: string; readonly to: string } {
  const year = iso.slice(0, 4);
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** Today in the user's timezone as `YYYY-MM-DD`, not UTC. */
export function today(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** Adds `days` to an ISO date, in UTC so no DST hour can shift it. */
export function addDays(iso: string, days: number): string {
  const base = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(base)) return iso;
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** True when an error code means "the period is locked" rather than a bug. */
export function isLockConflict(message: string): boolean {
  return /locked/i.test(message);
}
