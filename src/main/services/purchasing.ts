/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Purchasing: vendors → purchase orders → partial receipts → bills with a
 * three-way match (T08, US-29…US-32, BR-13/14).
 *
 * ## The chain, and what each link posts
 *
 *   PO (no journal) → receipt (Dr Inventory / Cr GRNI) → bill (Dr GRNI, ±price
 *   variance, Dr input tax / Cr AP) → payment (Dr AP / Cr Bank, in T06)
 *
 * A receipt never touches the P&L and a bill never touches inventory — that is the
 * whole point of the accrual account. If a receipt also posted the expense, a
 * company with goods received and no bill would show the cost twice.
 *
 * ## Partial receipts
 *
 * `po_lines.received_milli` is the running total. A receipt may not take more than
 * `qty_milli − received_milli`, and the PO status is derived from the sum rather
 * than set by hand: `confirmed` → `partially_received` → `received`. Cancelling a
 * posted receipt reverses its moves and decrements the running totals, so the
 * numbers always describe the receipts that exist.
 */

import { randomUUID } from 'node:crypto';

import type {
  MatchResult,
  PoDetail,
  PoFilter,
  PoInput,
  PoLineRow,
  PoRow,
  PoStatus,
  PurchaseAnalysisRow,
  ReceiptDetail,
  ReceiptFilter,
  ReceiptInput,
  ReceiptLineRow,
  ReceiptRow,
  ReceiptStatus,
  VendorStatement,
  VendorStatementRow,
} from '../../shared/ops';
import type { BillInput, DocumentLineInput, JournalLineInput } from '../../shared/finance';
import type { Paged } from '../../shared/types';
import { nowIso, todayIso } from '../../shared/dates';
import { cents, mulQty, sumCents } from '../../shared/money';
import { conn } from '../db/connection';
import { conflict, notFound, validation } from '../errors';
import { accountFor } from './accounts';
import { invalidateCache } from './cache';
import { computeTotals } from './finance.documents';
import { baseCurrency, reverseEntry, writeJournal, type JournalScope } from './finance.engine';
import { postMove } from './inventory';
import { evaluateMatch } from './match';
import { fiscalYearFor, nextNumber } from './settings';

const DEFAULT_PAGE_SIZE = 50;

function pageOf(filter: { page?: number; pageSize?: number }): { size: number; page: number; offset: number } {
  const size = Math.min(Math.max(Math.trunc(filter.pageSize ?? DEFAULT_PAGE_SIZE), 1), 200);
  const page = Math.max(Math.trunc(filter.page ?? 1), 1);
  return { size, page, offset: (page - 1) * size };
}

// ── purchase orders ──────────────────────────────────────────────────────────

const PO_SELECT = `
  SELECT po.*, v.name AS vendor_name,
         (SELECT COALESCE(SUM(qty_milli), 0) FROM po_lines WHERE po_id = po.id) AS ordered_milli,
         (SELECT COALESCE(SUM(received_milli), 0) FROM po_lines WHERE po_id = po.id) AS received_milli,
         (SELECT COUNT(*) FROM po_lines WHERE po_id = po.id) AS line_count
    FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id`;

interface PoDbRow {
  readonly id: string;
  readonly number: string | null;
  readonly vendor_id: string;
  readonly vendor_name: string;
  readonly date: string;
  readonly expected_date: string | null;
  readonly status: PoStatus;
  readonly currency: string;
  readonly subtotal_cents: number;
  readonly tax_cents: number;
  readonly total_cents: number;
  readonly ordered_milli: number;
  readonly received_milli: number;
  readonly line_count: number;
}

function toPoRow(row: PoDbRow): PoRow {
  return {
    id: row.id,
    number: row.number,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    date: row.date,
    expectedDate: row.expected_date,
    status: row.status,
    currency: row.currency,
    subtotalCents: Number(row.subtotal_cents),
    taxCents: Number(row.tax_cents),
    totalCents: Number(row.total_cents),
    orderedMilli: Number(row.ordered_milli),
    receivedMilli: Number(row.received_milli),
    lineCount: Number(row.line_count),
  };
}

