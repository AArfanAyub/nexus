/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Finance channel handlers (T05/T06).
 *
 * A thin translation layer and nothing else: shape is validated in `schemas.ts`,
 * permissions and the transaction come from the dispatcher, and every business
 * rule lives in `services/finance.*`. Keeping it thin is what lets T07/T08 call
 * the same services without going through IPC.
 *
 * Mutating channels do **not** open their own transaction — the dispatcher wraps
 * them, and `writeJournal` nests as a passthrough inside it. That is what makes
 * "a throw at gate 5 rolls back gates 1–4" true.
 */

import type {
  AccountInput,
  AllocationInput,
  BillInput,
  DocumentLineInput,
  InvoiceInput,
  JournalFilter,
  JournalInput,
} from '../shared/finance';
import type { RegisterFn } from './ipc';
import {
  allocate,
  archiveAccount,
  balanceSheet,
  cashFlow,
  closeChecklist,
  coaTree,
  computeTotals,
  deleteDraft,
  generalLedger,
  getBill,
  getInvoice,
  getJournalEntry,
  getPayment,
  listBills,
  listInvoices,
  listJournalEntries,
  listJournals,
  listPayments,
  listPeriods,
  lockPeriod,
  postBill,
  postEntry,
  postInvoice,
  profitAndLoss,
  recordPayment,
  reverseEntry,
  saveAccount,
  saveBill,
  saveInvoice,
  saveJournal,
  trialBalance,
  unlockPeriod,
  voidBill,
  voidInvoice,
  type InvoiceFilter,
  type JournalScope,
  type PaymentFilter,
} from './services/finance';
import { evaluateMatch } from './services/match';

/** Bills list with the customer filter replaced by a vendor filter. */
type BillFilter = Omit<InvoiceFilter, 'customerId'> & { readonly vendorId?: string };

/** The actor for the audit trail, taken from the dispatcher context. */
function scopeOf(ctx: { readonly actorId: string | null; readonly actorName: string }): JournalScope {
  return { actorId: ctx.actorId, actorName: ctx.actorName };
}

interface PeriodReason {
  readonly id: string;
  readonly reason: string;
}

interface ReportRange {
  readonly from: string;
  readonly to: string;
  readonly comparative?: boolean;
}

