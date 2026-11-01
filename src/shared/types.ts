/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Every cross-process data shape lives here. Both the main process and the
 * renderer import this file, so it must stay free of Node and DOM APIs.
 *
 * Naming (CONVENTIONS §3): money variables end in `Cents`, quantities in
 * `Milli`, rates in `Bp`. Timestamps are ISO-8601 UTC strings, date-only
 * columns are `YYYY-MM-DD`. `Date` objects never appear in a DTO.
 */

import type { Permission } from './permissions';

// ── envelopes ────────────────────────────────────────────────────────────────

/** The only error codes the renderer is allowed to branch on (CONVENTIONS §6). */
export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'LICENSE'
  | 'INTERNAL';

/** Wire shape of a failure. `message` is always a human sentence. */
export interface NexusError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

/** The envelope every channel returns. */
export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: NexusError };

/** Offset-paged result for every list channel. */
export interface Paged<T> {
  readonly rows: readonly T[];
  readonly total: number;
}

/**
 * The hard ceiling on any single list page (R1).
 *
 * It lives here so the validator and every caller read the same number. It used
 * to be a literal `200` in the schema while three screens asked for `500`, so
 * those requests were rejected with `VALIDATION: Must be 200 or less` and the
 * rejection was swallowed by the query hook — the dropdown simply stayed empty
 * and the user was told "a destination location is required". A single exported
 * constant is the only way to keep the two ends from drifting apart again.
 */
export const MAX_PAGE_SIZE = 200;

/** Sort + filter + paging payload shared by the entity family. */
export interface ListQuery {
  readonly q?: string;
  readonly filters?: Readonly<Record<string, string | number | boolean | null>>;
  readonly sort?: { readonly key: string; readonly dir: 'asc' | 'desc' };
  readonly limit?: number;
  readonly offset?: number;
  readonly viewId?: string;
}

// ── identity & access ────────────────────────────────────────────────────────

export interface UserPrefs {
  readonly theme?: 'light' | 'dark';
  readonly density?: 'compact' | 'comfortable';
  readonly accent?: 'blue' | 'teal' | 'violet' | 'amber';
  readonly sidebarCollapsed?: boolean;
  readonly locale?: string;
  /** US-04: the Community-edition notice stays dismissed across restarts. */
  readonly licenseNoticeDismissed?: boolean;
}

