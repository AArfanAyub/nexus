/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The finance contract shared by the main process and the renderer (T05/T06).
 *
 * Every shape here crosses the IPC boundary, so every field is `readonly` and
 * every money field is named `…Cents` — an integer number of minor units. There
 * is deliberately no `number`-typed money field in this file: if a field does
 * not end in `Cents` it is not money (quantities end in `Milli`).
 *
 * Kept out of `types.ts` so the frozen §B contract stays readable; `types.ts`
 * re-exports nothing from here, callers import `@shared/finance` directly.
 */

// ── chart of accounts ────────────────────────────────────────────────────────

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/**
 * One row of the flat COA tree. `depth` is pre-computed so the renderer can
 * indent without walking parents, and `balanceCents` is the *computed* balance
 * including descendants (BR-05: a parent is never posted to).
 */
export interface AccountNode {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly parentId: string | null;
  readonly isPostable: boolean;
  readonly isArchived: boolean;
  readonly currency: string | null;
  readonly description: string | null;
  readonly depth: number;
  readonly hasChildren: boolean;
  /** Signed: debit-positive for assets/expenses, credit-positive for the rest. */
  readonly balanceCents: number;
  /** Postings on this account only, excluding descendants. */
  readonly ownBalanceCents: number;
  readonly postingCount: number;
}

export interface AccountInput {
  readonly id?: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly parentId?: string | null;
  readonly isPostable?: boolean;
  readonly currency?: string | null;
  readonly description?: string | null;
}

// ── journals ─────────────────────────────────────────────────────────────────

export type JournalEntryStatus = 'draft' | 'posted' | 'reversed';

export interface JournalLineInput {
  readonly accountId?: string;
  readonly accountCode?: string;
  readonly debitCents?: number;
  readonly creditCents?: number;
  readonly description?: string | null;
  /** Defaults to the company base currency. */
  readonly currency?: string;
  /** Units of `currency` per unit of base currency, in basis points. */
  readonly rateBp?: number;
  readonly partnerType?: 'customer' | 'vendor' | null;
  readonly partnerId?: string | null;
  readonly taxId?: string | null;
}

export interface JournalInput {
  readonly date: string;
  readonly journalCode: string;
  readonly memo?: string | null;
  readonly lines: readonly JournalLineInput[];
  readonly sourceType: string;
  readonly sourceId?: string | null;
  /** `draft` skips number allocation entirely (BR-08). */
  readonly status?: 'draft' | 'posted';
  /** Set by `reverseEntry`: the entry this one mirrors (BR-03). */
  readonly reversesId?: string | null;
}

export interface JournalLineRow {
  readonly id: string;
  readonly lineNo: number;
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly debitCents: number;
  readonly creditCents: number;
  readonly description: string | null;
  readonly partnerType: string | null;
  readonly partnerId: string | null;
  readonly taxId: string | null;
}

export interface JournalEntrySummary {
  readonly id: string;
  readonly number: string | null;
  readonly date: string;
  readonly journalId: string;
  readonly journalCode: string;
  readonly journalName: string;
  readonly memo: string | null;
  readonly status: JournalEntryStatus;
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly reversesId: string | null;
  readonly postedAt: string | null;
  readonly postedBy: string | null;
  readonly totalCents: number;
}

export interface JournalEntryDetail extends JournalEntrySummary {
  readonly lines: readonly JournalLineRow[];
}

export interface JournalFilter {
  readonly from?: string;
  readonly to?: string;
  readonly journalId?: string;
  readonly sourceType?: string;
  readonly status?: JournalEntryStatus;
  readonly minCents?: number;
  readonly maxCents?: number;
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

// ── reports ──────────────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly debitCents: number;
  readonly creditCents: number;
  readonly balanceCents: number;
}

export interface TrialBalance {
  readonly asOf: string;
  readonly rows: readonly TrialBalanceRow[];
  readonly totals: { readonly debitCents: number; readonly creditCents: number };
  /** `totals.debitCents === totals.creditCents` — surfaced as an explicit check. */
  readonly balanced: boolean;
}

