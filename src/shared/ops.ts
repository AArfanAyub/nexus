/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Shapes that cross IPC for T07 (inventory) and T08 (purchasing & sales).
 *
 * Lives in `shared/` rather than next to the services so the renderer can type
 * its pages without importing from the main process — the same rule `finance.ts`
 * follows. Conventions, unchanged from `finance.ts`:
 *
 *   - every money field ends in `Cents` and is an integer number of cents
 *   - every quantity ends in `Milli` and is an integer number of thousandths
 *   - dates are `YYYY-MM-DD`, timestamps are ISO 8601 with a `Z`
 *
 * A quantity is never a float and never a formatted string. `1.5 boxes` is
 * `1_500` milli; that is what makes `Σ qty` exact no matter how many moves a
 * product has accumulated.
 */

import type { Paged } from './types';

// ── inventory ────────────────────────────────────────────────────────────────

/**
 * The six legal move types.
 *
 * `receipt` / `production_in` add stock; `issue` / `production_out` remove it;
 * `transfer` moves it between locations of the same company (no journal);
 * `adjustment` is the only type whose quantity may be either sign, because a
 * stock count can go up as well as down.
 */
export type MoveType =
  | 'receipt'
  | 'issue'
  | 'transfer'
  | 'adjustment'
  | 'production_in'
  | 'production_out';

/** How a product is valued. `avco` is the moving average; `standard` is fixed. */
export type CostMethod = 'fifo' | 'avco' | 'standard';

export interface StockMoveInput {
  readonly type: MoveType;
  readonly productId: string;
  /** Source location. Required for `issue`, `transfer`, `production_out`. */
  readonly fromLocationId?: string;
  /** Destination location. Required for `receipt`, `transfer`, `production_in`. */
  readonly toLocationId?: string;
  /**
   * Signed quantity in milli. The type decides the legal sign:
   * receipt/production_in/transfer > 0 · issue/production_out < 0 ·
   * adjustment ≠ 0 (either sign).
   */
  readonly qtyMilli: number;
  /** Unit cost in cents. Defaults to the product's current cost for the location. */
  readonly unitCostCents?: number;
  /** Mandatory for `adjustment`, and for any negative-stock override. */
  readonly reason?: string;
  /** Defaults to today. */
  readonly movedAt?: string;
  readonly reference?: string;
  /** Unit of measure the quantity was entered in. Converted to base before storing. */
  readonly uom?: string;
  readonly sourceType?: string;
  readonly sourceId?: string;
  /**
   * Skip the per-move journal because the caller posts one aggregated entry for
   * the whole document (a goods receipt or a delivery). The move rows are then
   * back-linked to that entry, so `stock_moves.journal_entry_id` still resolves.
   */
  readonly suppressJournal?: boolean;
  /**
   * Set by the caller only when it already knows the operator holds
   * `inventory.stock.allow_negative`. The service re-checks the permission
   * itself and refuses an override that was not actually allowed.
   */
  readonly allowNegative?: boolean;
}

export interface StockMoveRow {
  readonly id: string;
  readonly movedAt: string;
  readonly type: MoveType;
  readonly reference: string | null;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly uom: string;
  readonly fromLocationId: string | null;
  readonly fromLocationName: string | null;
  readonly toLocationId: string | null;
  readonly toLocationName: string | null;
  readonly qtyMilli: number;
  readonly unitCostCents: number;
  readonly valueCents: number;
  readonly reason: string | null;
  readonly createdBy: string;
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly journalEntryId: string | null;
  readonly overrideReason: string | null;
}

/** A move plus the running balance of its product at the filtered location. */
export interface MoveHistoryRow extends StockMoveRow {
  readonly runningMilli: number;
}

