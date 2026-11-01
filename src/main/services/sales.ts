/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Sales: customers → price lists → quotations → orders → deliveries → invoices
 * (T08, US-33…US-37, BR-17/18).
 *
 * ## Price resolution
 *
 * The order is **contract → customer list → default list → base**, and an expired
 * list is skipped rather than clamped (BR-17). Every resolution returns its
 * `source` and `listName` so the builder can print "Contract", "Wholesale 2026" or
 * "List price" next to the number — an operator must be able to see *why* a line
 * says what it says, especially after a manual override.
 *
 * A "contract" price is per-customer data (`customers.custom_json.contract_prices`),
 * because there is no contract table yet; the resolution order is unaffected.
 *
 * ## The chain
 *
 * A delivery is the only thing that moves stock and posts COGS. An invoice bills
 * what was delivered, never more (`qty_invoiced ≤ qty_delivered ≤ qty_ordered`),
 * which is why `invoiceFromOrder` pre-fills the delivered-not-invoiced quantity.
 */

import { randomUUID } from 'node:crypto';

import type {
  CreditCheck,
  CustomerOutstanding,
  DeliveryDetail,
  DeliveryInput,
  DeliveryLineRow,
  DeliveryRow,
  DeliveryStatus,
  PriceListDetail,
  PriceListItemRow,
  PriceListRow,
  PriceResolution,
  PriceSource,
  QuoteDetail,
  QuoteInput,
  QuoteRow,
  QuoteStatus,
  SaleLineRow,
  SalesFilter,
  SoDetail,
  SoInput,
  SoRow,
  SoStatus,
} from '../../shared/ops';
import type { DocumentLineInput, InvoiceInput, JournalLineInput } from '../../shared/finance';
import type { Paged } from '../../shared/types';
import { nowIso, todayIso } from '../../shared/dates';
import { cents, mulQty } from '../../shared/money';
import { conn } from '../db/connection';
import { conflict, notFound, validation } from '../errors';
import { accountFor } from './accounts';
import { append as auditAppend } from './audit';
import { invalidateCache } from './cache';
import { computeTotals } from './finance.documents';
import { baseCurrency, writeJournal, type JournalScope } from './finance.engine';
import { postMove } from './inventory';
import { fiscalYearFor, nextNumber } from './settings';

const DEFAULT_PAGE_SIZE = 50;

/** Permissions that gate an in-handler escalation rather than a channel. */
export const OVERRIDE_EXPIRY = 'sales.quotation.override_expiry';
export const OVERRIDE_CREDIT = 'sales.order.override_credit';

function pageOf(filter: { page?: number; pageSize?: number }): { size: number; offset: number } {
  const size = Math.min(Math.max(Math.trunc(filter.pageSize ?? DEFAULT_PAGE_SIZE), 1), 200);
  const page = Math.max(Math.trunc(filter.page ?? 1), 1);
  return { size, offset: (page - 1) * size };
}

// ── price resolution ─────────────────────────────────────────────────────────

interface ListRow {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly is_default: number;
  readonly is_active: number;
}

/** True when the list is active and `at` falls inside its validity window. */
function listIsLive(list: ListRow, at: string): boolean {
  if (Number(list.is_active) !== 1) return false;
  if (list.valid_from && at < list.valid_from) return false;
  if (list.valid_to && at > list.valid_to) return false;
  return true;
}

/** The best price for a product on a list, honouring quantity breaks. */
function priceOnList(listId: string, productId: string, qtyMilli: number): number | null {
  const row = conn().one<{ price_cents: number }>(
    `SELECT price_cents FROM price_list_items
      WHERE price_list_id = ? AND product_id = ? AND min_qty_milli <= ?
      ORDER BY min_qty_milli DESC LIMIT 1`,
    [listId, productId, qtyMilli],
  );
  return row ? Number(row.price_cents) : null;
}

/** A per-customer contract price, stored on the customer record. */
function contractPrice(customerId: string, productId: string): number | null {
  const row = conn().one<{ custom_json: string }>('SELECT custom_json FROM customers WHERE id = ?', [customerId]);
  if (!row?.custom_json) return null;
  try {
    const parsed: unknown = JSON.parse(row.custom_json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const prices = (parsed as Record<string, unknown>)['contract_prices'];
    if (typeof prices !== 'object' || prices === null) return null;
    const value = (prices as Record<string, unknown>)[productId];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the price of one product for one customer (US-36, BR-17).
 *
 * Exported because the order and quote builders call it per line while the
 * operator types, and the acceptance test asserts the fallthrough directly.
 */
export function resolvePrice(
  productId: string,
  customerId: string,
  qtyMilli = 1000,
  at = todayIso(),
): PriceResolution {
  const product = conn().one<{ base_price_cents: number }>(
    'SELECT base_price_cents FROM products WHERE id = ? AND deleted_at IS NULL',
    [productId],
  );
  if (!product) throw notFound('Product');
  const customer = conn().one<{ price_list_id: string | null }>(
    'SELECT price_list_id FROM customers WHERE id = ?',
    [customerId],
  );
  if (!customer) throw notFound('Customer');

  const contract = contractPrice(customerId, productId);
  if (contract !== null) {
    return { productId, priceCents: contract, source: 'contract', listId: null, listName: 'Contract', qtyMilli };
  }

  if (customer.price_list_id) {
    const list = conn().one<ListRow>('SELECT * FROM price_lists WHERE id = ?', [customer.price_list_id]);
    if (list && listIsLive(list, at)) {
      const price = priceOnList(list.id, productId, qtyMilli);
      if (price !== null) {
        return {
          productId,
          priceCents: price,
          source: 'customer_list',
          listId: list.id,
          listName: list.name,
          qtyMilli,
        };
      }
    }
    // Expired or missing an item: fall through, do not clamp to the old price.
  }

  const fallback = conn().one<ListRow>(
    'SELECT * FROM price_lists WHERE is_default = 1 ORDER BY created_at LIMIT 1',
  );
  if (fallback && listIsLive(fallback, at)) {
    const price = priceOnList(fallback.id, productId, qtyMilli);
    if (price !== null) {
      return {
        productId,
        priceCents: price,
        source: 'default_list',
        listId: fallback.id,
        listName: fallback.name,
        qtyMilli,
      };
    }
  }

  return {
    productId,
    priceCents: Number(product.base_price_cents),
    source: 'base',
    listId: null,
    listName: null,
    qtyMilli,
  };
}

// ── price lists ──────────────────────────────────────────────────────────────

export function listPriceLists(): readonly PriceListRow[] {
  const today = todayIso();
  const rows = conn().all<ListRow & { item_count: number }>(
    `SELECT pl.*, (SELECT COUNT(*) FROM price_list_items WHERE price_list_id = pl.id) AS item_count
       FROM price_lists pl ORDER BY pl.is_default DESC, pl.name`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    currency: row.currency,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    isDefault: Number(row.is_default) === 1,
    isActive: Number(row.is_active) === 1,
    isExpired: Boolean(row.valid_to && row.valid_to < today),
    itemCount: Number(row.item_count),
  }));
}

export function getPriceList(id: string): PriceListDetail {
  const row = conn().one<ListRow>('SELECT * FROM price_lists WHERE id = ?', [id]);
  if (!row) throw notFound('Price list');
  const today = todayIso();
  const items = conn().all<{
    id: string;
    product_id: string;
    sku: string;
    name: string;
    price_cents: number;
    min_qty_milli: number;
  }>(
    `SELECT pli.id, pli.product_id, p.sku, p.name, pli.price_cents, pli.min_qty_milli
       FROM price_list_items pli JOIN products p ON p.id = pli.product_id
      WHERE pli.price_list_id = ? ORDER BY p.name, pli.min_qty_milli`,
    [id],
  );
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    isDefault: Number(row.is_default) === 1,
    isActive: Number(row.is_active) === 1,
    isExpired: Boolean(row.valid_to && row.valid_to < today),
    itemCount: items.length,
    items: items.map<PriceListItemRow>((item) => ({
      id: item.id,
      productId: item.product_id,
      sku: item.sku,
      productName: item.name,
      priceCents: Number(item.price_cents),
      minQtyMilli: Number(item.min_qty_milli),
    })),
  };
}