export interface User {
  readonly id: string;
  readonly username: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly isActive: boolean;
  readonly isOwner: boolean;
  readonly mustChangePassword: boolean;
  readonly roleIds: readonly string[];
  readonly prefs: UserPrefs;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Role {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly permissions: readonly Permission[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `auth.login` / `auth.unlock` — what the renderer needs to open a session. */
export interface LoginResult {
  readonly user: User;
  readonly permissions: readonly Permission[];
  readonly sessionId: string;
}

/** A live login. Never leaves the main process except as `SessionSummary`. */
export interface Session {
  readonly token: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly locked: boolean;
  readonly startedAt: string;
  readonly lastSeenAt: string;
}

/** What the renderer may know about the session (`auth.session`, `app.bootstrap`). */
export interface SessionSummary {
  readonly user: User | null;
  readonly locked: boolean;
  readonly idleTimeoutMin: number;
  readonly lastSeenAt: string | null;
}

// ── configuration ────────────────────────────────────────────────────────────

export interface Address {
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly region?: string;
  readonly postcode?: string;
  readonly country?: string;
}

export interface Company {
  readonly id: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly taxId: string | null;
  readonly address: Address | null;
  readonly logoPath: string | null;
  readonly baseCurrency: string;
  readonly fiscalYearStartMonth: number;
  readonly dateFormat: string;
  readonly numberFormat: string;
  readonly industryPreset: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SecurityPolicy {
  readonly idleTimeoutMin: number;
  readonly minPasswordLength: number;
  readonly requireSymbol: boolean;
  readonly maxAttempts: number;
  readonly lockoutMin: number;
}

export interface Tax {
  readonly id: string;
  readonly name: string;
  readonly rateBp: number;
  readonly isInclusive: boolean;
  readonly isCompound: boolean;
  readonly accountId: string | null;
  readonly isArchived: boolean;
}

export interface Currency {
  readonly code: string;
  readonly name: string;
  readonly symbol: string | null;
  readonly decimals: number;
  readonly rateBp: number;
  readonly isBase: boolean;
  readonly updatedAt: string;
}

export interface Sequence {
  readonly docType: string;
  readonly fiscalYearId: string;
  readonly prefix: string;
  readonly padding: number;
  readonly nextValue: number;
  readonly suffix: string;
}

/** The closed set of custom-field kinds (mirrors the `custom_fields.type` CHECK). */
export type CustomFieldType = 'text' | 'number' | 'money' | 'date' | 'select' | 'bool';

export interface CustomField {
  readonly id: string;
  readonly entity: string;
  readonly key: string;
  readonly label: string;
  readonly type: CustomFieldType;
  readonly isRequired: boolean;
  readonly options: readonly string[] | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface Period {
  readonly id: string;
  readonly fiscalYearId: string;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: 'open' | 'locked';
  readonly lockedAt: string | null;
  readonly lockedBy: string | null;
}

// ── general ledger ───────────────────────────────────────────────────────────

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface Account {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly parentId: string | null;
  readonly isPostable: boolean;
  readonly currency: string | null;
  readonly isArchived: boolean;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** COA tree node with a rolled-up balance. */
export interface AccountNode extends Account {
  readonly balanceCents: number;
  readonly children: readonly AccountNode[];
}

export type JournalType = 'general' | 'sales' | 'purchase' | 'bank' | 'cash' | 'stock';

export interface Journal {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: JournalType;
  readonly defaultAccountId: string | null;
  readonly isActive: boolean;
}

export type DocumentStatus =
  | 'draft'
  | 'posted'
  | 'partially_paid'
  | 'paid'
  | 'void'
  | 'cancelled'
  | 'confirmed'
  | 'partially_received'
  | 'received'
  | 'partially_delivered'
  | 'delivered'
  | 'invoiced'
  | 'match_exception';

/** What a `Drawer` header needs to show a status chip (§E.4). */
export interface StatusChipSpec {
  readonly status: string;
  readonly label: string;
}

export interface JournalLine {
  readonly id: string;
  readonly entryId: string;
  readonly lineNo: number;
  readonly accountId: string;
  readonly debitCents: number;
  readonly creditCents: number;
  readonly description: string | null;
  readonly partnerType: 'customer' | 'vendor' | null;
  readonly partnerId: string | null;
  readonly taxId: string | null;
}

export interface JournalEntry {
  readonly id: string;
  readonly number: string | null;
  readonly journalId: string;
  readonly date: string;
  readonly periodId: string;
  readonly memo: string | null;
  readonly status: 'draft' | 'posted' | 'reversed';
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly reversesId: string | null;
  readonly postedAt: string | null;
  readonly postedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly JournalLine[];
}

// ── AR / AP ──────────────────────────────────────────────────────────────────

export interface InvoiceLine {
  readonly id: string;
  readonly invoiceId: string;
  readonly lineNo: number;
  readonly productId: string | null;
  readonly description: string;
  readonly qtyMilli: number;
  readonly unitPriceCents: number;
  readonly discountBp: number;
  readonly taxId: string | null;
  readonly netCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly accountId: string | null;
}

export interface Invoice {
  readonly id: string;
  readonly number: string | null;
  readonly customerId: string;
  readonly date: string;
  readonly dueDate: string;
  readonly status: DocumentStatus;
  readonly currency: string;
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly paidCents: number;
  readonly notes: string | null;
  readonly terms: string | null;
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly journalEntryId: string | null;
  readonly periodId: string | null;
  readonly custom: Readonly<Record<string, unknown>>;
  readonly postedAt: string | null;
  readonly postedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines?: readonly InvoiceLine[];
}

export interface BillLine {
  readonly id: string;
  readonly billId: string;
  readonly lineNo: number;
  readonly productId: string | null;
  readonly description: string;
  readonly qtyMilli: number;
  readonly unitPriceCents: number;
  readonly taxId: string | null;
  readonly accountId: string | null;
  readonly poPriceCents: number | null;
  readonly receivedQtyMilli: number | null;
  readonly netCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly matchStatus: 'ok' | 'qty_exceeds' | 'price_variance' | 'unmatched';
}

export interface Bill {
  readonly id: string;
  readonly number: string | null;
  readonly vendorId: string;
  readonly vendorRef: string | null;
  readonly date: string;
  readonly dueDate: string;
  readonly status: DocumentStatus;
  readonly currency: string;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly paidCents: number;
  readonly poId: string | null;
  readonly receiptIds: readonly string[];
  readonly matchState: string;
  readonly exceptionReason: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly notes: string | null;
  readonly journalEntryId: string | null;
  readonly periodId: string | null;
  readonly postedAt: string | null;
  readonly postedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines?: readonly BillLine[];
}

/** Line-level 3-way match outcome (US-31, BR-13/14). */
export interface MatchReport {
  readonly ok: boolean;
  readonly toleranceBp: number;
  readonly toleranceCents: number;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly description: string;
    readonly billedMilli: number;
    readonly receivedMilli: number;
    readonly poPriceCents: number | null;
    readonly billPriceCents: number;
    readonly varianceBp: number;
    readonly passed: boolean;
    readonly reason: string | null;
  }[];
}

export type PaymentDirection = 'in' | 'out';

export interface PaymentAllocation {
  readonly id: string;
  readonly paymentId: string;
  readonly docType: 'invoice' | 'bill';
  readonly docId: string;
  readonly amountCents: number;
  readonly createdAt: string;
}

export interface Payment {
  readonly id: string;
  readonly number: string | null;
  readonly direction: PaymentDirection;
  readonly partnerType: 'customer' | 'vendor';
  readonly partnerId: string;
  readonly date: string;
  readonly method: string;
  readonly reference: string | null;
  readonly amountCents: number;
  readonly unallocatedCents: number;
  readonly currency: string;
  readonly bankAccountId: string | null;
  readonly journalEntryId: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly allocations?: readonly PaymentAllocation[];
}

// ── partners & catalogue ─────────────────────────────────────────────────────

export interface Customer {
  readonly id: string;
  readonly code: string | null;
  readonly name: string;
  readonly legalName: string | null;
  readonly taxId: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: Address | null;
  readonly paymentTermsDays: number;
  readonly priceListId: string | null;
  readonly creditLimitCents: number;
  readonly currency: string | null;
  readonly isActive: boolean;
  readonly notes: string | null;
  readonly custom: Readonly<Record<string, unknown>>;
  readonly crmAccountId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Vendor {
  readonly id: string;
  readonly code: string | null;
  readonly name: string;
  readonly legalName: string | null;
  readonly taxId: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: Address | null;
  readonly paymentTermsDays: number;
  readonly currency: string | null;
  readonly isActive: boolean;
  readonly notes: string | null;
  readonly custom: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CostMethod = 'fifo' | 'avco' | 'standard';

export interface Product {
  readonly id: string;
  readonly sku: string;
  readonly barcode: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly uom: string;
  readonly category: string | null;
  readonly costMethod: CostMethod;
  readonly standardCostCents: number;
  readonly basePriceCents: number;
  readonly taxId: string | null;
  readonly reorderPointMilli: number;
  readonly isStockTracked: boolean;
  readonly isActive: boolean;
  readonly incomeAccountId: string | null;
  readonly expenseAccountId: string | null;
  readonly inventoryAccountId: string | null;
  readonly custom: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Warehouse {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly address: Address | null;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StockLocation {
  readonly id: string;
  readonly warehouseId: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
}

export type StockMoveType = 'receipt' | 'issue' | 'transfer' | 'adjustment';

export interface StockMove {
  readonly id: string;
  readonly reference: string | null;
  readonly type: StockMoveType;
  readonly productId: string;
  readonly fromLocationId: string | null;
  readonly toLocationId: string | null;
  readonly qtyMilli: number;
  readonly unitCostCents: number;
  readonly valueCents: number;
  readonly reason: string | null;
  readonly status: string;
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly movedAt: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** Derived cache of `stock_moves` — never written by a user action (BR-10). */
export interface StockQuant {
  readonly productId: string;
  readonly locationId: string;
  readonly qtyMilli: number;
  readonly valueCents: number;
}

export interface QuantRow extends StockQuant {
  readonly sku: string;
  readonly productName: string;
  readonly warehouseId: string;
  readonly warehouseName: string;
  readonly locationCode: string;
  readonly reorderPointMilli: number;
}

// ── purchasing ───────────────────────────────────────────────────────────────

export interface PurchaseOrderLine {
  readonly id: string;
  readonly poId: string;
  readonly lineNo: number;
  readonly productId: string | null;
  readonly description: string;
  readonly qtyMilli: number;
  readonly receivedMilli: number;
  readonly unitPriceCents: number;
  readonly taxId: string | null;
  readonly netCents: number;
  readonly taxCents: number;
}

export interface PurchaseOrder {
  readonly id: string;
  readonly number: string | null;
  readonly vendorId: string;
  readonly date: string;
  readonly expectedDate: string | null;
  readonly status: DocumentStatus;
  readonly currency: string;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly warehouseId: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines?: readonly PurchaseOrderLine[];
}

export interface GoodsReceiptLine {
  readonly id: string;
  readonly receiptId: string;
  readonly lineNo: number;
  readonly poLineId: string | null;
  readonly productId: string;
  readonly qtyMilli: number;
  readonly unitCostCents: number;
  readonly poPriceCents: number | null;
  readonly lotRef: string | null;
}

export interface GoodsReceipt {
  readonly id: string;
  readonly number: string | null;
  readonly poId: string | null;
  readonly vendorId: string;
  readonly date: string;
  readonly status: 'draft' | 'posted' | 'cancelled';
  readonly warehouseId: string;
  readonly locationId: string | null;
  readonly notes: string | null;
  readonly postedAt: string | null;
  readonly postedBy: string | null;
  readonly billId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines?: readonly GoodsReceiptLine[];
}

// ── sales ────────────────────────────────────────────────────────────────────

export interface QuoteLine {
  readonly id: string;
  readonly quoteId: string;
  readonly lineNo: number;
  readonly productId: string | null;
  readonly description: string;
  readonly qtyMilli: number;
  readonly unitPriceCents: number;
  readonly discountBp: number;
  readonly taxId: string | null;
  readonly priceSource: 'contract' | 'customer' | 'default' | 'base' | 'manual';
  readonly netCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
}

export interface Quote {
  readonly id: string;
  readonly number: string | null;
  readonly customerId: string;
  readonly date: string;
  readonly expiryDate: string;
  readonly status: 'draft' | 'sent' | 'accepted' | 'rejected' | 'converted' | 'expired';
  readonly currency: string;
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly notes: string | null;
  readonly terms: string | null;
  readonly convertedOrderId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines?: readonly QuoteLine[];
}

export interface SalesOrderLine {
  readonly id: string;
  readonly orderId: string;
  readonly lineNo: number;
  readonly productId: string | null;
  readonly description: string;
  readonly qtyMilli: number;
  readonly deliveredMilli: number;
  readonly invoicedMilli: number;
  readonly unitPriceCents: number;
  readonly discountBp: number;
  readonly taxId: string | null;
  readonly netCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
}

export interface SalesOrder {
  readonly id: string;
  readonly number: string | null;
  readonly customerId: string;
  readonly quoteId: string | null;
  readonly dealId: string | null;
  readonly date: string;
  readonly status: DocumentStatus;
  readonly currency: string;
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly warehouseId: string | null;
  readonly notes: string | null;
  readonly terms: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines?: readonly SalesOrderLine[];
}

export interface SalesDelivery {
  readonly id: string;
  readonly number: string | null;
  readonly orderId: string | null;
  readonly customerId: string;
  readonly date: string;
  readonly status: 'draft' | 'posted' | 'cancelled';
  readonly warehouseId: string;
  readonly notes: string | null;
  readonly postedAt: string | null;
  readonly postedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PriceList {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly isDefault: boolean;
  readonly isActive: boolean;
}

export interface PriceListItem {
  readonly id: string;
  readonly priceListId: string;
  readonly productId: string;
  readonly priceCents: number;
  readonly minQtyMilli: number;
}

// ── CRM ──────────────────────────────────────────────────────────────────────

export interface Pipeline {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PipelineStage {
  readonly id: string;
  readonly pipelineId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly probabilityBp: number;
  readonly isWon: boolean;
  readonly isLost: boolean;
}

export interface CrmAccount {
  readonly id: string;
  readonly name: string;
  readonly industry: string | null;
  readonly website: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: Address | null;
  readonly ownerId: string | null;
  readonly customerId: string | null;
  readonly source: string | null;
  readonly annualRevenueCents: number | null;
  readonly employees: number | null;
  readonly notes: string | null;
  readonly custom: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Contact {
  readonly id: string;
  readonly accountId: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly title: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly mobile: string | null;
  readonly isPrimary: boolean;
  readonly notes: string | null;
  readonly custom: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A lead is either still being worked, converted, or lost. `lost` replaced v1's
 * `disqualified` because a lead nobody has called is not the same as one that was
 * rejected, and the inbox has to be able to tell them apart.
 */
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'converted' | 'lost';

export interface Lead {
  readonly id: string;
  readonly name: string;
  readonly company: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly source: string | null;
  readonly status: LeadStatus;
  /** 0–100, used to sort the inbox. Set by hand or by the conversion wizard. */
  readonly score: number;
  readonly estimatedValueCents: number;
  readonly ownerId: string | null;
  readonly notes: string | null;
  readonly lossReason: string | null;
  readonly convertedAccountId: string | null;
  readonly convertedContactId: string | null;
  readonly convertedDealId: string | null;
  readonly convertedAt: string | null;
  readonly custom: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DealStatus = 'open' | 'won' | 'lost';

export interface Deal {
  readonly id: string;
  readonly name: string;
  readonly accountId: string | null;
  readonly pipelineId: string;
  readonly stageId: string;
  readonly ownerId: string | null;
  readonly valueCents: number;
  readonly currency: string;
  readonly probabilityBp: number;
  readonly expectedCloseDate: string | null;
  readonly status: DealStatus;
  readonly lostReason: string | null;
  readonly wonAt: string | null;
  readonly lostAt: string | null;
  readonly leadId: string | null;
  readonly salesOrderId: string | null;
  readonly stageChangedAt: string;
  readonly custom: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One kanban column with its derived totals (US-40/41). */
export interface StageColumn {
  readonly stageId: string;
  readonly name: string;
  readonly probabilityBp: number;
  readonly count: number;
  readonly sumCents: number;
  readonly weightedCents: number;
  readonly deals: readonly Deal[];
}

export type ActivityType =
  | 'call'
  | 'email'
  | 'meeting'
  | 'task'
  | 'note'
  | 'stage_changed'
  | 'system';

export interface Activity {
  readonly id: string;
  readonly type: ActivityType;
  readonly subject: string;
  readonly body: string | null;
  readonly entity: string;
  readonly entityId: string;
  readonly ownerId: string | null;
  readonly dueAt: string | null;
  readonly completedAt: string | null;
  readonly isDone: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface LossReason {
  readonly id: string;
  readonly label: string;
  readonly isActive: boolean;
}

// ── audit, licence, notifications ────────────────────────────────────────────

export interface AuditEntry {
  readonly seq: number;
  readonly id: string;
  readonly actorId: string | null;
  readonly actorName: string;
  readonly at: string;
  readonly entity: string;
  readonly entityId: string | null;
  readonly action: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly meta: unknown;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AuditQuery {
  readonly actorId?: string;
  readonly entity?: string;
  readonly entityId?: string;
  readonly action?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AuditChainResult {
  readonly ok: boolean;
  readonly checked: number;
  readonly brokenAtSeq?: number;
}

export type LicenseEdition = 'community' | 'pro' | 'enterprise';

export interface LicenseState {
  readonly edition: LicenseEdition;
  readonly licensee: string | null;
  readonly email: string | null;
  readonly seats: number;
  readonly features: readonly string[];
  readonly machineId: string;
  readonly keyHash: string | null;
  readonly activatedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly suspectClock: boolean;
  readonly updatedAt: string;
}

/** `license.*` responses. `expiresAt` is always null: the licence is perpetual. */
export interface LicenseStatus extends LicenseState {
  readonly expiresAt: null;
  readonly suspectClock: boolean;
}

export interface Notification {
  readonly id: string;
  readonly userId: string | null;
  readonly kind: string;
  readonly title: string;
  readonly body: string | null;
  readonly link: string | null;
  readonly severity: 'info' | 'success' | 'warning' | 'danger';
  readonly readAt: string | null;
  readonly createdAt: string;
}

// ── bootstrap ────────────────────────────────────────────────────────────────

/** `app.bootstrap` — the one call that decides what the shell may render. */
export interface BootstrapResult {
  /** True until onboarding has created a company and an owner. */
  readonly initialised: boolean;
  /** Alias of `initialised` used by ARCHITECTURE §C.3. */
  readonly needsOnboarding: boolean;
  readonly session: SessionSummary;
  readonly user: User | null;
  readonly permissions: readonly Permission[];
  readonly company: Company | null;
  readonly license: LicenseStatus;
  readonly prefs: UserPrefs;
  readonly suspectClock: boolean;
  readonly edition: LicenseEdition;
  readonly features: readonly string[];
  readonly modules: readonly string[];
  readonly theme: 'light' | 'dark';
  readonly density: 'compact' | 'comfortable';
  readonly platform: NodePlatform;
  readonly version: string;
}

export type NodePlatform = 'aix' | 'darwin' | 'freebsd' | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'android';

// ── entity registry (§C.2) ───────────────────────────────────────────────────

export type EntityName =
  | 'accounts'
  | 'journals'
  | 'invoices'
  | 'bills'
  | 'payments'
  | 'taxes'
  | 'currencies'
  | 'products'
  | 'warehouses'
  | 'locations'
  | 'customers'
  | 'vendors'
  | 'quotes'
  | 'salesOrders'
  | 'priceLists'
  | 'crmAccounts'
  | 'contacts'
  | 'leads'
  | 'deals'
  | 'activities'
  | 'users'
  | 'roles'
  | 'customFields'
  | 'savedViews';

export interface EntityMeta {
  readonly name: EntityName;
  /** SQL table backing the entity. */
  readonly table: string;
  readonly module: string;
  readonly label: string;
  readonly read: Permission;
  readonly write: Permission;
  /** `null` means the entity may never be deleted, only archived. */
  readonly remove: Permission | null;
  /** True when the table carries `deleted_at` (soft delete). */
  readonly softDelete: boolean;
}

/**
 * The metadata that makes `entity.*` a single generic family over 24 tables
 * (decision D-02). Permissions here are what `entity.*` resolves at dispatch.
 */
export const ENTITIES: Readonly<Record<EntityName, EntityMeta>> = {
  accounts: {
    name: 'accounts',
    table: 'accounts',
    module: 'finance',
    label: 'Account',
    read: 'finance.account.read',
    write: 'finance.account.write',
    remove: 'finance.account.delete',
    softDelete: true,
  },
  journals: {
    name: 'journals',
    table: 'journals',
    module: 'finance',
    label: 'Journal',
    read: 'finance.journal.read',
    write: 'finance.journal.write',
    remove: null,
    softDelete: false,
  },
  invoices: {
    name: 'invoices',
    table: 'invoices',
    module: 'finance',
    label: 'Invoice',
    read: 'finance.invoice.read',
    write: 'finance.invoice.create',
    remove: null,
    softDelete: false,
  },
  bills: {
    name: 'bills',
    table: 'bills',
    module: 'finance',
    label: 'Bill',
    read: 'finance.bill.read',
    write: 'finance.bill.create',
    remove: null,
    softDelete: false,
  },
  payments: {
    name: 'payments',
    table: 'payments',
    module: 'finance',
    label: 'Payment',
    read: 'finance.payment.read',
    write: 'finance.payment.create',
    remove: null,
    softDelete: false,
  },
  taxes: {
    name: 'taxes',
    table: 'taxes',
    module: 'settings',
    label: 'Tax rate',
    read: 'settings.tax.read',
    write: 'settings.tax.manage',
    remove: 'settings.tax.manage',
    softDelete: false,
  },
  currencies: {
    name: 'currencies',
    table: 'currencies',
    module: 'settings',
    label: 'Currency',
    read: 'settings.currency.read',
    write: 'settings.currency.manage',
    remove: null,
    softDelete: false,
  },
  products: {
    name: 'products',
    table: 'products',
    module: 'inventory',
    label: 'Product',
    read: 'inventory.product.read',
    write: 'inventory.product.write',
    remove: 'inventory.product.delete',
    softDelete: true,
  },
  warehouses: {
    name: 'warehouses',
    table: 'warehouses',
    module: 'inventory',
    label: 'Warehouse',
    read: 'inventory.warehouse.read',
    write: 'inventory.warehouse.write',
    remove: 'inventory.warehouse.delete',
    softDelete: false,
  },
  locations: {
    name: 'locations',
    table: 'locations',
    module: 'inventory',
    label: 'Location',
    read: 'inventory.warehouse.read',
    write: 'inventory.warehouse.write',
    remove: 'inventory.warehouse.delete',
    softDelete: false,
  },
  customers: {
    name: 'customers',
    table: 'customers',
    module: 'sales',
    label: 'Customer',
    read: 'sales.customer.read',
    write: 'sales.customer.write',
    remove: 'sales.customer.delete',
    softDelete: true,
  },
  vendors: {
    name: 'vendors',
    table: 'vendors',
    module: 'purchasing',
    label: 'Vendor',
    read: 'purchasing.vendor.read',
    write: 'purchasing.vendor.write',
    remove: 'purchasing.vendor.delete',
    softDelete: true,
  },
  quotes: {
    name: 'quotes',
    table: 'quotes',
    module: 'sales',
    label: 'Quotation',
    read: 'sales.quotation.read',
    write: 'sales.quotation.create',
    remove: null,
    softDelete: false,
  },
  salesOrders: {
    name: 'salesOrders',
    table: 'sales_orders',
    module: 'sales',
    label: 'Sales order',
    read: 'sales.order.read',
    write: 'sales.order.create',
    remove: null,
    softDelete: false,
  },
  priceLists: {
    name: 'priceLists',
    table: 'price_lists',
    module: 'sales',
    label: 'Price list',
    read: 'sales.pricelist.read',
    write: 'sales.pricelist.manage',
    remove: 'sales.pricelist.manage',
    softDelete: false,
  },
  crmAccounts: {
    name: 'crmAccounts',
    table: 'crm_accounts',
    module: 'crm',
    label: 'Account',
    read: 'crm.account.read',
    write: 'crm.account.write',
    remove: 'crm.account.delete',
    softDelete: true,
  },
  contacts: {
    name: 'contacts',
    table: 'contacts',
    module: 'crm',
    label: 'Contact',
    read: 'crm.contact.read',
    write: 'crm.contact.write',
    remove: 'crm.contact.delete',
    softDelete: true,
  },
  leads: {
    name: 'leads',
    table: 'leads',
    module: 'crm',
    label: 'Lead',
    read: 'crm.lead.read',
    write: 'crm.lead.write',
    remove: 'crm.lead.delete',
    softDelete: false,
  },
  deals: {
    name: 'deals',
    table: 'deals',
    module: 'crm',
    label: 'Deal',
    read: 'crm.deal.read',
    write: 'crm.deal.write',
    remove: 'crm.deal.delete',
    softDelete: true,
  },
  activities: {
    name: 'activities',
    table: 'activities',
    module: 'crm',
    label: 'Activity',
    read: 'crm.activity.read',
    write: 'crm.activity.write',
    remove: 'crm.activity.delete',
    softDelete: false,
  },
  users: {
    name: 'users',
    table: 'users',
    module: 'settings',
    label: 'User',
    read: 'settings.user.read',
    write: 'settings.user.manage',
    remove: null,
    softDelete: true,
  },
  roles: {
    name: 'roles',
    table: 'roles',
    module: 'settings',
    label: 'Role',
    read: 'settings.role.read',
    write: 'settings.role.manage',
    remove: 'settings.role.manage',
    softDelete: true,
  },
  customFields: {
    name: 'customFields',
    table: 'custom_fields',
    module: 'settings',
    label: 'Custom field',
    read: 'settings.custom_field.read',
    write: 'settings.custom_field.manage',
    remove: 'settings.custom_field.manage',
    softDelete: false,
  },
  savedViews: {
    name: 'savedViews',
    table: 'saved_views',
    module: 'app',
    label: 'Saved view',
    read: 'app.view.read',
    write: 'app.view.write',
    remove: 'app.view.write',
    softDelete: false,
  },
};

/** Runtime list of entity names, used to validate `entity.*` payloads. */
export const ENTITY_NAMES: readonly EntityName[] = Object.keys(ENTITIES) as EntityName[];

/** Type guard for the `entity` field of a generic payload. */
export function isEntityName(value: string): value is EntityName {
  return Object.prototype.hasOwnProperty.call(ENTITIES, value);
}