export interface MoveFilter {
  readonly productId?: string;
  readonly locationId?: string;
  readonly type?: MoveType;
  readonly from?: string;
  readonly to?: string;
  readonly qtyOnly?: boolean;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface MoveResult {
  readonly move: StockMoveRow;
  readonly journalEntryId: string | null;
  readonly onHandMilli: number;
  readonly override: boolean;
}

export interface QuantRow {
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly uom: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly warehouseId: string;
  readonly warehouseName: string;
  readonly qtyMilli: number;
  readonly valueCents: number;
  readonly unitCostCents: number;
  readonly reorderPointMilli: number;
  readonly isLow: boolean;
}

export interface QuantFilter {
  readonly productId?: string;
  readonly locationId?: string;
  readonly warehouseId?: string;
  readonly q?: string;
  readonly lowOnly?: boolean;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface StockOverviewRow {
  readonly key: string;
  readonly label: string;
  readonly qtyMilli: number;
  readonly valueCents: number;
  readonly productCount: number;
}

export interface ValuationRow {
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly uom: string;
  readonly costMethod: CostMethod;
  readonly qtyMilli: number;
  readonly unitCostCents: number;
  readonly valueCents: number;
}

export interface ValuationReport {
  readonly asOf: string;
  readonly rows: readonly ValuationRow[];
  readonly totalQtyMilli: number;
  readonly totalValueCents: number;
}

export type AgingBucket = '0-30' | '31-60' | '61-90' | '90+';

export interface AgingRow {
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly bucket: AgingBucket;
  readonly qtyMilli: number;
  readonly valueCents: number;
}

export interface LowStockRow {
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly uom: string;
  readonly onHandMilli: number;
  readonly reorderPointMilli: number;
  readonly shortfallMilli: number;
}

export interface UomConversionRow {
  readonly id: string;
  readonly productId: string | null;
  readonly fromUom: string;
  readonly toUom: string;
  readonly factorMilli: number;
}

// ── purchasing ───────────────────────────────────────────────────────────────

export type PoStatus = 'draft' | 'confirmed' | 'partially_received' | 'received' | 'cancelled';
export type ReceiptStatus = 'draft' | 'posted' | 'cancelled';

export interface PoLineInput {
  readonly productId?: string;
  readonly description: string;
  readonly qtyMilli: number;
  readonly unitPriceCents: number;
  readonly taxId?: string;
}

export interface PoInput {
  readonly id?: string;
  readonly vendorId: string;
  readonly date: string;
  readonly expectedDate?: string;
  readonly warehouseId?: string;
  readonly notes?: string;
  readonly lines: readonly PoLineInput[];
}

export interface PoLineRow {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string | null;
  readonly sku: string | null;
  readonly description: string;
  readonly qtyMilli: number;
  readonly receivedMilli: number;
  readonly remainingMilli: number;
  readonly unitPriceCents: number;
  readonly taxId: string | null;
  readonly netCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
}

export interface PoRow {
  readonly id: string;
  readonly number: string | null;
  readonly vendorId: string;
  readonly vendorName: string;
  readonly date: string;
  readonly expectedDate: string | null;
  readonly status: PoStatus;
  readonly currency: string;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly orderedMilli: number;
  readonly receivedMilli: number;
  readonly lineCount: number;
}

export interface PoDetail extends PoRow {
  readonly notes: string | null;
  readonly warehouseId: string | null;
  readonly lines: readonly PoLineRow[];
  readonly receiptIds: readonly string[];
  readonly billIds: readonly string[];
}

export interface PoFilter {
  readonly vendorId?: string;
  readonly status?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface ReceiptLineInput {
  readonly poLineId?: string;
  readonly productId: string;
  readonly qtyMilli: number;
  readonly unitCostCents?: number;
  readonly lotRef?: string;
}

export interface ReceiptInput {
  readonly id?: string;
  readonly poId?: string;
  readonly vendorId: string;
  readonly date: string;
  readonly warehouseId: string;
  readonly locationId?: string;
  readonly notes?: string;
  readonly lines: readonly ReceiptLineInput[];
}

export interface ReceiptLineRow {
  readonly id: string;
  readonly lineNo: number;
  readonly poLineId: string | null;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly qtyMilli: number;
  readonly unitCostCents: number;
  readonly valueCents: number;
  readonly poPriceCents: number | null;
}

export interface ReceiptRow {
  readonly id: string;
  readonly number: string | null;
  readonly poId: string | null;
  readonly poNumber: string | null;
  readonly vendorId: string;
  readonly vendorName: string;
  readonly date: string;
  readonly status: ReceiptStatus;
  readonly warehouseId: string;
  readonly warehouseName: string;
  readonly locationId: string | null;
  readonly locationName: string | null;
  readonly totalCents: number;
  readonly billId: string | null;
}

export interface ReceiptDetail extends ReceiptRow {
  readonly notes: string | null;
  readonly lines: readonly ReceiptLineRow[];
  readonly journalEntryId: string | null;
}

export interface ReceiptFilter {
  readonly poId?: string;
  readonly vendorId?: string;
  readonly status?: string;
  readonly from?: string;
  readonly to?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

/** One line of a three-way match. `status` is what the badge shows. */
export interface MatchLine {
  readonly billLineId: string;
  readonly description: string;
  readonly billedMilli: number;
  readonly receivedMilli: number;
  readonly poPriceCents: number | null;
  readonly billPriceCents: number;
  readonly priceDeltaBp: number;
  readonly totalDeltaCents: number;
  readonly status: 'ok' | 'qty' | 'price';
  readonly note: string | null;
}

export interface MatchResult {
  readonly withinTolerance: boolean;
  readonly lines: readonly MatchLine[];
  readonly reasons: readonly string[];
  readonly toleranceBp: number;
  readonly toleranceAbsCents: number;
}

export interface VendorStatementRow {
  readonly id: string;
  readonly number: string | null;
  readonly date: string;
  readonly dueDate: string;
  readonly status: string;
  readonly totalCents: number;
  readonly paidCents: number;
  readonly openCents: number;
  readonly daysOverdue: number;
}

export interface VendorStatement {
  readonly vendorId: string;
  readonly vendorName: string;
  readonly termsDays: number;
  readonly currency: string;
  readonly from: string;
  readonly to: string;
  readonly rows: readonly VendorStatementRow[];
  readonly billedCents: number;
  readonly paidCents: number;
  readonly openCents: number;
  readonly overdueCents: number;
}

export interface PurchaseAnalysisRow {
  readonly key: string;
  readonly label: string;
  readonly orderCents: number;
  readonly billedCents: number;
  readonly documentCount: number;
  readonly qtyMilli: number;
}

// ── sales ────────────────────────────────────────────────────────────────────

/**
 * Where a price came from, in resolution order. The UI prints this next to the
 * number so an operator can see that a line was overridden and by which list.
 */
export type PriceSource = 'contract' | 'customer_list' | 'default_list' | 'base';

export interface PriceResolution {
  readonly productId: string;
  readonly priceCents: number;
  readonly source: PriceSource;
  readonly listId: string | null;
  readonly listName: string | null;
  readonly qtyMilli: number;
}

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'converted' | 'expired';
export type SoStatus = 'draft' | 'confirmed' | 'partially_delivered' | 'delivered' | 'invoiced' | 'cancelled';
export type DeliveryStatus = 'draft' | 'posted' | 'cancelled';

export interface SaleLineInput {
  readonly productId?: string;
  readonly description: string;
  readonly qtyMilli: number;
  readonly unitPriceCents: number;
  readonly discountBp?: number;
  readonly taxId?: string;
  readonly priceSource?: PriceSource;
}

export interface QuoteInput {
  readonly id?: string;
  readonly customerId: string;
  readonly date: string;
  readonly expiryDate: string;
  readonly notes?: string;
  readonly terms?: string;
  readonly lines: readonly SaleLineInput[];
}

export interface SaleLineRow {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string | null;
  readonly sku: string | null;
  readonly description: string;
  readonly qtyMilli: number;
  readonly deliveredMilli: number;
  readonly invoicedMilli: number;
  readonly remainingMilli: number;
  readonly toInvoiceMilli: number;
  readonly unitPriceCents: number;
  readonly discountBp: number;
  readonly taxId: string | null;
  readonly priceSource: string;
  readonly netCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
}

export interface QuoteRow {
  readonly id: string;
  readonly number: string | null;
  readonly customerId: string;
  readonly customerName: string;
  readonly date: string;
  readonly expiryDate: string;
  readonly status: QuoteStatus;
  readonly isExpired: boolean;
  readonly currency: string;
  readonly totalCents: number;
  readonly convertedOrderId: string | null;
  readonly lineCount: number;
}

export interface QuoteDetail extends QuoteRow {
  readonly notes: string | null;
  readonly terms: string | null;
  readonly lines: readonly SaleLineRow[];
  readonly orderIds: readonly string[];
}

export interface SoInput {
  readonly id?: string;
  readonly customerId: string;
  readonly date: string;
  readonly warehouseId?: string;
  readonly notes?: string;
  readonly terms?: string;
  readonly quoteId?: string;
  readonly lines: readonly SaleLineInput[];
}

export interface SoRow {
  readonly id: string;
  readonly number: string | null;
  readonly customerId: string;
  readonly customerName: string;
  readonly date: string;
  readonly status: SoStatus;
  readonly currency: string;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly orderedMilli: number;
  readonly deliveredMilli: number;
  readonly invoicedMilli: number;
  readonly quoteId: string | null;
  readonly lineCount: number;
}

export interface SoDetail extends SoRow {
  readonly notes: string | null;
  readonly terms: string | null;
  readonly warehouseId: string | null;
  readonly lines: readonly SaleLineRow[];
  readonly deliveryIds: readonly string[];
  readonly invoiceIds: readonly string[];
}

export interface SalesFilter {
  readonly customerId?: string;
  readonly status?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface DeliveryLineInput {
  readonly soLineId?: string;
  readonly productId: string;
  readonly qtyMilli: number;
}

export interface DeliveryInput {
  readonly id?: string;
  readonly orderId?: string;
  readonly customerId: string;
  readonly date: string;
  readonly warehouseId: string;
  readonly notes?: string;
  readonly lines: readonly DeliveryLineInput[];
}

export interface DeliveryLineRow {
  readonly id: string;
  readonly soLineId: string | null;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly qtyMilli: number;
  readonly unitCostCents: number;
  readonly valueCents: number;
}

export interface DeliveryRow {
  readonly id: string;
  readonly number: string | null;
  readonly orderId: string | null;
  readonly orderNumber: string | null;
  readonly customerId: string;
  readonly customerName: string;
  readonly date: string;
  readonly status: DeliveryStatus;
  readonly warehouseName: string;
  readonly totalCostCents: number;
  readonly invoiceId: string | null;
}

export interface DeliveryDetail extends DeliveryRow {
  readonly notes: string | null;
  readonly lines: readonly DeliveryLineRow[];
  readonly journalEntryId: string | null;
}

export interface CustomerOutstanding {
  readonly customerId: string;
  readonly name: string;
  readonly termsDays: number;
  readonly creditLimitCents: number;
  readonly outstandingCents: number;
  readonly overdueCents: number;
  readonly openCount: number;
  readonly overLimit: boolean;
}

export interface PriceListRow {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly isExpired: boolean;
  readonly itemCount: number;
}

export interface PriceListItemRow {
  readonly id: string;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly priceCents: number;
  readonly minQtyMilli: number;
}

export interface PriceListDetail extends PriceListRow {
  readonly items: readonly PriceListItemRow[];
}

/** Result of confirming an order that would breach the customer's credit limit. */
export interface CreditCheck {
  readonly withinLimit: boolean;
  readonly creditLimitCents: number;
  readonly outstandingCents: number;
  readonly orderCents: number;
  readonly excessCents: number;
  readonly message: string | null;
}

export type PagedResult<T> = Paged<T>;