export function savePriceList(input: {
  readonly id?: string;
  readonly name: string;
  readonly currency?: string;
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
  readonly isDefault?: boolean;
  readonly isActive?: boolean;
  readonly items?: readonly { readonly productId: string; readonly priceCents: number; readonly minQtyMilli?: number }[];
}): PriceListDetail {
  const name = input.name.trim();
  if (name.length === 0) throw validation('name', 'Give the price list a name.');
  const id = input.id ?? randomUUID();
  const at = nowIso();

  if (input.isDefault) {
    // Only one default: otherwise "the default list" is ambiguous.
    conn().run('UPDATE price_lists SET is_default = 0');
  }

  if (input.id) {
    const existing = conn().one<{ id: string }>('SELECT id FROM price_lists WHERE id = ?', [id]);
    if (!existing) throw notFound('Price list');
    conn().run(
      `UPDATE price_lists SET name = ?, currency = ?, valid_from = ?, valid_to = ?, is_default = ?,
         is_active = ?, updated_at = ? WHERE id = ?`,
      [
        name,
        input.currency ?? baseCurrency(),
        input.validFrom ?? null,
        input.validTo ?? null,
        input.isDefault ? 1 : 0,
        input.isActive === false ? 0 : 1,
        at,
        id,
      ],
    );
    if (input.items) conn().run('DELETE FROM price_list_items WHERE price_list_id = ?', [id]);
  } else {
    conn().run(
      `INSERT INTO price_lists (id, name, currency, valid_from, valid_to, is_default, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        input.currency ?? baseCurrency(),
        input.validFrom ?? null,
        input.validTo ?? null,
        input.isDefault ? 1 : 0,
        input.isActive === false ? 0 : 1,
        at,
        at,
      ],
    );
  }

  for (const item of input.items ?? []) {
    if (!Number.isInteger(item.priceCents) || item.priceCents < 0) {
      throw validation('items', 'A price must be zero or more.');
    }
    conn().run(
      'INSERT INTO price_list_items (id, price_list_id, product_id, price_cents, min_qty_milli) VALUES (?, ?, ?, ?, ?)',
      [randomUUID(), id, item.productId, item.priceCents, item.minQtyMilli ?? 0],
    );
  }

  return getPriceList(id);
}

// ── quotations ───────────────────────────────────────────────────────────────

const QUOTE_SELECT = `
  SELECT q.*, c.name AS customer_name,
         (SELECT COUNT(*) FROM quote_lines WHERE quote_id = q.id) AS line_count
    FROM quotes q JOIN customers c ON c.id = q.customer_id`;

interface QuoteDbRow {
  readonly id: string;
  readonly number: string | null;
  readonly customer_id: string;
  readonly customer_name: string;
  readonly date: string;
  readonly expiry_date: string;
  readonly status: QuoteStatus;
  readonly currency: string;
  readonly total_cents: number;
  readonly converted_order_id: string | null;
  readonly line_count: number;
}

function toQuoteRow(row: QuoteDbRow, today = todayIso()): QuoteRow {
  return {
    id: row.id,
    number: row.number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    date: row.date,
    expiryDate: row.expiry_date,
    status: row.status,
    isExpired: row.status !== 'converted' && row.expiry_date < today,
    currency: row.currency,
    totalCents: Number(row.total_cents),
    convertedOrderId: row.converted_order_id,
    lineCount: Number(row.line_count),
  };
}

export function listQuotes(filter: SalesFilter = {}): Paged<QuoteRow> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.customerId) {
    where.push('q.customer_id = ?');
    params.push(filter.customerId);
  }
  if (filter.status) {
    where.push('q.status = ?');
    params.push(filter.status);
  }
  if (filter.from) {
    where.push('q.date >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('q.date <= ?');
    params.push(filter.to);
  }
  if (filter.q) {
    where.push('(q.number LIKE ? OR c.name LIKE ?)');
    params.push(`${filter.q}%`, `${filter.q}%`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { size, offset } = pageOf(filter);
  const total = conn().one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM quotes q JOIN customers c ON c.id = q.customer_id ${clause}`,
    params,
  );
  const rows = conn().all<QuoteDbRow>(
    `${QUOTE_SELECT} ${clause} ORDER BY q.date DESC, q.created_at DESC LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  return { rows: rows.map((row) => toQuoteRow(row)), total: Number(total?.total ?? 0) };
}

function quoteLines(quoteId: string): readonly SaleLineRow[] {
  const rows = conn().all<{
    id: string;
    line_no: number;
    product_id: string | null;
    sku: string | null;
    description: string;
    qty_milli: number;
    unit_price_cents: number;
    discount_bp: number;
    tax_id: string | null;
    price_source: string;
    net_cents: number;
    tax_cents: number;
    total_cents: number;
  }>(
    `SELECT ql.id, ql.line_no, ql.product_id, p.sku, ql.description, ql.qty_milli, ql.unit_price_cents,
            ql.discount_bp, ql.tax_id, ql.price_source, ql.net_cents, ql.tax_cents, ql.total_cents
       FROM quote_lines ql LEFT JOIN products p ON p.id = ql.product_id
      WHERE ql.quote_id = ? ORDER BY ql.line_no`,
    [quoteId],
  );
  return rows.map((row) => ({
    id: row.id,
    lineNo: Number(row.line_no),
    productId: row.product_id,
    sku: row.sku,
    description: row.description,
    qtyMilli: Number(row.qty_milli),
    deliveredMilli: 0,
    invoicedMilli: 0,
    remainingMilli: Number(row.qty_milli),
    toInvoiceMilli: 0,
    unitPriceCents: Number(row.unit_price_cents),
    discountBp: Number(row.discount_bp),
    taxId: row.tax_id,
    priceSource: row.price_source,
    netCents: Number(row.net_cents),
    taxCents: Number(row.tax_cents),
    totalCents: Number(row.total_cents),
  }));
}

export function getQuote(id: string): QuoteDetail {
  const row = conn().one<QuoteDbRow & { notes: string | null; terms: string | null }>(
    `${QUOTE_SELECT} WHERE q.id = ?`,
    [id],
  );
  if (!row) throw notFound('Quotation');
  const orderIds = conn()
    .all<{ id: string }>('SELECT id FROM sales_orders WHERE quote_id = ?', [id])
    .map((entry) => entry.id);
  return { ...toQuoteRow(row), notes: row.notes, terms: row.terms, lines: quoteLines(id), orderIds };
}

export function saveQuote(input: QuoteInput): QuoteDetail {
  const customer = conn().one<{ id: string; currency: string | null }>(
    'SELECT id, currency FROM customers WHERE id = ?',
    [input.customerId],
  );
  if (!customer) throw validation('customerId', 'Pick a customer.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{4}-\d{2}-\d{2}$/.test(input.expiryDate)) {
    throw validation('date', 'Pick a valid date and expiry date.');
  }
  if (input.expiryDate < input.date) throw validation('expiryDate', 'The expiry cannot be before the quote date.');
  if (input.lines.length === 0) throw validation('lines', 'Add at least one line.');

  const totals = computeTotals(
    input.lines.map<DocumentLineInput>((line) => ({
      productId: line.productId ?? null,
      description: line.description,
      qtyMilli: line.qtyMilli,
      unitPriceCents: line.unitPriceCents,
      discountBp: line.discountBp ?? 0,
      taxId: line.taxId ?? null,
    })),
  );

  const id = input.id ?? randomUUID();
  const at = nowIso();

  if (input.id) {
    const existing = conn().one<{ status: string }>('SELECT status FROM quotes WHERE id = ?', [id]);
    if (!existing) throw notFound('Quotation');
    if (String(existing.status) === 'converted') throw conflict('A converted quotation is read-only.');
    conn().run('DELETE FROM quote_lines WHERE quote_id = ?', [id]);
    conn().run(
      `UPDATE quotes SET customer_id = ?, date = ?, expiry_date = ?, subtotal_cents = ?, discount_cents = ?,
         tax_cents = ?, total_cents = ?, notes = ?, terms = ?, updated_at = ? WHERE id = ?`,
      [
        input.customerId,
        input.date,
        input.expiryDate,
        totals.subtotalCents,
        totals.discountCents ?? 0,
        totals.taxCents,
        totals.totalCents,
        input.notes?.trim() || null,
        input.terms?.trim() || null,
        at,
        id,
      ],
    );
  } else {
    const year = fiscalYearFor(input.date);
    const number = nextNumber('quote', year.id);
    conn().run(
      `INSERT INTO quotes (id, number, customer_id, date, expiry_date, status, currency, subtotal_cents,
         discount_cents, tax_cents, total_cents, notes, terms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        number,
        input.customerId,
        input.date,
        input.expiryDate,
        customer.currency ?? baseCurrency(),
        totals.subtotalCents,
        totals.discountCents ?? 0,
        totals.taxCents,
        totals.totalCents,
        input.notes?.trim() || null,
        input.terms?.trim() || null,
        at,
        at,
      ],
    );
  }

  for (const [index, line] of totals.lines.entries()) {
    const inputLine = input.lines[index];
    conn().run(
      `INSERT INTO quote_lines (id, quote_id, line_no, product_id, description, qty_milli, unit_price_cents,
         discount_bp, tax_id, price_source, net_cents, tax_cents, total_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        id,
        index + 1,
        line.productId,
        line.description,
        line.qtyMilli,
        line.unitPriceCents,
        line.discountBp,
        line.taxId,
        inputLine?.priceSource ?? 'base',
        line.netCents,
        line.taxCents,
        line.totalCents,
      ],
    );
  }

  return getQuote(id);
}

/**
 * Moves a quotation through its lifecycle (`draft → sent → accepted`, or
 * `expired`). Status changes are one function so the legal transitions live in a
 * single place rather than in three handlers.
 */
export function setQuoteStatus(id: string, status: QuoteStatus): QuoteDetail {
  const quote = getQuote(id);
  if (quote.status === 'converted') throw conflict('A converted quotation cannot change status.');
  if (quote.status === 'rejected' && status !== 'expired') {
    throw conflict('A rejected quotation cannot be sent or accepted.');
  }
  conn().run('UPDATE quotes SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), id]);
  return getQuote(id);
}

/**
 * Converts a quotation into a sales order (US-33/34, BR-18).
 *
 * An expired quote is refused unless the caller holds
 * `sales.quotation.override_expiry`, and the override writes its own audit row so
 * "who let this through" has an answer.
 */
export function convertQuoteToOrder(
  quoteId: string,
  scope: JournalScope,
  options: { readonly overrideExpiry?: boolean; readonly reason?: string } = {},
  permissions: ReadonlySet<string> = new Set<string>(),
): SoDetail {
  const quote = getQuote(quoteId);
  if (quote.status === 'converted') {
    throw conflict(`That quotation was already converted${quote.convertedOrderId ? ' into an order' : ''}.`);
  }
  if (quote.status === 'rejected') throw conflict('A rejected quotation cannot be converted.');

  if (quote.isExpired) {
    const permitted = options.overrideExpiry === true && permissions.has(OVERRIDE_EXPIRY);
    if (!permitted) {
      const detail =
        options.overrideExpiry === true ? ' You do not hold the permission to override an expiry.' : '';
      throw conflict(
        `That quotation expired on ${quote.expiryDate} and cannot be converted.${detail}`,
      );
    }
    if ((options.reason ?? '').trim().length === 0) {
      throw validation('reason', 'Overriding an expiry needs a reason — it is recorded in the audit log.');
    }
    auditAppend({
      actorId: scope.actorId,
      actorName: scope.actorName,
      entity: 'quotes',
      entityId: quote.id,
      action: 'override_expiry',
      before: { expiryDate: quote.expiryDate, status: quote.status },
      after: { reason: options.reason ?? '' },
      meta: { permission: OVERRIDE_EXPIRY },
    });
  }

  const order = saveOrder({
    customerId: quote.customerId,
    date: todayIso(),
    quoteId: quote.id,
    terms: quote.terms ?? undefined,
    lines: quote.lines.map((line) => ({
      productId: line.productId ?? undefined,
      description: line.description,
      qtyMilli: line.qtyMilli,
      unitPriceCents: line.unitPriceCents,
      discountBp: line.discountBp,
      taxId: line.taxId ?? undefined,
      priceSource: line.priceSource as PriceSource,
    })),
  });

  conn().run("UPDATE quotes SET status = 'converted', converted_order_id = ?, updated_at = ? WHERE id = ?", [
    order.id,
    nowIso(),
    quote.id,
  ]);
  return order;
}

// ── sales orders ─────────────────────────────────────────────────────────────

const SO_SELECT = `
  SELECT so.*, c.name AS customer_name,
         (SELECT COALESCE(SUM(qty_milli), 0) FROM so_lines WHERE order_id = so.id) AS ordered_milli,
         (SELECT COALESCE(SUM(delivered_milli), 0) FROM so_lines WHERE order_id = so.id) AS delivered_milli,
         (SELECT COALESCE(SUM(invoiced_milli), 0) FROM so_lines WHERE order_id = so.id) AS invoiced_milli,
         (SELECT COUNT(*) FROM so_lines WHERE order_id = so.id) AS line_count
    FROM sales_orders so JOIN customers c ON c.id = so.customer_id`;

interface SoDbRow {
  readonly id: string;
  readonly number: string | null;
  readonly customer_id: string;
  readonly customer_name: string;
  readonly date: string;
  readonly status: SoStatus;
  readonly currency: string;
  readonly subtotal_cents: number;
  readonly tax_cents: number;
  readonly total_cents: number;
  readonly ordered_milli: number;
  readonly delivered_milli: number;
  readonly invoiced_milli: number;
  readonly quote_id: string | null;
  readonly line_count: number;
}

function toSoRow(row: SoDbRow): SoRow {
  return {
    id: row.id,
    number: row.number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    date: row.date,
    status: row.status,
    currency: row.currency,
    subtotalCents: Number(row.subtotal_cents),
    taxCents: Number(row.tax_cents),
    totalCents: Number(row.total_cents),
    orderedMilli: Number(row.ordered_milli),
    deliveredMilli: Number(row.delivered_milli),
    invoicedMilli: Number(row.invoiced_milli),
    quoteId: row.quote_id,
    lineCount: Number(row.line_count),
  };
}

export function listOrders(filter: SalesFilter = {}): Paged<SoRow> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.customerId) {
    where.push('so.customer_id = ?');
    params.push(filter.customerId);
  }
  if (filter.status) {
    where.push('so.status = ?');
    params.push(filter.status);
  }
  if (filter.from) {
    where.push('so.date >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('so.date <= ?');
    params.push(filter.to);
  }
  if (filter.q) {
    where.push('(so.number LIKE ? OR c.name LIKE ?)');
    params.push(`${filter.q}%`, `${filter.q}%`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { size, offset } = pageOf(filter);
  const total = conn().one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM sales_orders so JOIN customers c ON c.id = so.customer_id ${clause}`,
    params,
  );
  const rows = conn().all<SoDbRow>(
    `${SO_SELECT} ${clause} ORDER BY so.date DESC, so.created_at DESC LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  return { rows: rows.map(toSoRow), total: Number(total?.total ?? 0) };
}

function soLines(orderId: string): readonly SaleLineRow[] {
  const rows = conn().all<{
    id: string;
    line_no: number;
    product_id: string | null;
    sku: string | null;
    description: string;
    qty_milli: number;
    delivered_milli: number;
    invoiced_milli: number;
    unit_price_cents: number;
    discount_bp: number;
    tax_id: string | null;
    net_cents: number;
    tax_cents: number;
    total_cents: number;
  }>(
    `SELECT sl.id, sl.line_no, sl.product_id, p.sku, sl.description, sl.qty_milli, sl.delivered_milli,
            sl.invoiced_milli, sl.unit_price_cents, sl.discount_bp, sl.tax_id, sl.net_cents, sl.tax_cents,
            sl.total_cents
       FROM so_lines sl LEFT JOIN products p ON p.id = sl.product_id
      WHERE sl.order_id = ? ORDER BY sl.line_no`,
    [orderId],
  );
  return rows.map((row) => {
    const qty = Number(row.qty_milli);
    const delivered = Number(row.delivered_milli);
    const invoiced = Number(row.invoiced_milli);
    return {
      id: row.id,
      lineNo: Number(row.line_no),
      productId: row.product_id,
      sku: row.sku,
      description: row.description,
      qtyMilli: qty,
      deliveredMilli: delivered,
      invoicedMilli: invoiced,
      remainingMilli: qty - delivered,
      toInvoiceMilli: delivered - invoiced,
      unitPriceCents: Number(row.unit_price_cents),
      discountBp: Number(row.discount_bp),
      taxId: row.tax_id,
      priceSource: 'base',
      netCents: Number(row.net_cents),
      taxCents: Number(row.tax_cents),
      totalCents: Number(row.total_cents),
    };
  });
}

export function getOrder(id: string): SoDetail {
  const row = conn().one<SoDbRow & { notes: string | null; terms: string | null; warehouse_id: string | null }>(
    `${SO_SELECT} WHERE so.id = ?`,
    [id],
  );
  if (!row) throw notFound('Sales order');
  const deliveryIds = conn()
    .all<{ id: string }>('SELECT id FROM sales_deliveries WHERE order_id = ? ORDER BY date', [id])
    .map((entry) => entry.id);
  const invoiceIds = conn()
    .all<{ id: string }>("SELECT id FROM invoices WHERE source_type = 'sales_order' AND source_id = ?", [id])
    .map((entry) => entry.id);
  return {
    ...toSoRow(row),
    notes: row.notes,
    terms: row.terms,
    warehouseId: row.warehouse_id,
    lines: soLines(id),
    deliveryIds,
    invoiceIds,
  };
}

export function saveOrder(input: SoInput): SoDetail {
  const customer = conn().one<{ id: string; currency: string | null }>(
    'SELECT id, currency FROM customers WHERE id = ?',
    [input.customerId],
  );
  if (!customer) throw validation('customerId', 'Pick a customer.');
  if (input.lines.length === 0) throw validation('lines', 'Add at least one line.');

  const totals = computeTotals(
    input.lines.map<DocumentLineInput>((line) => ({
      productId: line.productId ?? null,
      description: line.description,
      qtyMilli: line.qtyMilli,
      unitPriceCents: line.unitPriceCents,
      discountBp: line.discountBp ?? 0,
      taxId: line.taxId ?? null,
    })),
  );

  const id = input.id ?? randomUUID();
  const at = nowIso();

  if (input.id) {
    const existing = conn().one<{ status: string }>('SELECT status FROM sales_orders WHERE id = ?', [id]);
    if (!existing) throw notFound('Sales order');
    if (String(existing.status) !== 'draft') {
      throw conflict('A confirmed order is read-only. Cancel it and raise a new one.');
    }
    conn().run('DELETE FROM so_lines WHERE order_id = ?', [id]);
    conn().run(
      `UPDATE sales_orders SET customer_id = ?, date = ?, warehouse_id = ?, subtotal_cents = ?,
         discount_cents = ?, tax_cents = ?, total_cents = ?, notes = ?, terms = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.customerId,
        input.date,
        input.warehouseId ?? null,
        totals.subtotalCents,
        totals.discountCents ?? 0,
        totals.taxCents,
        totals.totalCents,
        input.notes?.trim() || null,
        input.terms?.trim() || null,
        at,
        id,
      ],
    );
  } else {
    conn().run(
      `INSERT INTO sales_orders (id, number, customer_id, quote_id, date, status, currency, subtotal_cents,
         discount_cents, tax_cents, total_cents, warehouse_id, notes, terms, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.customerId,
        input.quoteId ?? null,
        input.date,
        customer.currency ?? baseCurrency(),
        totals.subtotalCents,
        totals.discountCents ?? 0,
        totals.taxCents,
        totals.totalCents,
        input.warehouseId ?? null,
        input.notes?.trim() || null,
        input.terms?.trim() || null,
        at,
        at,
      ],
    );
  }

  for (const [index, line] of totals.lines.entries()) {
    conn().run(
      `INSERT INTO so_lines (id, order_id, line_no, product_id, description, qty_milli, delivered_milli,
         invoiced_milli, unit_price_cents, discount_bp, tax_id, net_cents, tax_cents, total_cents)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        id,
        index + 1,
        line.productId,
        line.description,
        line.qtyMilli,
        line.unitPriceCents,
        line.discountBp,
        line.taxId,
        line.netCents,
        line.taxCents,
        line.totalCents,
      ],
    );
  }

  return getOrder(id);
}