export interface LedgerRow {
  readonly entryId: string;
  readonly lineId: string;
  readonly date: string;
  readonly number: string | null;
  readonly memo: string | null;
  readonly description: string | null;
  readonly debitCents: number;
  readonly creditCents: number;
  readonly runningCents: number;
}

export interface LedgerPage {
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly from: string;
  readonly to: string;
  readonly openingCents: number;
  readonly closingCents: number;
  readonly rows: readonly LedgerRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface ReportRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly currentCents: number;
  readonly comparativeCents: number;
}

export interface ReportGroup {
  readonly id: string;
  readonly label: string;
  readonly rows: readonly ReportRow[];
  readonly currentCents: number;
  readonly comparativeCents: number;
}

export interface ProfitAndLoss {
  readonly from: string;
  readonly to: string;
  readonly comparativeFrom: string;
  readonly comparativeTo: string;
  readonly income: ReportGroup;
  readonly expense: ReportGroup;
  readonly netCurrentCents: number;
  readonly netComparativeCents: number;
}

export interface BalanceSheet {
  readonly asOf: string;
  readonly comparativeAsOf: string;
  readonly assets: ReportGroup;
  readonly liabilities: ReportGroup;
  readonly equity: ReportGroup;
  /** Current-year earnings, folded into equity so `A === L + E` holds exactly. */
  readonly retainedCents: number;
  readonly retainedComparativeCents: number;
  readonly totalAssetsCents: number;
  readonly totalLiabilitiesCents: number;
  readonly totalEquityCents: number;
  readonly balanced: boolean;
}

export interface CashFlowLine {
  readonly label: string;
  readonly currentCents: number;
}

export interface CashFlow {
  readonly from: string;
  readonly to: string;
  readonly openingCents: number;
  readonly operatingCents: number;
  readonly investingCents: number;
  readonly financingCents: number;
  readonly netCents: number;
  readonly closingCents: number;
  readonly lines: readonly CashFlowLine[];
}

// ── periods ──────────────────────────────────────────────────────────────────

export interface PeriodRow {
  readonly id: string;
  readonly fiscalYearId: string;
  readonly fiscalYearName: string;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: 'open' | 'locked';
  readonly lockedAt: string | null;
  readonly lockedBy: string | null;
  readonly lockedByName: string | null;
  readonly entryCount: number;
  readonly draftCount: number;
}

export interface CloseChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

// ── AR / AP documents ────────────────────────────────────────────────────────

export interface DocumentLineInput {
  readonly id?: string;
  readonly productId?: string | null;
  readonly description: string;
  readonly qtyMilli: number;
  readonly unitPriceCents: number;
  readonly discountBp?: number;
  readonly taxId?: string | null;
  readonly accountId?: string | null;
  /** Purchase-order price, carried so the three-way match can compare it. */
  readonly poPriceCents?: number | null;
  /** Quantity actually received against the PO, carried for the same reason. */
  readonly receivedQtyMilli?: number | null;
}

export interface InvoiceInput {
  readonly id?: string;
  readonly customerId: string;
  readonly date: string;
  readonly dueDate: string;
  readonly currency: string;
  readonly notes?: string | null;
  readonly terms?: string | null;
  readonly lines: readonly DocumentLineInput[];
  readonly sourceType?: string | null;
  readonly sourceId?: string | null;
}

export interface BillInput {
  readonly id?: string;
  readonly vendorId: string;
  readonly vendorRef?: string | null;
  readonly date: string;
  readonly dueDate: string;
  readonly currency: string;
  readonly notes?: string | null;
  readonly lines: readonly DocumentLineInput[];
  readonly poId?: string | null;
  /** Receipts this bill is clearing, so the chain cross-references both ways. */
  readonly receiptIds?: readonly string[];
}