/** Registers every finance channel. */
export function registerFinanceChannels(register: RegisterFn): void {
  // ── chart of accounts ──────────────────────────────────────────────────────
  register<{ includeArchived?: boolean }, unknown>({
    channel: 'finance.coa.tree',
    handler: (payload) => coaTree({ includeArchived: payload.includeArchived === true }),
  });

  register<AccountInput, unknown>({
    channel: 'finance.coa.save',
    handler: (payload) => saveAccount(payload),
  });

  register<{ id: string; reason: string }, unknown>({
    channel: 'finance.coa.archive',
    handler: (payload) => archiveAccount(payload.id, payload.reason),
  });

  // ── journals ───────────────────────────────────────────────────────────────
  register<Record<string, never>, unknown>({
    channel: 'finance.journals.codes',
    handler: () => listJournals(),
  });

  register<JournalFilter, unknown>({
    channel: 'finance.journals.list',
    handler: (payload) => listJournalEntries(payload),
  });

  register<{ id: string }, unknown>({
    channel: 'finance.journals.get',
    handler: (payload) => getJournalEntry(payload.id),
  });

  register<JournalInput & { id?: string }, unknown>({
    channel: 'finance.journals.save',
    handler: (payload, ctx) => saveJournal(payload, scopeOf(ctx)),
  });

  register<{ id: string }, unknown>({
    channel: 'finance.journals.post',
    handler: (payload, ctx) => postEntry(payload.id, scopeOf(ctx)),
  });

  register<{ id: string; reason: string }, unknown>({
    channel: 'finance.journals.reverse',
    handler: (payload, ctx) => reverseEntry(payload.id, payload.reason, scopeOf(ctx)),
  });

  register<{ id: string }, unknown>({
    channel: 'finance.journals.delete',
    handler: (payload) => deleteDraft(payload.id),
  });

  // ── invoices ───────────────────────────────────────────────────────────────
  register<InvoiceFilter, unknown>({
    channel: 'finance.invoices.list',
    handler: (payload) => listInvoices(payload),
  });

  register<InvoiceInput, unknown>({
    channel: 'finance.invoices.save',
    handler: (payload, ctx) => saveInvoice(payload, scopeOf(ctx)),
  });

  register<{ id: string }, unknown>({
    channel: 'finance.invoices.get',
    handler: (payload) => getInvoice(payload.id),
  });

  register<{ id: string }, unknown>({
    channel: 'finance.invoices.post',
    handler: (payload, ctx) => postInvoice(payload.id, scopeOf(ctx)),
  });

  register<{ id: string; reason: string }, unknown>({
    channel: 'finance.invoices.void',
    handler: (payload, ctx) => voidInvoice(payload.id, payload.reason, scopeOf(ctx)),
  });

  register<{ id: string }, unknown>({
    channel: 'finance.invoices.duplicate',
    handler: (payload, ctx) => {
      const source = getInvoice(payload.id);
      return saveInvoice(
        {
          customerId: source.customerId,
          date: source.date,
          dueDate: source.dueDate,
          currency: source.currency,
          notes: source.notes,
          terms: source.terms,
          lines: source.lines.map((line) => ({
            productId: line.productId,
            description: line.description,
            qtyMilli: line.qtyMilli,
            unitPriceCents: line.unitPriceCents,
            discountBp: line.discountBp,
            taxId: line.taxId,
            accountId: line.accountId,
          })),
          sourceType: 'duplicate',
          sourceId: source.id,
        },
        scopeOf(ctx),
      );
    },
  });

  // ── bills ──────────────────────────────────────────────────────────────────
  register<BillFilter, unknown>({
    channel: 'finance.bills.list',
    handler: (payload) => listBills(payload),
  });

  register<BillInput, unknown>({
    channel: 'finance.bills.save',
    handler: (payload, ctx) => saveBill(payload, scopeOf(ctx)),
  });

  register<{ id: string }, unknown>({
    channel: 'finance.bills.get',
    handler: (payload) => getBill(payload.id),
  });

  register<{ id: string }, unknown>({
    channel: 'finance.bills.post',
    handler: (payload, ctx) => postBill(payload.id, scopeOf(ctx)),
  });

  register<{ id: string; reason: string }, unknown>({
    channel: 'finance.bills.void',
    handler: (payload, ctx) => voidBill(payload.id, payload.reason, scopeOf(ctx)),
  });

  // ── payments ───────────────────────────────────────────────────────────────
  register<PaymentFilter, unknown>({
    channel: 'finance.payments.list',
    handler: (payload) => listPayments(payload),
  });

  register<Parameters<typeof recordPayment>[0], unknown>({
    channel: 'finance.payments.create',
    handler: (payload, ctx) => recordPayment(payload, scopeOf(ctx)),
  });

  register<{ id: string; allocations: readonly AllocationInput[] }, unknown>({
    channel: 'finance.payments.allocate',
    handler: (payload) => allocate(payload.id, payload.allocations),
  });

  register<{ id: string }, unknown>({
    channel: 'finance.payments.get',
    handler: (payload) => getPayment(payload.id),
  });

  /**
   * Totals for a document that does not exist yet. Read-only: it computes and
   * returns, writing nothing, which is why it is listed in `READ_ONLY_CHANNELS`
   * and does not open a transaction.
   */
  register<{ currency: string; lines: readonly DocumentLineInput[] }, unknown>({
    channel: 'finance.documents.compute',
    handler: (payload) => computeTotals(payload.lines),
  });

  // ── reports ────────────────────────────────────────────────────────────────
  register<{ asOf: string }, unknown>({
    channel: 'finance.reports.trialBalance',
    handler: (payload) => trialBalance(payload.asOf),
  });

  register<ReportRange, unknown>({
    channel: 'finance.reports.pnl',
    handler: (payload) => profitAndLoss(payload.from, payload.to, payload.comparative !== false),
  });

  register<{ asOf: string; comparative?: boolean }, unknown>({
    channel: 'finance.reports.balanceSheet',
    handler: (payload) => balanceSheet(payload.asOf, payload.comparative !== false),
  });

  register<ReportRange, unknown>({
    channel: 'finance.reports.cashFlow',
    handler: (payload) => cashFlow(payload.from, payload.to),
  });

  register<{
    accountId: string;
    from: string;
    to: string;
    page?: number;
    pageSize?: number;
  }, unknown>({
    channel: 'finance.reports.generalLedger',
    handler: (payload) => generalLedger(payload.accountId, payload.from, payload.to, payload.page, payload.pageSize),
  });

  // ── periods ────────────────────────────────────────────────────────────────
  register<Record<string, never>, unknown>({
    channel: 'finance.periods.list',
    handler: () => listPeriods(),
  });

  register<PeriodReason, unknown>({
    channel: 'finance.periods.lock',
    handler: (payload, ctx) => lockPeriod(payload.id, payload.reason, scopeOf(ctx)),
  });

  register<PeriodReason, unknown>({
    channel: 'finance.periods.unlock',
    handler: (payload, ctx) => unlockPeriod(payload.id, payload.reason, scopeOf(ctx)),
  });

  register<{ fiscalYearId: string }, unknown>({
    channel: 'finance.periods.close',
    handler: (payload) => closeChecklist(payload.fiscalYearId),
  });

  /*
   * Declared in the catalogue since T06 but never registered — calling it would
   * have reached the dispatcher's "no handler" path. It is the three-way match
   * preview for a bill, which is exactly what `postBill` consults before posting.
   */
  register<{ id: string }, unknown>({
    channel: 'finance.bills.match',
    handler: (payload) => evaluateMatch(payload.id),
  });
}