/** Credit position for a customer, including the order about to be confirmed. */
export function checkCredit(customerId: string, orderCents = 0): CreditCheck {
  const customer = conn().one<{ name: string; credit_limit_cents: number }>(
    'SELECT name, credit_limit_cents FROM customers WHERE id = ?',
    [customerId],
  );
  if (!customer) throw notFound('Customer');
  const limit = Number(customer.credit_limit_cents);
  const outstanding = Number(
    conn().one<{ open: number | null }>(
      `SELECT SUM(total_cents - paid_cents) AS open FROM invoices
        WHERE customer_id = ? AND status NOT IN ('void', 'draft')`,
      [customerId],
    )?.open ?? 0,
  );
  if (limit <= 0) {
    return {
      withinLimit: true,
      creditLimitCents: 0,
      outstandingCents: outstanding,
      orderCents,
      excessCents: 0,
      message: null,
    };
  }
  const projected = outstanding + orderCents;
  const excess = projected - limit;
  return {
    withinLimit: excess <= 0,
    creditLimitCents: limit,
    outstandingCents: outstanding,
    orderCents,
    excessCents: Math.max(0, excess),
    message:
      excess <= 0
        ? null
        : `${customer.name} already owes ${(outstanding / 100).toFixed(2)} against a limit of ` +
          `${(limit / 100).toFixed(2)}. This order takes them ${(excess / 100).toFixed(2)} over.`,
  };
}