export interface ComputedLine {
  readonly description: string;
  readonly productId: string | null;
  readonly qtyMilli: number;
  readonly unitPriceCents: number;
  readonly discountBp: number;
  readonly taxId: string | null;
  readonly accountId: string | null;
  readonly netCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  /** Present on a bill line that came from a purchase order. */
  readonly poPriceCents?: number | null;
  readonly receivedQtyMilli?: number | null;
  readonly matchStatus?: string;
}

export interface DocumentTotals {
  readonly lines: readonly ComputedLine[];
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
}

export type ArStatus = 'draft' | 'posted' | 'partially_paid' | 'paid' | 'void' | 'overdue';

export interface InvoiceRow {
  readonly id: string;
  readonly number: string | null;
  readonly customerId: string;
  readonly customerName: string;
  readonly date: string;
  readonly dueDate: string;
  readonly status: ArStatus;
  readonly currency: string;
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly paidCents: number;
  readonly balanceCents: number;
  readonly journalEntryId: string | null;
  readonly notes: string | null;
  readonly terms: string | null;
  readonly postedAt: string | null;
  readonly daysOverdue: number;
}

export interface InvoiceDetail extends InvoiceRow {
  readonly lines: readonly ComputedLine[];
}

export interface BillRow {
  readonly id: string;
  readonly number: string | null;
  readonly vendorId: string;
  readonly vendorName: string;
  readonly vendorRef: string | null;
  readonly date: string;
  readonly dueDate: string;
  readonly status: ArStatus | 'match_exception';
  readonly currency: string;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly paidCents: number;
  readonly balanceCents: number;
  readonly journalEntryId: string | null;
  readonly notes: string | null;
  readonly postedAt: string | null;
  readonly daysOverdue: number;
  readonly poId: string | null;
  readonly matchState: string;
}

export interface BillDetail extends BillRow {
  readonly lines: readonly ComputedLine[];
  readonly receiptIds: readonly string[];
  readonly exceptionReason: string | null;
  readonly approvedBy: string | null;
}

// ── payments ─────────────────────────────────────────────────────────────────

export type PaymentMethod = 'bank' | 'cash' | 'card' | 'cheque' | 'transfer' | 'other';

export interface PaymentInput {
  readonly direction: 'in' | 'out';
  readonly partnerType: 'customer' | 'vendor';
  readonly partnerId: string;
  readonly date: string;
  readonly method: PaymentMethod;
  readonly reference?: string | null;
  readonly amountCents: number;
  readonly currency: string;
  readonly bankAccountId?: string | null;
  readonly notes?: string | null;
}

export interface AllocationInput {
  readonly invoiceId?: string;
  readonly billId?: string;
  readonly amountCents: number;
}

export interface PaymentAllocation {
  readonly id: string;
  readonly docType: 'invoice' | 'bill';
  readonly docId: string;
  readonly docNumber: string | null;
  readonly amountCents: number;
}

export interface PaymentRow {
  readonly id: string;
  readonly number: string | null;
  readonly direction: 'in' | 'out';
  readonly partnerType: 'customer' | 'vendor';
  readonly partnerId: string;
  readonly partnerName: string;
  readonly date: string;
  readonly method: string;
  readonly reference: string | null;
  readonly amountCents: number;
  readonly unallocatedCents: number;
  readonly currency: string;
  readonly bankAccountId: string | null;
  readonly journalEntryId: string | null;
  readonly notes: string | null;
}

export interface PaymentDetail extends PaymentRow {
  readonly allocations: readonly PaymentAllocation[];
  /** Realised FX difference booked when the payment currency differs (BR-13). */
  readonly fxDifferenceCents: number;
}

// ── printable documents ──────────────────────────────────────────────────────

export type PrintableDocType =
  | 'invoice'
  | 'bill'
  | 'quote'
  | 'purchase_order'
  | 'delivery_note'
  | 'credit_note'
  | 'statement';

export interface PdfResult {
  readonly path: string;
  readonly pages: number;
}