export function listPos(filter: PoFilter = {}): Paged<PoRow> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.vendorId) {
    where.push('po.vendor_id = ?');
    params.push(filter.vendorId);
  }
  if (filter.status) {
    where.push('po.status = ?');
    params.push(filter.status);
  }
  if (filter.from) {
    where.push('po.date >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('po.date <= ?');
    params.push(filter.to);
  }
  if (filter.q) {
    where.push('(po.number LIKE ? OR v.name LIKE ?)');
    params.push(`${filter.q}%`, `${filter.q}%`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { size, offset } = pageOf(filter);
  const total = conn().one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id ${clause}`,
    params,
  );
  const rows = conn().all<PoDbRow>(`${PO_SELECT} ${clause} ORDER BY po.date DESC, po.created_at DESC LIMIT ? OFFSET ?`, [
    ...params,
    size,
    offset,
  ]);
  return { rows: rows.map(toPoRow), total: Number(total?.total ?? 0) };
}

export function getPo(id: string): PoDetail {
  const row = conn().one<PoDbRow & { notes: string | null; warehouse_id: string | null }>(
    `${PO_SELECT} WHERE po.id = ?`,
    [id],
  );
  if (!row) throw notFound('Purchase order');
  const lines = conn().all<{
    id: string;
    line_no: number;
    product_id: string | null;
    sku: string | null;
    description: string;
    qty_milli: number;
    received_milli: number;
    unit_price_cents: number;
    tax_id: string | null;
    net_cents: number;
    tax_cents: number;
  }>(
    `SELECT pl.id, pl.line_no, pl.product_id, p.sku, pl.description, pl.qty_milli, pl.received_milli,
            pl.unit_price_cents, pl.tax_id, pl.net_cents, pl.tax_cents
       FROM po_lines pl LEFT JOIN products p ON p.id = pl.product_id
      WHERE pl.po_id = ? ORDER BY pl.line_no`,
    [id],
  );
  const receiptIds = conn()
    .all<{ id: string }>("SELECT id FROM goods_receipts WHERE po_id = ? AND status = 'posted' ORDER BY date", [id])
    .map((entry) => entry.id);
  const billIds = conn()
    .all<{ id: string }>('SELECT id FROM bills WHERE po_id = ? ORDER BY date', [id])
    .map((entry) => entry.id);

  return {
    ...toPoRow(row),
    notes: row.notes,
    warehouseId: row.warehouse_id,
    lines: lines.map<PoLineRow>((line) => ({
      id: line.id,
      lineNo: Number(line.line_no),
      productId: line.product_id,
      sku: line.sku,
      description: line.description,
      qtyMilli: Number(line.qty_milli),
      receivedMilli: Number(line.received_milli),
      remainingMilli: Number(line.qty_milli) - Number(line.received_milli),
      unitPriceCents: Number(line.unit_price_cents),
      taxId: line.tax_id,
      netCents: Number(line.net_cents),
      taxCents: Number(line.tax_cents),
      totalCents: Number(line.net_cents) + Number(line.tax_cents),
    })),
    receiptIds,
    billIds,
  };
}

export function savePo(input: PoInput): PoDetail {
  const vendor = conn().one<{ id: string; currency: string | null }>('SELECT id, currency FROM vendors WHERE id = ?', [
    input.vendorId,
  ]);
  if (!vendor) throw validation('vendorId', 'Pick a vendor.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw validation('date', 'Pick a valid order date.');
  if (input.lines.length === 0) throw validation('lines', 'Add at least one line.');

  const totals = computeTotals(
    input.lines.map<DocumentLineInput>((line) => ({
      productId: line.productId ?? null,
      description: line.description,
      qtyMilli: line.qtyMilli,
      unitPriceCents: line.unitPriceCents,
      taxId: line.taxId ?? null,
    })),
  );

  const id = input.id ?? randomUUID();
  const at = nowIso();

  if (input.id) {
    const existing = conn().one<{ status: string }>('SELECT status FROM purchase_orders WHERE id = ?', [id]);
    if (!existing) throw notFound('Purchase order');
    if (String(existing.status) !== 'draft') {
      throw conflict('A confirmed purchase order is read-only. Cancel it and raise a new one.');
    }
    conn().run('DELETE FROM po_lines WHERE po_id = ?', [id]);
    conn().run(
      `UPDATE purchase_orders SET vendor_id = ?, date = ?, expected_date = ?, warehouse_id = ?,
         subtotal_cents = ?, tax_cents = ?, total_cents = ?, notes = ?, updated_at = ? WHERE id = ?`,
      [
        input.vendorId,
        input.date,
        input.expectedDate ?? null,
        input.warehouseId ?? null,
        totals.subtotalCents,
        totals.taxCents,
        totals.totalCents,
        input.notes?.trim() || null,
        at,
        id,
      ],
    );
  } else {
    conn().run(
      `INSERT INTO purchase_orders (id, number, vendor_id, date, expected_date, status, currency,
         subtotal_cents, tax_cents, total_cents, warehouse_id, notes, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.vendorId,
        input.date,
        input.expectedDate ?? null,
        vendor.currency ?? baseCurrency(),
        totals.subtotalCents,
        totals.taxCents,
        totals.totalCents,
        input.warehouseId ?? null,
        input.notes?.trim() || null,
        at,
        at,
      ],
    );
  }

  for (const [index, line] of totals.lines.entries()) {
    conn().run(
      `INSERT INTO po_lines (id, po_id, line_no, product_id, description, qty_milli, received_milli,
         unit_price_cents, tax_id, net_cents, tax_cents)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        randomUUID(),
        id,
        index + 1,
        line.productId,
        line.description,
        line.qtyMilli,
        line.unitPriceCents,
        line.taxId,
        line.netCents,
        line.taxCents,
      ],
    );
  }

  return getPo(id);
}

/** Confirms a draft order and allocates its number (BR-08: numbers at confirm). */
export function confirmPo(id: string): PoDetail {
  const po = getPo(id);
  if (po.status !== 'draft') throw conflict(`That order is already ${po.status.replace('_', ' ')}.`);
  const year = fiscalYearFor(po.date);
  const number = nextNumber('purchase_order', year.id);
  conn().run("UPDATE purchase_orders SET number = ?, status = 'confirmed', updated_at = ? WHERE id = ?", [
    number,
    nowIso(),
    id,
  ]);
  return getPo(id);
}

export function cancelPo(id: string, reason: string): PoDetail {
  const po = getPo(id);
  if (po.status === 'cancelled') throw conflict('That order is already cancelled.');
  if (po.status === 'received') throw conflict('A fully received order cannot be cancelled.');
  if ((reason ?? '').trim().length === 0) throw validation('reason', 'Say why the order is being cancelled.');
  if (po.receivedMilli > 0) {
    throw conflict(
      `${(po.receivedMilli / 1000).toFixed(3)} has already been received against this order. ` +
        'Cancel the receipts first, or close the order instead.',
    );
  }
  conn().run("UPDATE purchase_orders SET status = 'cancelled', updated_at = ? WHERE id = ?", [nowIso(), id]);
  return getPo(id);
}

/** Recomputes the PO status from its lines. Called after every receipt change. */
function refreshPoStatus(poId: string): void {
  const row = conn().one<{ ordered: number | null; received: number | null; status: string }>(
    `SELECT (SELECT COALESCE(SUM(qty_milli),0) FROM po_lines WHERE po_id = ?) AS ordered,
            (SELECT COALESCE(SUM(received_milli),0) FROM po_lines WHERE po_id = ?) AS received,
            status FROM purchase_orders WHERE id = ?`,
    [poId, poId, poId],
  );
  if (!row) return;
  if (row.status === 'cancelled') return;
  const ordered = Number(row.ordered ?? 0);
  const received = Number(row.received ?? 0);
  const next: PoStatus = received === 0 ? 'confirmed' : received >= ordered ? 'received' : 'partially_received';
  conn().run('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?', [next, nowIso(), poId]);
}

// ── goods receipts ───────────────────────────────────────────────────────────

const RECEIPT_SELECT = `
  SELECT gr.*, v.name AS vendor_name, w.name AS warehouse_name, l.name AS location_name,
         po.number AS po_number,
         (SELECT COALESCE(SUM(qty_milli * unit_cost_cents) / 1000, 0) FROM gr_lines WHERE receipt_id = gr.id) AS total_cents
    FROM goods_receipts gr
    JOIN vendors v ON v.id = gr.vendor_id
    JOIN warehouses w ON w.id = gr.warehouse_id
    LEFT JOIN locations l ON l.id = gr.location_id
    LEFT JOIN purchase_orders po ON po.id = gr.po_id`;

interface ReceiptDbRow {
  readonly id: string;
  readonly number: string | null;
  readonly po_id: string | null;
  readonly po_number: string | null;
  readonly vendor_id: string;
  readonly vendor_name: string;
  readonly date: string;
  readonly status: ReceiptStatus;
  readonly warehouse_id: string;
  readonly warehouse_name: string;
  readonly location_id: string | null;
  readonly location_name: string | null;
  readonly total_cents: number;
  readonly bill_id: string | null;
}

function toReceiptRow(row: ReceiptDbRow): ReceiptRow {
  return {
    id: row.id,
    number: row.number,
    poId: row.po_id,
    poNumber: row.po_number,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    date: row.date,
    status: row.status,
    warehouseId: row.warehouse_id,
    warehouseName: row.warehouse_name,
    locationId: row.location_id,
    locationName: row.location_name,
    totalCents: Number(row.total_cents),
    billId: row.bill_id,
  };
}

export function listReceipts(filter: ReceiptFilter = {}): Paged<ReceiptRow> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.poId) {
    where.push('gr.po_id = ?');
    params.push(filter.poId);
  }
  if (filter.vendorId) {
    where.push('gr.vendor_id = ?');
    params.push(filter.vendorId);
  }
  if (filter.status) {
    where.push('gr.status = ?');
    params.push(filter.status);
  }
  if (filter.from) {
    where.push('gr.date >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('gr.date <= ?');
    params.push(filter.to);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { size, offset } = pageOf(filter);
  const total = conn().one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM goods_receipts gr ${clause}`,
    params,
  );
  const rows = conn().all<ReceiptDbRow>(
    `${RECEIPT_SELECT} ${clause} ORDER BY gr.date DESC, gr.created_at DESC LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  return { rows: rows.map(toReceiptRow), total: Number(total?.total ?? 0) };
}

export function getReceipt(id: string): ReceiptDetail {
  const row = conn().one<ReceiptDbRow & { notes: string | null; journal_entry_id: string | null }>(
    `${RECEIPT_SELECT} WHERE gr.id = ?`,
    [id],
  );
  if (!row) throw notFound('Goods receipt');
  const lines = conn().all<{
    id: string;
    line_no: number;
    po_line_id: string | null;
    product_id: string;
    sku: string;
    product_name: string;
    qty_milli: number;
    unit_cost_cents: number;
    po_price_cents: number | null;
  }>(
    `SELECT gl.id, gl.line_no, gl.po_line_id, gl.product_id, p.sku, p.name AS product_name,
            gl.qty_milli, gl.unit_cost_cents, gl.po_price_cents
       FROM gr_lines gl JOIN products p ON p.id = gl.product_id
      WHERE gl.receipt_id = ? ORDER BY gl.line_no`,
    [id],
  );
  return {
    ...toReceiptRow(row),
    notes: row.notes,
    journalEntryId: row.journal_entry_id,
    lines: lines.map<ReceiptLineRow>((line) => ({
      id: line.id,
      lineNo: Number(line.line_no),
      poLineId: line.po_line_id,
      productId: line.product_id,
      sku: line.sku,
      productName: line.product_name,
      qtyMilli: Number(line.qty_milli),
      unitCostCents: Number(line.unit_cost_cents),
      valueCents: mulQty(cents(Number(line.unit_cost_cents)), Number(line.qty_milli)),
      poPriceCents: line.po_price_cents === null ? null : Number(line.po_price_cents),
    })),
  };
}

/** The location a receipt lands in: the one named, else the warehouse's default. */
function defaultLocationOf(warehouseId: string): string {
  const row = conn().one<{ id: string }>(
    'SELECT id FROM locations WHERE warehouse_id = ? AND is_active = 1 ORDER BY code LIMIT 1',
    [warehouseId],
  );
  if (!row) throw validation('warehouseId', 'That warehouse has no active location to receive into.');
  return row.id;
}

export function saveReceipt(input: ReceiptInput): ReceiptDetail {
  const vendor = conn().one<{ id: string }>('SELECT id FROM vendors WHERE id = ?', [input.vendorId]);
  if (!vendor) throw validation('vendorId', 'Pick a vendor.');
  const warehouse = conn().one<{ id: string }>('SELECT id FROM warehouses WHERE id = ?', [input.warehouseId]);
  if (!warehouse) throw validation('warehouseId', 'Pick a warehouse.');
  if (input.lines.length === 0) throw validation('lines', 'Receive at least one line.');

  const id = input.id ?? randomUUID();
  const at = nowIso();
  const locationId = input.locationId ?? defaultLocationOf(input.warehouseId);

  if (input.id) {
    const existing = conn().one<{ status: string }>('SELECT status FROM goods_receipts WHERE id = ?', [id]);
    if (!existing) throw notFound('Goods receipt');
    if (String(existing.status) !== 'draft') throw conflict('Posted receipts are read-only.');
    conn().run('DELETE FROM gr_lines WHERE receipt_id = ?', [id]);
    conn().run(
      `UPDATE goods_receipts SET po_id = ?, vendor_id = ?, date = ?, warehouse_id = ?, location_id = ?,
         notes = ?, updated_at = ? WHERE id = ?`,
      [input.poId ?? null, input.vendorId, input.date, input.warehouseId, locationId, input.notes?.trim() || null, at, id],
    );
  } else {
    conn().run(
      `INSERT INTO goods_receipts (id, number, po_id, vendor_id, date, status, warehouse_id, location_id,
         notes, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      [
        id,
        input.poId ?? null,
        input.vendorId,
        input.date,
        input.warehouseId,
        locationId,
        input.notes?.trim() || null,
        at,
        at,
      ],
    );
  }

  for (const [index, line] of input.lines.entries()) {
    if (!Number.isInteger(line.qtyMilli) || line.qtyMilli <= 0) {
      throw validation(`lines.${String(index)}.qtyMilli`, 'Received quantity must be greater than zero.');
    }
    let poPrice: number | null = null;
    if (line.poLineId) {
      const poLine = conn().one<{ unit_price_cents: number; qty_milli: number; received_milli: number; product_id: string | null }>(
        'SELECT unit_price_cents, qty_milli, received_milli, product_id FROM po_lines WHERE id = ?',
        [line.poLineId],
      );
      if (!poLine) throw notFound('Purchase order line');
      poPrice = Number(poLine.unit_price_cents);
      // Over-receipt is refused at save time *and* again at post time, because a
      // draft can sit while another receipt is posted against the same line.
      const remaining = Number(poLine.qty_milli) - Number(poLine.received_milli);
      if (line.qtyMilli > remaining) {
        throw conflict(
          `Only ${(remaining / 1000).toFixed(3)} is still outstanding on that order line, ` +
            `so ${(line.qtyMilli / 1000).toFixed(3)} cannot be received.`,
        );
      }
    }
    conn().run(
      `INSERT INTO gr_lines (id, receipt_id, line_no, po_line_id, product_id, qty_milli, unit_cost_cents,
         po_price_cents, lot_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        id,
        index + 1,
        line.poLineId ?? null,
        line.productId,
        line.qtyMilli,
        line.unitCostCents ?? poPrice ?? 0,
        poPrice,
        line.lotRef ?? null,
      ],
    );
  }

  return getReceipt(id);
}

/**
 * Posts a receipt: stock in, one GRNI journal for the whole document, PO totals
 * updated.
 *
 * The moves are posted with `suppressJournal` so the accrual is a single entry
 * rather than one per line — easier to read on the ledger and it matches §B.4,
 * which describes the receipt as one posting.
 */
export function postReceipt(id: string, scope: JournalScope): ReceiptDetail {
  const receipt = getReceipt(id);
  if (receipt.status !== 'draft') throw conflict(`That receipt is already ${receipt.status}.`);
  if (receipt.lines.length === 0) throw conflict('Add at least one line before posting.');

  // Re-check the outstanding quantity: another receipt may have posted since save.
  if (receipt.poId) {
    for (const line of receipt.lines) {
      if (!line.poLineId) continue;
      const poLine = conn().one<{ qty_milli: number; received_milli: number }>(
        'SELECT qty_milli, received_milli FROM po_lines WHERE id = ?',
        [line.poLineId],
      );
      const remaining = Number(poLine?.qty_milli ?? 0) - Number(poLine?.received_milli ?? 0);
      if (line.qtyMilli > remaining) {
        throw conflict(
          `Only ${(remaining / 1000).toFixed(3)} of ${line.sku} is still outstanding on the order, ` +
            `so this receipt cannot take ${(line.qtyMilli / 1000).toFixed(3)}.`,
        );
      }
    }
  }

  const at = nowIso();
  const year = fiscalYearFor(receipt.date);
  const number = nextNumber('goods_receipt', year.id);

  let total = 0;
  const stockLocation = receipt.locationId ?? defaultLocationOf(receipt.warehouseId);
  for (const line of receipt.lines) {
    const result = postMove(
      {
        type: 'receipt',
        productId: line.productId,
        toLocationId: stockLocation,
        qtyMilli: line.qtyMilli,
        unitCostCents: line.unitCostCents,
        movedAt: receipt.date,
        reference: number,
        sourceType: 'goods_receipt',
        sourceId: receipt.id,
        suppressJournal: true,
      },
      scope,
    );
    total += result.move.valueCents;
  }

  const lines: JournalLineInput[] = [
    {
      accountId: accountFor('inventory', 'Inventory'),
      debitCents: cents(total),
      description: `Goods received ${number}`,
      partnerType: 'vendor',
      partnerId: receipt.vendorId,
    },
    {
      accountId: accountFor('grni', 'Goods received not invoiced'),
      creditCents: cents(total),
      description: `Goods received ${number}`,
      partnerType: 'vendor',
      partnerId: receipt.vendorId,
    },
  ];

  const entry = writeJournal(scope, {
    date: receipt.date,
    journalCode: 'PUR',
    memo: `Goods received ${number} — ${receipt.vendorName}`,
    lines,
    sourceType: 'goods_receipt',
    sourceId: receipt.id,
  });

  conn().run(
    `UPDATE goods_receipts SET number = ?, status = 'posted', posted_at = ?, posted_by = ?,
       journal_entry_id = ?, updated_at = ? WHERE id = ?`,
    [number, at, scope.actorId, entry.id, at, receipt.id],
  );
  conn().run('UPDATE stock_moves SET journal_entry_id = ? WHERE source_type = ? AND source_id = ?', [
    entry.id,
    'goods_receipt',
    receipt.id,
  ]);

  if (receipt.poId) {
    for (const line of receipt.lines) {
      if (!line.poLineId) continue;
      conn().run('UPDATE po_lines SET received_milli = received_milli + ? WHERE id = ?', [
        line.qtyMilli,
        line.poLineId,
      ]);
    }
    refreshPoStatus(receipt.poId);
  }

  invalidateCache('report:');
  return getReceipt(receipt.id);
}

/** Cancels a posted receipt: reverses its journal and un-receives the lines. */
export function cancelReceipt(id: string, reason: string, scope: JournalScope): ReceiptDetail {
  const receipt = getReceipt(id);
  if (receipt.status === 'cancelled') throw conflict('That receipt is already cancelled.');
  if ((reason ?? '').trim().length === 0) throw validation('reason', 'Say why the receipt is being cancelled.');

  if (receipt.status === 'posted') {
    if (receipt.journalEntryId) reverseEntry(receipt.journalEntryId, reason, scope);
    // Reverse the stock: an issue of the same quantity from the same location.
    const stockLocation = receipt.locationId ?? defaultLocationOf(receipt.warehouseId);
    for (const line of receipt.lines) {
      postMove(
        {
          type: 'issue',
          productId: line.productId,
          fromLocationId: stockLocation,
          qtyMilli: -line.qtyMilli,
          movedAt: todayIso(),
          reason: `Receipt ${receipt.number ?? ''} cancelled: ${reason}`,
          sourceType: 'goods_receipt_cancel',
          sourceId: receipt.id,
          suppressJournal: true,
        },
        scope,
      );
      if (line.poLineId) {
        conn().run('UPDATE po_lines SET received_milli = MAX(0, received_milli - ?) WHERE id = ?', [
          line.qtyMilli,
          line.poLineId,
        ]);
      }
    }
    if (receipt.poId) refreshPoStatus(receipt.poId);
  }

  conn().run("UPDATE goods_receipts SET status = 'cancelled', updated_at = ? WHERE id = ?", [nowIso(), id]);
  invalidateCache('report:');
  return getReceipt(id);
}

// ── bill from receipt ────────────────────────────────────────────────────────

/**
 * Pre-fills a vendor bill from a posted receipt (US-30).
 *
 * Returns a `BillInput` rather than saving, so the operator sees the document in
 * the builder, can correct a price, and only then posts it. The line carries both
 * the PO price and the received quantity, which is what the match compares.
 */
export function billFromReceipt(receiptId: string): BillInput {
  const receipt = getReceipt(receiptId);
  if (receipt.status !== 'posted') {
    throw conflict('Only a posted receipt can be billed. Post it first.');
  }
  if (receipt.billId) throw conflict(`That receipt has already been billed on ${receipt.billId}.`);

  const vendor = conn().one<{ payment_terms_days: number; currency: string | null }>(
    'SELECT payment_terms_days, currency FROM vendors WHERE id = ?',
    [receipt.vendorId],
  );
  const terms = Number(vendor?.payment_terms_days ?? 0);
  const due = new Date(`${receipt.date}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + terms);
  const dueDate = due.toISOString().slice(0, 10);

  return {
    vendorId: receipt.vendorId,
    date: todayIso(),
    dueDate,
    currency: vendor?.currency ?? baseCurrency(),
    poId: receipt.poId,
    receiptIds: [receipt.id],
    notes: `From goods receipt ${receipt.number ?? ''}`,
    lines: receipt.lines.map<DocumentLineInput>((line) => ({
      productId: line.productId,
      description: line.productName,
      qtyMilli: line.qtyMilli,
      unitPriceCents: line.unitCostCents,
      poPriceCents: line.poPriceCents,
      receivedQtyMilli: line.qtyMilli,
    })),
  };
}

/** The match preview for a bill. Read-only; the same function `postBill` uses. */
export function billMatch(billId: string): MatchResult {
  return evaluateMatch(billId);
}

// ── vendor reporting ─────────────────────────────────────────────────────────

export function vendorStatement(vendorId: string, from: string, to: string): VendorStatement {
  const vendor = conn().one<{ name: string; payment_terms_days: number; currency: string | null }>(
    'SELECT name, payment_terms_days, currency FROM vendors WHERE id = ?',
    [vendorId],
  );
  if (!vendor) throw notFound('Vendor');

  const rows = conn().all<{
    id: string;
    number: string | null;
    date: string;
    due_date: string;
    status: string;
    total_cents: number;
    paid_cents: number;
  }>(
    `SELECT id, number, date, due_date, status, total_cents, paid_cents FROM bills
      WHERE vendor_id = ? AND date >= ? AND date <= ? AND status <> 'void'
      ORDER BY date`,
    [vendorId, from, to],
  );

  const today = todayIso();
  const statementRows: VendorStatementRow[] = rows.map((row) => {
    const total = Number(row.total_cents);
    const paid = Number(row.paid_cents);
    const overdue =
      paid < total && row.due_date < today
        ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.due_date}T00:00:00Z`)) / 86_400_000)
        : 0;
    return {
      id: row.id,
      number: row.number,
      date: row.date,
      dueDate: row.due_date,
      status: row.status,
      totalCents: total,
      paidCents: paid,
      openCents: total - paid,
      daysOverdue: overdue,
    };
  });

  const billed = sumCents(statementRows.map((row) => cents(row.totalCents)));
  const paid = sumCents(statementRows.map((row) => cents(row.paidCents)));
  const open = sumCents(statementRows.map((row) => cents(row.openCents)));
  const overdue = sumCents(statementRows.filter((row) => row.daysOverdue > 0).map((row) => cents(row.openCents)));

  return {
    vendorId,
    vendorName: vendor.name,
    termsDays: Number(vendor.payment_terms_days),
    currency: vendor.currency ?? baseCurrency(),
    from,
    to,
    rows: statementRows,
    billedCents: billed,
    paidCents: paid,
    openCents: open,
    overdueCents: overdue,
  };
}

/** Spend analysis grouped by vendor, product or month. */
export function purchaseAnalysis(
  groupBy: 'vendor' | 'product' | 'month',
  from: string,
  to: string,
): PurchaseAnalysisRow[] {
  if (groupBy === 'vendor') {
    const rows = conn().all<{ key: string; label: string; billed: number; docs: number }>(
      `SELECT v.id AS key, v.name AS label, COALESCE(SUM(b.total_cents), 0) AS billed, COUNT(b.id) AS docs
         FROM vendors v LEFT JOIN bills b ON b.vendor_id = v.id AND b.date >= ? AND b.date <= ? AND b.status <> 'void'
        GROUP BY v.id HAVING billed > 0 ORDER BY billed DESC`,
      [from, to],
    );
    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      orderCents: 0,
      billedCents: Number(row.billed),
      documentCount: Number(row.docs),
      qtyMilli: 0,
    }));
  }

  if (groupBy === 'product') {
    const rows = conn().all<{ key: string; label: string; qty: number; billed: number; docs: number }>(
      `SELECT p.id AS key, p.name AS label,
              COALESCE(SUM(bl.qty_milli), 0) AS qty,
              COALESCE(SUM(bl.net_cents), 0) AS billed,
              COUNT(DISTINCT bl.bill_id) AS docs
         FROM bill_lines bl
         JOIN bills b ON b.id = bl.bill_id
         JOIN products p ON p.id = bl.product_id
        WHERE b.date >= ? AND b.date <= ? AND b.status <> 'void'
        GROUP BY p.id ORDER BY billed DESC`,
      [from, to],
    );
    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      orderCents: 0,
      billedCents: Number(row.billed),
      documentCount: Number(row.docs),
      qtyMilli: Number(row.qty),
    }));
  }

  const rows = conn().all<{ key: string; billed: number; docs: number }>(
    `SELECT substr(b.date, 1, 7) AS key, COALESCE(SUM(b.total_cents), 0) AS billed, COUNT(b.id) AS docs
       FROM bills b WHERE b.date >= ? AND b.date <= ? AND b.status <> 'void'
      GROUP BY key ORDER BY key`,
    [from, to],
  );
  return rows.map((row) => ({
    key: row.key,
    label: row.key,
    orderCents: 0,
    billedCents: Number(row.billed),
    documentCount: Number(row.docs),
    qtyMilli: 0,
  }));
}