/**
 * Confirms an order: allocates its number and checks the credit limit.
 *
 * Over the limit, confirmation is refused unless the caller holds
 * `sales.order.override_credit` *and* gives a reason — a warning that can be
 * clicked away is not a control.
 */
export function confirmOrder(
  id: string,
  scope: JournalScope,
  options: { readonly overrideCredit?: boolean; readonly reason?: string } = {},
  permissions: ReadonlySet<string> = new Set<string>(),
): SoDetail {
  const order = getOrder(id);
  if (order.status !== 'draft') throw conflict(`That order is already ${order.status.replace('_', ' ')}.`);

  const credit = checkCredit(order.customerId, order.totalCents);
  if (!credit.withinLimit) {
    const permitted = options.overrideCredit === true && permissions.has(OVERRIDE_CREDIT);
    if (!permitted) {
      throw conflict(`${credit.message ?? 'This order exceeds the credit limit.'}`);
    }
    if ((options.reason ?? '').trim().length === 0) {
      throw validation('reason', 'Overriding a credit limit needs a reason — it is recorded in the audit log.');
    }
    auditAppend({
      actorId: scope.actorId,
      actorName: scope.actorName,
      entity: 'sales_orders',
      entityId: order.id,
      action: 'override_credit_limit',
      before: { creditLimitCents: credit.creditLimitCents, outstandingCents: credit.outstandingCents },
      after: { orderCents: credit.orderCents, excessCents: credit.excessCents, reason: options.reason ?? '' },
      meta: { permission: OVERRIDE_CREDIT },
    });
  }

  const year = fiscalYearFor(order.date);
  const number = nextNumber('sales_order', year.id);
  conn().run("UPDATE sales_orders SET number = ?, status = 'confirmed', updated_at = ? WHERE id = ?", [
    number,
    nowIso(),
    id,
  ]);
  return getOrder(id);
}

export function cancelOrder(id: string, reason: string): SoDetail {
  const order = getOrder(id);
  if (order.status === 'cancelled') throw conflict('That order is already cancelled.');
  if (order.deliveredMilli > 0) {
    throw conflict('Something has already been delivered against this order, so it cannot be cancelled.');
  }
  if ((reason ?? '').trim().length === 0) throw validation('reason', 'Say why the order is being cancelled.');
  conn().run("UPDATE sales_orders SET status = 'cancelled', updated_at = ? WHERE id = ?", [nowIso(), id]);
  return getOrder(id);
}

/** Recomputes the order status from its lines. */
function refreshOrderStatus(orderId: string): void {
  const row = conn().one<{ ordered: number | null; delivered: number | null; invoiced: number | null; status: string }>(
    `SELECT (SELECT COALESCE(SUM(qty_milli),0) FROM so_lines WHERE order_id = ?) AS ordered,
            (SELECT COALESCE(SUM(delivered_milli),0) FROM so_lines WHERE order_id = ?) AS delivered,
            (SELECT COALESCE(SUM(invoiced_milli),0) FROM so_lines WHERE order_id = ?) AS invoiced,
            status FROM sales_orders WHERE id = ?`,
    [orderId, orderId, orderId, orderId],
  );
  if (!row || row.status === 'cancelled') return;
  const ordered = Number(row.ordered ?? 0);
  const delivered = Number(row.delivered ?? 0);
  const invoiced = Number(row.invoiced ?? 0);
  const next: SoStatus =
    invoiced >= ordered && ordered > 0
      ? 'invoiced'
      : delivered >= ordered && ordered > 0
        ? 'delivered'
        : delivered > 0
          ? 'partially_delivered'
          : 'confirmed';
  conn().run('UPDATE sales_orders SET status = ?, updated_at = ? WHERE id = ?', [next, nowIso(), orderId]);
}

// ── deliveries ───────────────────────────────────────────────────────────────

const DELIVERY_SELECT = `
  SELECT sd.*, c.name AS customer_name, w.name AS warehouse_name, so.number AS order_number,
         (SELECT COALESCE(SUM(qty_milli * unit_cost_cents) / 1000, 0) FROM delivery_lines
           WHERE delivery_id = sd.id) AS total_cost_cents
    FROM sales_deliveries sd
    JOIN customers c ON c.id = sd.customer_id
    JOIN warehouses w ON w.id = sd.warehouse_id
    LEFT JOIN sales_orders so ON so.id = sd.order_id`;

interface DeliveryDbRow {
  readonly id: string;
  readonly number: string | null;
  readonly order_id: string | null;
  readonly order_number: string | null;
  readonly customer_id: string;
  readonly customer_name: string;
  readonly date: string;
  readonly status: DeliveryStatus;
  readonly warehouse_name: string;
  readonly total_cost_cents: number;
  readonly invoice_id: string | null;
}

function toDeliveryRow(row: DeliveryDbRow): DeliveryRow {
  return {
    id: row.id,
    number: row.number,
    orderId: row.order_id,
    orderNumber: row.order_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    date: row.date,
    status: row.status,
    warehouseName: row.warehouse_name,
    totalCostCents: Number(row.total_cost_cents),
    invoiceId: row.invoice_id,
  };
}

export function listDeliveries(filter: SalesFilter = {}): Paged<DeliveryRow> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.customerId) {
    where.push('sd.customer_id = ?');
    params.push(filter.customerId);
  }
  if (filter.status) {
    where.push('sd.status = ?');
    params.push(filter.status);
  }
  if (filter.from) {
    where.push('sd.date >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('sd.date <= ?');
    params.push(filter.to);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { size, offset } = pageOf(filter);
  const total = conn().one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM sales_deliveries sd ${clause}`,
    params,
  );
  const rows = conn().all<DeliveryDbRow>(
    `${DELIVERY_SELECT} ${clause} ORDER BY sd.date DESC, sd.created_at DESC LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  return { rows: rows.map(toDeliveryRow), total: Number(total?.total ?? 0) };
}

export function getDelivery(id: string): DeliveryDetail {
  const row = conn().one<DeliveryDbRow & { notes: string | null; journal_entry_id: string | null }>(
    `${DELIVERY_SELECT} WHERE sd.id = ?`,
    [id],
  );
  if (!row) throw notFound('Delivery');
  const lines = conn().all<{
    id: string;
    so_line_id: string | null;
    product_id: string;
    sku: string;
    product_name: string;
    qty_milli: number;
    unit_cost_cents: number;
  }>(
    `SELECT dl.id, dl.so_line_id, dl.product_id, p.sku, p.name AS product_name, dl.qty_milli,
            dl.unit_cost_cents
       FROM delivery_lines dl JOIN products p ON p.id = dl.product_id
      WHERE dl.delivery_id = ? ORDER BY dl.rowid`,
    [id],
  );
  return {
    ...toDeliveryRow(row),
    notes: row.notes,
    journalEntryId: row.journal_entry_id,
    lines: lines.map<DeliveryLineRow>((line) => ({
      id: line.id,
      soLineId: line.so_line_id,
      productId: line.product_id,
      sku: line.sku,
      productName: line.product_name,
      qtyMilli: Number(line.qty_milli),
      unitCostCents: Number(line.unit_cost_cents),
      valueCents: mulQty(cents(Number(line.unit_cost_cents)), Number(line.qty_milli)),
    })),
  };
}

export function saveDelivery(input: DeliveryInput): DeliveryDetail {
  if (input.lines.length === 0) throw validation('lines', 'Deliver at least one line.');
  const id = input.id ?? randomUUID();
  const at = nowIso();

  if (input.id) {
    const existing = conn().one<{ status: string }>('SELECT status FROM sales_deliveries WHERE id = ?', [id]);
    if (!existing) throw notFound('Delivery');
    if (String(existing.status) !== 'draft') throw conflict('Posted deliveries are read-only.');
    conn().run('DELETE FROM delivery_lines WHERE delivery_id = ?', [id]);
    conn().run(
      `UPDATE sales_deliveries SET order_id = ?, customer_id = ?, date = ?, warehouse_id = ?, notes = ?,
         updated_at = ? WHERE id = ?`,
      [input.orderId ?? null, input.customerId, input.date, input.warehouseId, input.notes?.trim() || null, at, id],
    );
  } else {
    conn().run(
      `INSERT INTO sales_deliveries (id, number, order_id, customer_id, date, status, warehouse_id, notes,
         created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      [
        id,
        input.orderId ?? null,
        input.customerId,
        input.date,
        input.warehouseId,
        input.notes?.trim() || null,
        at,
        at,
      ],
    );
  }

  for (const line of input.lines) {
    if (!Number.isInteger(line.qtyMilli) || line.qtyMilli <= 0) {
      throw validation('lines', 'A delivered quantity must be greater than zero.');
    }
    if (line.soLineId) {
      const soLine = conn().one<{ qty_milli: number; delivered_milli: number }>(
        'SELECT qty_milli, delivered_milli FROM so_lines WHERE id = ?',
        [line.soLineId],
      );
      const remaining = Number(soLine?.qty_milli ?? 0) - Number(soLine?.delivered_milli ?? 0);
      if (line.qtyMilli > remaining) {
        throw conflict(
          `Only ${(remaining / 1000).toFixed(3)} is still to deliver on that line, ` +
            `so ${(line.qtyMilli / 1000).toFixed(3)} cannot be delivered.`,
        );
      }
    }
    // Cost is taken from stock at post time; store a placeholder now so a draft
    // shows an indicative value without pretending to know the FIFO layer.
    conn().run(
      `INSERT INTO delivery_lines (id, delivery_id, so_line_id, product_id, qty_milli, unit_cost_cents)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [randomUUID(), id, line.soLineId ?? null, line.productId, line.qtyMilli],
    );
  }

  return getDelivery(id);
}

/** The warehouse's default location, used when a delivery does not name one. */
function defaultLocationOf(warehouseId: string): string {
  const row = conn().one<{ id: string }>(
    'SELECT id FROM locations WHERE warehouse_id = ? AND is_active = 1 ORDER BY code LIMIT 1',
    [warehouseId],
  );
  if (!row) throw validation('warehouseId', 'That warehouse has no active location to pick from.');
  return row.id;
}

/**
 * Posts a delivery: stock out and **one** COGS journal for the document.
 *
 * The cost is whatever the product's cost method releases, so a FIFO product
 * consumes its oldest layers here and an average product uses its current average.
 * That is why COGS on the delivery and the valuation report always agree.
 */
export function postDelivery(id: string, scope: JournalScope): DeliveryDetail {
  const delivery = getDelivery(id);
  if (delivery.status !== 'draft') throw conflict(`That delivery is already ${delivery.status}.`);

  const warehouseId = String(
    conn().one<{ warehouse_id: string }>('SELECT warehouse_id FROM sales_deliveries WHERE id = ?', [id])?.warehouse_id ??
      '',
  );
  const locationId = defaultLocationOf(warehouseId);

  const order = delivery.orderId
    ? conn().one<{ number: string | null }>('SELECT number FROM sales_orders WHERE id = ?', [delivery.orderId])
    : undefined;
  const existingCount =
    conn().one<{ total: number }>('SELECT COUNT(*) AS total FROM sales_deliveries WHERE order_id = ?', [
      delivery.orderId,
    ])?.total ?? 1;
  const number = `${order?.number ?? 'DLV'}/D${String(existingCount)}`;

  let totalCost = 0;
  for (const line of delivery.lines) {
    const result = postMove(
      {
        type: 'issue',
        productId: line.productId,
        fromLocationId: locationId,
        qtyMilli: -line.qtyMilli,
        movedAt: delivery.date,
        reference: number,
        sourceType: 'delivery',
        sourceId: delivery.id,
        suppressJournal: true,
      },
      scope,
    );
    totalCost += result.move.valueCents;
    conn().run('UPDATE delivery_lines SET unit_cost_cents = ? WHERE id = ?', [
      result.move.unitCostCents,
      line.id,
    ]);
  }

  const lines: JournalLineInput[] = [
    {
      accountId: accountFor('cogs', 'Cost of goods sold'),
      debitCents: cents(totalCost),
      description: `Delivery ${number}`,
    },
    {
      accountId: accountFor('inventory', 'Inventory'),
      creditCents: cents(totalCost),
      description: `Delivery ${number}`,
    },
  ];

  const entry = writeJournal(scope, {
    date: delivery.date,
    journalCode: 'SAL',
    memo: `Delivery ${number} — ${delivery.customerName}`,
    lines,
    sourceType: 'delivery',
    sourceId: delivery.id,
  });

  const at = nowIso();
  conn().run(
    `UPDATE sales_deliveries SET number = ?, status = 'posted', posted_at = ?, posted_by = ?,
       journal_entry_id = ?, updated_at = ? WHERE id = ?`,
    [number, at, scope.actorId, entry.id, at, delivery.id],
  );
  conn().run('UPDATE stock_moves SET journal_entry_id = ? WHERE source_type = ? AND source_id = ?', [
    entry.id,
    'delivery',
    delivery.id,
  ]);

  for (const line of delivery.lines) {
    if (!line.soLineId) continue;
    conn().run('UPDATE so_lines SET delivered_milli = delivered_milli + ? WHERE id = ?', [
      line.qtyMilli,
      line.soLineId,
    ]);
  }
  if (delivery.orderId) refreshOrderStatus(delivery.orderId);

  invalidateCache('report:');
  return getDelivery(delivery.id);
}

// ── invoice from order ───────────────────────────────────────────────────────

/**
 * Pre-fills an invoice from what has been delivered but not yet invoiced
 * (PRD §6.2, US-35).
 *
 * Returns an `InvoiceInput` rather than posting, so the operator can review it.
 * Lines with nothing left to invoice are dropped, which is what stops a second
 * invoice from billing the same delivery twice.
 */
export function invoiceFromOrder(orderId: string): InvoiceInput {
  const order = getOrder(orderId);
  if (order.status === 'draft') throw conflict('Confirm the order before invoicing it.');
  if (order.status === 'cancelled') throw conflict('A cancelled order cannot be invoiced.');

  const billable = order.lines.filter((line) => line.toInvoiceMilli > 0);
  if (billable.length === 0) {
    throw conflict(
      order.invoicedMilli >= order.orderedMilli
        ? 'Everything on that order has already been invoiced.'
        : 'Nothing has been delivered yet, so there is nothing to invoice.',
    );
  }

  const customer = conn().one<{ payment_terms_days: number; currency: string | null }>(
    'SELECT payment_terms_days, currency FROM customers WHERE id = ?',
    [order.customerId],
  );
  const terms = Number(customer?.payment_terms_days ?? 0);
  const today = todayIso();
  const due = new Date(`${today}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + terms);

  return {
    customerId: order.customerId,
    date: today,
    dueDate: due.toISOString().slice(0, 10),
    currency: customer?.currency ?? order.currency,
    notes: `From sales order ${order.number ?? ''}`,
    lines: billable.map<DocumentLineInput>((line) => ({
      productId: line.productId,
      description: line.description,
      qtyMilli: line.toInvoiceMilli,
      unitPriceCents: line.unitPriceCents,
      discountBp: line.discountBp,
      taxId: line.taxId,
    })),
  };
}

/**
 * Records that an invoice billed an order, so the next `invoiceFromOrder` does not
 * bill the same delivery again. Called by the handler inside the same transaction
 * as `postInvoice`.
 */
export function markOrderInvoiced(orderId: string, invoiceId: string, billed: readonly { readonly productId: string | null; readonly qtyMilli: number }[]): void {
  for (const entry of billed) {
    if (!entry.productId) continue;
    const line = conn().one<{ id: string; delivered_milli: number; invoiced_milli: number }>(
      'SELECT id, delivered_milli, invoiced_milli FROM so_lines WHERE order_id = ? AND product_id = ? LIMIT 1',
      [orderId, entry.productId],
    );
    if (!line) continue;
    const next = Math.min(Number(line.delivered_milli), Number(line.invoiced_milli) + entry.qtyMilli);
    conn().run('UPDATE so_lines SET invoiced_milli = ? WHERE id = ?', [next, line.id]);
  }
  conn().run(
    "UPDATE sales_deliveries SET invoice_id = ? WHERE order_id = ? AND status = 'posted' AND invoice_id IS NULL",
    [invoiceId, orderId],
  );
  refreshOrderStatus(orderId);
}

// ── customer reporting ───────────────────────────────────────────────────────

/** Outstanding balance for one customer, or for every customer when `id` is null. */
export function customerOutstanding(customerId?: string): readonly CustomerOutstanding[] {
  const rows = conn().all<{
    id: string;
    name: string;
    payment_terms_days: number;
    credit_limit_cents: number;
    outstanding: number | null;
    overdue: number | null;
    open_count: number;
  }>(
    `SELECT c.id, c.name, c.payment_terms_days, c.credit_limit_cents,
            (SELECT SUM(i.total_cents - i.paid_cents) FROM invoices i
              WHERE i.customer_id = c.id AND i.status NOT IN ('void','draft')) AS outstanding,
            (SELECT SUM(i.total_cents - i.paid_cents) FROM invoices i
              WHERE i.customer_id = c.id AND i.status NOT IN ('void','draft') AND i.due_date < ?) AS overdue,
            (SELECT COUNT(*) FROM invoices i
              WHERE i.customer_id = c.id AND i.status NOT IN ('void','draft')
                AND i.total_cents > i.paid_cents) AS open_count
       FROM customers c
      WHERE c.deleted_at IS NULL ${customerId ? 'AND c.id = ?' : ''}
      ORDER BY outstanding DESC, c.name`,
    customerId ? [todayIso(), customerId] : [todayIso()],
  );
  return rows.map((row) => {
    const outstanding = Number(row.outstanding ?? 0);
    const limit = Number(row.credit_limit_cents);
    return {
      customerId: row.id,
      name: row.name,
      termsDays: Number(row.payment_terms_days),
      creditLimitCents: limit,
      outstandingCents: outstanding,
      overdueCents: Number(row.overdue ?? 0),
      openCount: Number(row.open_count),
      overLimit: limit > 0 && outstanding > limit,
    };
  });
}

/**
 * Raises a draft sales order from a won deal (`crm.deal.fromWon`).
 *
 * One service line carrying the deal's value, described by the deal's name: a
 * deal records what was agreed, not the itemised order, so inventing lines here
 * would be inventing data. The operator opens the draft and replaces the line
 * with real products — which is why this creates a **draft** and never confirms.
 *
 * The deal keeps the link (`sales_order_id`) so the board can show that a won
 * deal has already been ordered, and pressing the button twice is refused rather
 * than producing a duplicate order.
 */
export function orderFromDeal(
  dealId: string,
  customerId: string,
  scope: { readonly actorId: string | null; readonly actorName: string },
): { readonly orderId: string; readonly number: string | null } {
  const deal = conn().one<{
    id: string;
    name: string;
    value_cents: number;
    status: string;
    sales_order_id: string | null;
  }>('SELECT id, name, value_cents, status, sales_order_id FROM deals WHERE id = ? AND deleted_at IS NULL', [dealId]);
  if (!deal) throw notFound('Deal');
  if (deal.status !== 'won') throw conflict('Only a won deal can become a sales order.');
  if (deal.sales_order_id) throw conflict('That deal already has a sales order.');
  if (Number(deal.value_cents) <= 0) {
    throw conflict('That deal has no value, so there is nothing to order. Set its value first.');
  }

  const order = saveOrder({
    customerId,
    date: todayIso(),
    notes: `Raised from deal ${deal.name}`,
    lines: [
      {
        description: deal.name,
        qtyMilli: 1000,
        unitPriceCents: Number(deal.value_cents),
      },
    ],
  });

  conn().run('UPDATE deals SET sales_order_id = ?, updated_at = ? WHERE id = ?', [order.id, nowIso(), dealId]);
  auditAppend({
    actorId: scope.actorId,
    actorName: scope.actorName,
    entity: 'deals',
    entityId: dealId,
    action: 'create_order',
    after: { orderId: order.id, number: order.number },
  });

  return { orderId: order.id, number: order.number };
}
