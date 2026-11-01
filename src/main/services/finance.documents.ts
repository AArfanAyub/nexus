/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * AR/AP documents: invoices, bills, totals and posting (T06, §B.4).
 *
 * ## Rounding (BR-06, BR-07, decision D-03)
 *
 * Every line is computed in **milli-cents** (price × milli-quantity), which is
 * exact integer arithmetic. Discounts and tax are rounded half-to-even *per
 * line*; the document total is rounded half-up **once**, and the resulting
 * difference is pushed onto the largest line so that
 *
 *     Σ line.total_cents === document.total_cents
 *     line.net_cents + line.tax_cents === line.total_cents   (every line)
 *
 * hold to the cent. That is what makes "three lines of 33.335 → 100.01" and
 * "gross 120.00 @ 20% → net 100.00 + tax 20.00" both true at once.
 *
 * ## Posting
 *
 * `postInvoice` / `postBill` never write a journal line themselves: they build
 * the §B.4 line set and hand it to `writeJournal`, so BR-01 and BR-04 apply
 * unchanged. Numbers are allocated inside the same transaction (BR-08), and a
 * draft never holds a number, so deleting one cannot burn it.
 */

import { randomUUID } from 'node:crypto';

import type {
  ArStatus,
  BillDetail,
  BillInput,
  BillRow,
  ComputedLine,
  DocumentLineInput,
  DocumentTotals,
  InvoiceDetail,
  InvoiceInput,
  InvoiceRow,
  JournalLineInput,
} from '../../shared/finance';
import { nowIso, todayIso } from '../../shared/dates';
import { cents, divHalfEven, divHalfUp, mulQty, type Cents } from '../../shared/money';
import { conn } from '../db/connection';
import { conflict, notFound, validation } from '../errors';
import { accountFor, firstPostable } from './accounts';
import { append as auditAppend } from './audit';
import { baseCurrency, reverseEntry, writeJournal, type JournalScope } from './finance.engine';
import { evaluateMatch, recordMatchState } from './match';
import { fiscalYearFor, nextNumber } from './settings';

/** A tax row as the totals engine needs it. */
interface TaxLookup {
  readonly id: string;
  readonly name: string;
  readonly rateBp: number;
  readonly isInclusive: boolean;
  readonly accountId: string | null;
}

function taxFor(taxId: string | null): TaxLookup | null {
  if (!taxId) return null;
  const row = conn().one<{
    id: string;
    name: string;
    rate_bp: number;
    is_inclusive: number;
    account_id: string | null;
  }>('SELECT id, name, rate_bp, is_inclusive, account_id FROM taxes WHERE id = ?', [taxId]);
  if (!row) throw validation('lines.taxId', 'That tax rate no longer exists.');
  return {
    id: row.id,
    name: row.name,
    rateBp: Number(row.rate_bp),
    isInclusive: Number(row.is_inclusive) === 1,
    accountId: row.account_id,
  };
}

/**
 * Computes every line and every total. Pure: reads taxes, writes nothing.
 * Exported so the builder can preview totals without saving.
 */
export function computeTotals(lines: readonly DocumentLineInput[]): DocumentTotals {
  if (lines.length === 0) throw validation('lines', 'Add at least one line.');
  if (lines.length > 200) throw validation('lines', 'A document can carry at most 200 lines.');

  interface Work {
    readonly input: DocumentLineInput;
    readonly tax: TaxLookup | null;
    readonly netMilli: number;
    readonly taxMilli: number;
    readonly totalMilli: number;
    readonly discountMilli: number;
  }

  const work: Work[] = lines.map((line, index) => {
    const description = line.description.trim();
    if (description.length === 0) {
      throw validation(`lines.${String(index)}.description`, 'Every line needs a description.');
    }
    if (!Number.isInteger(line.qtyMilli) || line.qtyMilli <= 0) {
      throw validation(`lines.${String(index)}.qtyMilli`, 'Quantity must be greater than zero.');
    }
    if (!Number.isInteger(line.unitPriceCents)) {
      throw validation(`lines.${String(index)}.unitPriceCents`, 'Price must be a whole number of minor units.');
    }
    const discountBp = line.discountBp ?? 0;
    if (!Number.isInteger(discountBp) || discountBp < 0 || discountBp > 10_000) {
      throw validation(`lines.${String(index)}.discountBp`, 'A discount is between 0% and 100%.');
    }

    const tax = taxFor(line.taxId ?? null);
    const grossMilli = line.unitPriceCents * line.qtyMilli;
    const discountMilli = divHalfEven(grossMilli * discountBp, 10_000);
    const netMilli = grossMilli - discountMilli;

    if (!tax) {
      return { input: line, tax, netMilli, taxMilli: 0, totalMilli: netMilli, discountMilli };
    }
    if (tax.isInclusive) {
      // BR-07: back-compute so net + tax === gross by construction.
      const taxMilli = divHalfEven(netMilli * tax.rateBp, 10_000 + tax.rateBp);
      return { input: line, tax, netMilli: netMilli - taxMilli, taxMilli, totalMilli: netMilli, discountMilli };
    }
    const taxMilli = divHalfEven(netMilli * tax.rateBp, 10_000);
    return { input: line, tax, netMilli, taxMilli, totalMilli: netMilli + taxMilli, discountMilli };
  });

  // BR-06: round the document total once, half-up.
  const documentTotal = divHalfUp(
    work.reduce((total, line) => total + line.totalMilli, 0),
    1000,
  );

  const computed: ComputedLine[] = work.map((line) => {
    const totalCents = divHalfUp(line.totalMilli, 1000);
    const taxCents = divHalfUp(line.taxMilli, 1000);
    return {
      description: line.input.description.trim(),
      productId: line.input.productId ?? null,
      qtyMilli: line.input.qtyMilli,
      unitPriceCents: line.input.unitPriceCents,
      discountBp: line.input.discountBp ?? 0,
      taxId: line.input.taxId ?? null,
      accountId: line.input.accountId ?? null,
      /**
       * BR-07: for an inclusive price the gross is fixed, so the tax is rounded
       * once and the net is whatever is left. Rounding both halves separately
       * lets them drift a cent apart — which is exactly the defect that makes a
       * tax report disagree with an invoice.
       */
      netCents: line.tax?.isInclusive ? totalCents - taxCents : divHalfUp(line.netMilli, 1000),
      taxCents,
      totalCents,
      // Carried through untouched: the three-way match compares the PO price and
      // the received quantity, and neither is arithmetic this engine owns.
      poPriceCents: line.input.poPriceCents ?? null,
      receivedQtyMilli: line.input.receivedQtyMilli ?? null,
    };
  });

  // Push the rounding difference onto the largest line so the document adds up.
  const rounded = computed.reduce((total, line) => total + line.totalCents, 0);
  const difference = documentTotal - rounded;
  if (difference !== 0 && computed.length > 0) {
    let target = 0;
    for (let index = 1; index < computed.length; index += 1) {
      const candidate = computed[index];
      const best = computed[target];
      if (candidate && best && Math.abs(candidate.totalCents) > Math.abs(best.totalCents)) target = index;
    }
    const line = computed[target];
    const source = work[target];
    if (line && source) {
      const total = line.totalCents + difference;
      // Keep net + tax === total: the residual belongs to whichever side the
      // rounding moved, never to both.
      computed[target] = source.tax?.isInclusive
        ? { ...line, totalCents: total, netCents: total - line.taxCents }
        : { ...line, totalCents: total, taxCents: total - line.netCents };
    }
  }

  const subtotal = computed.reduce((total, line) => total + line.netCents, 0);
  const tax = computed.reduce((total, line) => total + line.taxCents, 0);
  const discount = work.reduce((total, line) => total + divHalfUp(line.discountMilli, 1000), 0);

  return {
    lines: computed,
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: computed.reduce((total, line) => total + line.totalCents, 0),
  };
}

// ── status ───────────────────────────────────────────────────────────────────

/**
 * Status is derived, never trusted from the row: a payment can make an invoice
 * `paid` while the stored column still says `posted`, and `overdue` is a
 * function of today's date, so storing it would guarantee staleness.
 */
export function deriveStatus(
  stored: string,
  totalCents: number,
  paidCents: number,
  dueDate: string,
  today = todayIso(),
): ArStatus {
  if (stored === 'draft' || stored === 'void') return stored as ArStatus;
  if (paidCents >= totalCents && totalCents > 0) return 'paid';
  if (paidCents > 0) return 'partially_paid';
  if (dueDate < today) return 'overdue';
  return 'posted';
}

function daysOverdue(dueDate: string, status: ArStatus, today = todayIso()): number {
  if (status === 'paid' || status === 'void' || status === 'draft') return 0;
  if (dueDate >= today) return 0;
  return Math.round((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${dueDate}T00:00:00Z`).getTime()) / 86_400_000);
}

// ── invoices ─────────────────────────────────────────────────────────────────

const INVOICE_SELECT = `
  SELECT i.*, c.name AS customer_name
    FROM invoices i JOIN customers c ON c.id = i.customer_id`;

function toInvoiceRow(row: Record<string, unknown>): InvoiceRow {
  const total = Number(row['total_cents'] ?? 0);
  const paid = Number(row['paid_cents'] ?? 0);
  const status = deriveStatus(String(row['status']), total, paid, String(row['due_date']));
  return {
    id: String(row['id']),
    number: row['number'] === null ? null : String(row['number']),
    customerId: String(row['customer_id']),
    customerName: String(row['customer_name'] ?? ''),
    date: String(row['date']),
    dueDate: String(row['due_date']),
    status,
    currency: String(row['currency']),
    subtotalCents: Number(row['subtotal_cents'] ?? 0),
    discountCents: Number(row['discount_cents'] ?? 0),
    taxCents: Number(row['tax_cents'] ?? 0),
    totalCents: total,
    paidCents: paid,
    balanceCents: total - paid,
    journalEntryId: row['journal_entry_id'] === null ? null : String(row['journal_entry_id']),
    notes: row['notes'] === null ? null : String(row['notes']),
    terms: row['terms'] === null ? null : String(row['terms']),
    postedAt: row['posted_at'] === null ? null : String(row['posted_at']),
    daysOverdue: daysOverdue(String(row['due_date']), status),
  };
}

function invoiceLines(invoiceId: string): readonly ComputedLine[] {
  const rows = conn().all<{
    description: string;
    product_id: string | null;
    qty_milli: number;
    unit_price_cents: number;
    discount_bp: number;
    tax_id: string | null;
    account_id: string | null;
    net_cents: number;
    tax_cents: number;
    total_cents: number;
  }>(
    `SELECT description, product_id, qty_milli, unit_price_cents, discount_bp, tax_id, account_id,
            net_cents, tax_cents, total_cents
       FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no`,
    [invoiceId],
  );
  return rows.map((row) => ({
    description: row.description,
    productId: row.product_id,
    qtyMilli: Number(row.qty_milli),
    unitPriceCents: Number(row.unit_price_cents),
    discountBp: Number(row.discount_bp),
    taxId: row.tax_id,
    accountId: row.account_id,
    netCents: Number(row.net_cents),
    taxCents: Number(row.tax_cents),
    totalCents: Number(row.total_cents),
  }));
}

export function getInvoice(id: string): InvoiceDetail {
  const row = conn().one<Record<string, unknown>>(`${INVOICE_SELECT} WHERE i.id = ?`, [id]);
  if (!row) throw notFound('Invoice');
  return { ...toInvoiceRow(row), lines: invoiceLines(id) };
}

export interface InvoiceFilter {
  readonly from?: string;
  readonly to?: string;
  readonly customerId?: string;
  readonly status?: ArStatus;
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export function listInvoices(filter: InvoiceFilter = {}): { readonly rows: readonly InvoiceRow[]; readonly total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.from) {
    where.push('i.date >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('i.date <= ?');
    params.push(filter.to);
  }
  if (filter.customerId) {
    where.push('i.customer_id = ?');
    params.push(filter.customerId);
  }
  if (filter.q && filter.q.trim().length > 0) {
    where.push('(i.number LIKE ? OR c.name LIKE ?)');
    const like = `%${filter.q.trim()}%`;
    params.push(like, like);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(Math.max(Math.trunc(filter.pageSize ?? 100), 1), 1000);
  const page = Math.max(Math.trunc(filter.page ?? 1), 1);

  // Status is derived (a payment or the calendar changes it), so it cannot be a
  // SQL predicate — filter first, then slice, or page 2 would skip rows.
  const all = conn()
    .all<Record<string, unknown>>(`${INVOICE_SELECT} ${clause} ORDER BY i.date DESC, i.created_at DESC`, params)
    .map(toInvoiceRow)
    .filter((row) => !filter.status || row.status === filter.status);
  return { rows: all.slice((page - 1) * pageSize, page * pageSize), total: all.length };
}

function assertEditableInvoice(id: string): { readonly status: string } {
  const row = conn().one<{ status: string }>('SELECT status FROM invoices WHERE id = ?', [id]);
  if (!row) throw notFound('Invoice');
  if (String(row.status) !== 'draft') {
    throw conflict('Posted invoices are read-only. Void it and raise a new one.');
  }
  return { status: String(row.status) };
}

/** Creates or replaces a draft invoice. Totals are computed here, never sent. */
export function saveInvoice(input: InvoiceInput, _scope: JournalScope): InvoiceDetail {
  const customer = conn().one<{ id: string }>('SELECT id FROM customers WHERE id = ?', [input.customerId]);
  if (!customer) throw validation('customerId', 'Pick a customer.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
    throw validation('date', 'Pick a valid date and due date.');
  }
  if (input.dueDate < input.date) throw validation('dueDate', 'The due date cannot be before the invoice date.');

  const totals = computeTotals(input.lines);
  const id = input.id ?? randomUUID();
  if (input.id) assertEditableInvoice(input.id);

  const at = nowIso();
  if (input.id) {
    conn().run('DELETE FROM invoice_lines WHERE invoice_id = ?', [id]);
    conn().run(
      `UPDATE invoices SET customer_id = ?, date = ?, due_date = ?, currency = ?, subtotal_cents = ?,
         discount_cents = ?, tax_cents = ?, total_cents = ?, notes = ?, terms = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.customerId,
        input.date,
        input.dueDate,
        input.currency,
        totals.subtotalCents,
        totals.discountCents,
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
      `INSERT INTO invoices (id, number, customer_id, date, due_date, status, currency, subtotal_cents,
         discount_cents, tax_cents, total_cents, paid_cents, notes, terms, source_type, source_id,
         custom_json, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, '{}', ?, ?)`,
      [
        id,
        input.customerId,
        input.date,
        input.dueDate,
        input.currency,
        totals.subtotalCents,
        totals.discountCents,
        totals.taxCents,
        totals.totalCents,
        input.notes?.trim() || null,
        input.terms?.trim() || null,
        input.sourceType ?? null,
        input.sourceId ?? null,
        at,
        at,
      ],
    );
  }

  for (const [index, line] of totals.lines.entries()) {
    conn().run(
      `INSERT INTO invoice_lines (id, invoice_id, line_no, product_id, description, qty_milli,
         unit_price_cents, discount_bp, tax_id, net_cents, tax_cents, total_cents, account_id)
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
        line.netCents,
        line.taxCents,
        line.totalCents,
        line.accountId,
      ],
    );
  }

  return getInvoice(id);
}

/**
 * First **postable** account among `codes` — now imported from `./accounts` so
 * inventory and purchasing resolve the chart identically. The reasoning that used
 * to live here moved with it.
 */

/** Revenue account for a line: the line's account, the product's income account, or the sales leaf. */
function revenueAccountFor(line: ComputedLine): string {
  if (line.accountId) return line.accountId;
  if (line.productId) {
    const product = conn().one<{ income_account_id: string | null }>(
      'SELECT income_account_id FROM products WHERE id = ?',
      [line.productId],
    );
    if (product?.income_account_id) return product.income_account_id;
  }
  return firstPostable(['4010', '4020', '4000'], 'Sales');
}

/** Expense (or inventory) account for a bill line. */
function expenseAccountFor(line: ComputedLine): string {
  if (line.accountId) return line.accountId;
  if (line.productId) {
    const product = conn().one<{ expense_account_id: string | null; is_stock_tracked: number }>(
      'SELECT expense_account_id, is_stock_tracked FROM products WHERE id = ?',
      [line.productId],
    );
    if (product?.expense_account_id) return product.expense_account_id;
    if (Number(product?.is_stock_tracked ?? 0) === 1) {
      return firstPostable(['1210', '1240', '1250', '1200'], 'Inventory');
    }
  }
  return firstPostable(['5010', '6010', '5000'], 'Expense');
}

/**
 * Posts a draft invoice: allocates the number, writes the §B.4 journal and
 * freezes the row — all inside the caller's transaction.
 */
export function postInvoice(invoiceId: string, scope: JournalScope): InvoiceDetail {
  const invoice = getInvoice(invoiceId);
  if (invoice.status !== 'draft') throw conflict('That invoice has already been posted.');
  if (invoice.lines.length === 0) throw validation('lines', 'Add at least one line before posting.');
  if (invoice.totalCents <= 0) throw conflict('An invoice must be worth more than zero before it can be posted.');

  const year = fiscalYearFor(invoice.date);
  const number = nextNumber('invoice', year.id);

  const lines: JournalLineInput[] = [
    {
      accountCode: '1100',
      debitCents: invoice.totalCents,
      description: `Invoice ${number}`,
      partnerType: 'customer',
      partnerId: invoice.customerId,
    },
  ];

  // Revenue grouped by account (§B.4: one credit per revenue account).
  const byAccount = new Map<string, Cents>();
  for (const line of invoice.lines) {
    const account = revenueAccountFor(line);
    byAccount.set(account, cents((byAccount.get(account) ?? 0) + line.netCents));
  }
  for (const [accountId, amount] of byAccount) {
    if (amount === 0) continue;
    lines.push({
      accountId,
      creditCents: amount,
      description: `Invoice ${number}`,
      partnerType: 'customer',
      partnerId: invoice.customerId,
    });
  }

  // Tax grouped by rate, using the tax rate's own payable account.
  const byTax = new Map<string, Cents>();
  for (const line of invoice.lines) {
    if (!line.taxId || line.taxCents === 0) continue;
    byTax.set(line.taxId, cents((byTax.get(line.taxId) ?? 0) + line.taxCents));
  }
  for (const [taxId, amount] of byTax) {
    const tax = taxFor(taxId);
    const accountId = tax?.accountId ?? firstPostable(['2200'], 'Tax payable');
    lines.push({ accountId, creditCents: amount, taxId, description: `Tax on ${number}` });
  }

  const entry = writeJournal(scope, {
    date: invoice.date,
    journalCode: 'SAL',
    memo: `Invoice ${number} — ${invoice.customerName}`,
    lines,
    sourceType: 'invoice',
    sourceId: invoice.id,
  });

  const at = nowIso();
  conn().run(
    `UPDATE invoices SET number = ?, status = 'posted', journal_entry_id = ?, period_id = ?,
       posted_at = ?, posted_by = ?, updated_at = ? WHERE id = ?`,
    [number, entry.id, periodIdFor(invoice.date), at, scope.actorId, at, invoice.id],
  );
  return getInvoice(invoice.id);
}

function periodIdFor(date: string): string | null {
  const row = conn().one<{ id: string }>(
    'SELECT id FROM periods WHERE start_date <= ? AND end_date >= ? LIMIT 1',
    [date, date],
  );
  return row?.id ?? null;
}

/**
 * Voids a posted invoice by reversing its journal (never by deleting it).
 *
 * A draft has nothing to reverse, so it is simply discarded — no number was ever
 * allocated (BR-08), and the returned row says `void` so the caller can refresh.
 */
export function voidInvoice(invoiceId: string, reason: string, scope: JournalScope): InvoiceDetail {
  const invoice = getInvoice(invoiceId);
  if (invoice.status === 'void') throw conflict('That invoice is already void.');
  if (invoice.status === 'draft') {
    conn().run('DELETE FROM invoice_lines WHERE invoice_id = ?', [invoiceId]);
    conn().run('DELETE FROM invoices WHERE id = ?', [invoiceId]);
    return { ...invoice, status: 'void', lines: [] };
  }
  if (invoice.paidCents > 0) {
    throw conflict('Remove the payments allocated to this invoice before voiding it.');
  }
  if (!invoice.journalEntryId) throw conflict('That invoice has no journal entry to reverse.');

  if (reason.trim().length < 3) throw validation('reason', 'Say why the invoice is being voided.');
  writeJournalReverse(invoice.journalEntryId, `Invoice ${invoice.number ?? ''} voided: ${reason}`, scope);
  const at = nowIso();
  conn().run("UPDATE invoices SET status = 'void', updated_at = ? WHERE id = ?", [at, invoiceId]);
  return getInvoice(invoiceId);
}

/** Reverses a document's journal entry, tagged as a reversal rather than a sale. */
function writeJournalReverse(entryId: string, memo: string, scope: JournalScope): void {
  const reversed = reverseEntry(entryId, memo, scope);
  conn().run('UPDATE journal_entries SET source_type = ? WHERE id = ?', ['reversal', reversed.id]);
}

// ── bills ────────────────────────────────────────────────────────────────────

const BILL_SELECT = `
  SELECT b.*, v.name AS vendor_name
    FROM bills b JOIN vendors v ON v.id = b.vendor_id`;

function toBillRow(row: Record<string, unknown>): BillRow {
  const total = Number(row['total_cents'] ?? 0);
  const paid = Number(row['paid_cents'] ?? 0);
  const status = deriveStatus(String(row['status']), total, paid, String(row['due_date']));
  return {
    id: String(row['id']),
    number: row['number'] === null ? null : String(row['number']),
    vendorId: String(row['vendor_id']),
    vendorName: String(row['vendor_name'] ?? ''),
    vendorRef: row['vendor_ref'] === null ? null : String(row['vendor_ref']),
    date: String(row['date']),
    dueDate: String(row['due_date']),
    status: String(row['status']) === 'match_exception' ? 'match_exception' : status,
    currency: String(row['currency']),
    subtotalCents: Number(row['subtotal_cents'] ?? 0),
    taxCents: Number(row['tax_cents'] ?? 0),
    totalCents: total,
    paidCents: paid,
    balanceCents: total - paid,
    journalEntryId: row['journal_entry_id'] === null ? null : String(row['journal_entry_id']),
    notes: row['notes'] === null ? null : String(row['notes']),
    postedAt: row['posted_at'] === null ? null : String(row['posted_at']),
    daysOverdue: daysOverdue(String(row['due_date']), status),
    poId: row['po_id'] === null || row['po_id'] === undefined ? null : String(row['po_id']),
    matchState: String(row['match_state'] ?? 'unchecked'),
  };
}

function billLines(billId: string): readonly ComputedLine[] {
  const rows = conn().all<{
    description: string;
    product_id: string | null;
    qty_milli: number;
    unit_price_cents: number;
    tax_id: string | null;
    account_id: string | null;
    net_cents: number;
    tax_cents: number;
    total_cents: number;
    po_price_cents: number | null;
    received_qty_milli: number | null;
    match_status: string;
  }>(
    `SELECT description, product_id, qty_milli, unit_price_cents, tax_id, account_id,
            net_cents, tax_cents, total_cents, po_price_cents, received_qty_milli, match_status
       FROM bill_lines WHERE bill_id = ? ORDER BY line_no`,
    [billId],
  );
  return rows.map((row) => ({
    description: row.description,
    productId: row.product_id,
    qtyMilli: Number(row.qty_milli),
    unitPriceCents: Number(row.unit_price_cents),
    discountBp: 0,
    taxId: row.tax_id,
    accountId: row.account_id,
    netCents: Number(row.net_cents),
    taxCents: Number(row.tax_cents),
    totalCents: Number(row.total_cents),
    poPriceCents: row.po_price_cents === null ? null : Number(row.po_price_cents),
    receivedQtyMilli: row.received_qty_milli === null ? null : Number(row.received_qty_milli),
    matchStatus: row.match_status,
  }));
}

export function getBill(id: string): BillDetail {
  const row = conn().one<Record<string, unknown>>(`${BILL_SELECT} WHERE b.id = ?`, [id]);
  if (!row) throw notFound('Bill');
  const receiptIds = (() => {
    const raw = row['receipt_ids_json'];
    if (typeof raw !== 'string' || raw.length === 0) return [] as string[];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
    } catch {
      return [] as string[];
    }
  })();
  return {
    ...toBillRow(row),
    lines: billLines(id),
    receiptIds,
    exceptionReason: row['exception_reason'] === null ? null : String(row['exception_reason'] ?? ''),
    approvedBy: row['approved_by'] === null ? null : String(row['approved_by'] ?? ''),
  };
}

export function listBills(filter: Omit<InvoiceFilter, 'customerId'> & { readonly vendorId?: string } = {}): {
  readonly rows: readonly BillRow[];
  readonly total: number;
} {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.from) {
    where.push('b.date >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('b.date <= ?');
    params.push(filter.to);
  }
  if (filter.vendorId) {
    where.push('b.vendor_id = ?');
    params.push(filter.vendorId);
  }
  if (filter.q && filter.q.trim().length > 0) {
    where.push('(b.number LIKE ? OR v.name LIKE ? OR b.vendor_ref LIKE ?)');
    const like = `%${filter.q.trim()}%`;
    params.push(like, like, like);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(Math.max(Math.trunc(filter.pageSize ?? 100), 1), 1000);
  const page = Math.max(Math.trunc(filter.page ?? 1), 1);

  const all = conn()
    .all<Record<string, unknown>>(`${BILL_SELECT} ${clause} ORDER BY b.date DESC, b.created_at DESC`, params)
    .map(toBillRow)
    .filter((row) => !filter.status || row.status === filter.status);
  return { rows: all.slice((page - 1) * pageSize, page * pageSize), total: all.length };
}

export function saveBill(input: BillInput, _scope: JournalScope): BillDetail {
  const vendor = conn().one<{ id: string }>('SELECT id FROM vendors WHERE id = ?', [input.vendorId]);
  if (!vendor) throw validation('vendorId', 'Pick a vendor.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
    throw validation('date', 'Pick a valid date and due date.');
  }

  const totals = computeTotals(input.lines);
  const id = input.id ?? randomUUID();
  if (input.id) {
    const existing = conn().one<{ status: string }>('SELECT status FROM bills WHERE id = ?', [id]);
    if (!existing) throw notFound('Bill');
    if (String(existing.status) !== 'draft') throw conflict('Posted bills are read-only. Void it instead.');
    conn().run('DELETE FROM bill_lines WHERE bill_id = ?', [id]);
    conn().run(
      `UPDATE bills SET vendor_id = ?, vendor_ref = ?, date = ?, due_date = ?, currency = ?,
         subtotal_cents = ?, tax_cents = ?, total_cents = ?, notes = ?, updated_at = ?,
         po_id = ?, receipt_ids_json = ?, match_state = 'unchecked', exception_reason = NULL,
         approved_by = NULL, approved_at = NULL WHERE id = ?`,
      [
        input.vendorId,
        input.vendorRef?.trim() || null,
        input.date,
        input.dueDate,
        input.currency,
        totals.subtotalCents,
        totals.taxCents,
        totals.totalCents,
        input.notes?.trim() || null,
        nowIso(),
        input.poId ?? null,
        JSON.stringify(input.receiptIds ?? []),
        id,
      ],
    );
  } else {
    const at = nowIso();
    conn().run(
      `INSERT INTO bills (id, number, vendor_id, vendor_ref, date, due_date, status, currency,
         subtotal_cents, tax_cents, total_cents, paid_cents, po_id, receipt_ids_json, notes,
         created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        id,
        input.vendorId,
        input.vendorRef?.trim() || null,
        input.date,
        input.dueDate,
        input.currency,
        totals.subtotalCents,
        totals.taxCents,
        totals.totalCents,
        input.poId ?? null,
        JSON.stringify(input.receiptIds ?? []),
        input.notes?.trim() || null,
        at,
        at,
      ],
    );
  }

  for (const [index, line] of totals.lines.entries()) {
    const inputLine = input.lines[index];
    conn().run(
      `INSERT INTO bill_lines (id, bill_id, line_no, product_id, description, qty_milli,
         unit_price_cents, tax_id, account_id, net_cents, tax_cents, total_cents,
         po_price_cents, received_qty_milli)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        id,
        index + 1,
        line.productId,
        line.description,
        line.qtyMilli,
        line.unitPriceCents,
        line.taxId,
        line.accountId,
        line.netCents,
        line.taxCents,
        line.totalCents,
        inputLine?.poPriceCents ?? null,
        inputLine?.receivedQtyMilli ?? null,
      ],
    );
  }

  return getBill(id);
}

/**
 * Posts a bill, running the three-way match first when a PO is behind it
 * (§B.4, US-31, BR-13/14).
 *
 * An out-of-tolerance bill is **stored** as `match_exception` with the reasons,
 * then refused. It does not disappear behind an error toast: it stays on the
 * approval list where somebody with `purchasing.bill.approve_exception` can see
 * the figures and pass it with a reason, which writes an audit row.
 *
 * The GRNI branch is exact by construction: the accrual and the input tax are
 * computed from the lines, and the price variance is the plug that makes the
 * debits equal `total_cents` — so a one-cent document rounding cannot make the
 * entry out of balance.
 */
export function postBill(
  billId: string,
  scope: JournalScope,
  options: { readonly approveException?: boolean; readonly reason?: string } = {},
): BillDetail {
  const bill = getBill(billId);
  if (bill.status === 'void') throw conflict('That bill is void and cannot be posted.');
  if (bill.status !== 'draft' && bill.status !== 'match_exception') {
    throw conflict('That bill has already been posted.');
  }
  if (bill.totalCents <= 0) throw conflict('A bill must be worth more than zero before it can be posted.');

  // ── three-way match ────────────────────────────────────────────────────────
  const match = evaluateMatch(bill.id);
  const at = nowIso();
  recordMatchState(bill.id, match, at);

  if (!match.withinTolerance) {
    if (options.approveException !== true) {
      conn().run("UPDATE bills SET status = 'match_exception', updated_at = ? WHERE id = ?", [at, bill.id]);
      throw conflict(
        `This bill does not match its purchase order and needs approval: ${match.reasons.join(' ')}`,
      );
    }
    if ((options.reason ?? '').trim().length === 0) {
      throw validation('reason', 'Approving a match exception needs a reason — it is recorded in the audit log.');
    }
    auditAppend({
      actorId: scope.actorId,
      actorName: scope.actorName,
      entity: 'bills',
      entityId: bill.id,
      action: 'approve_match_exception',
      before: { matchState: 'exception', reasons: match.reasons },
      after: { matchState: 'approved', reason: options.reason ?? '' },
      meta: { permission: 'purchasing.bill.approve_exception' },
    });
    conn().run(
      "UPDATE bills SET approved_by = ?, approved_at = ?, status = 'draft', updated_at = ? WHERE id = ?",
      [scope.actorId, at, at, bill.id],
    );
  }

  const year = fiscalYearFor(bill.date);
  const number = nextNumber('bill', year.id);

  const lines: JournalLineInput[] = [];
  const poId = bill.poId;

  if (poId) {
    // ── §B.4: clear the goods-received accrual, book the difference ──────────
    /*
     * The accrual is taken from `match.lines`, not from `bill.lines`, because the
     * match is the one place that resolves a PO price: it uses the price stored on
     * the bill line when there is one and falls back to `po_lines` when there is
     * not. Reading `bill.lines[].poPriceCents` directly meant that a bill whose
     * lines arrived without that column accrued zero, debited the whole value to
     * price variance and left the accrual standing — the ledger still balanced,
     * which is exactly why it went unnoticed until the end-to-end reconcile.
     */
    let accrued = 0;
    for (const line of match.lines) {
      if (line.poPriceCents === null) {
        throw conflict(
          `"${line.description}" has no price on its purchase order, so the goods-received accrual cannot be cleared. ` +
            'Post it without the purchase order to book it as an expense.',
        );
      }
      accrued += mulQty(cents(line.poPriceCents), line.billedMilli);
    }
    const grni = accountFor('grni', 'Goods received not invoiced');
    if (accrued !== 0) {
      lines.push({
        accountId: grni,
        debitCents: cents(accrued),
        description: `Goods received accrual cleared by ${number}`,
        partnerType: 'vendor',
        partnerId: bill.vendorId,
      });
    }

    let taxTotal = 0;
    const byTax = new Map<string, Cents>();
    for (const line of bill.lines) {
      if (!line.taxId || line.taxCents === 0) continue;
      taxTotal += line.taxCents;
      byTax.set(line.taxId, cents((byTax.get(line.taxId) ?? 0) + line.taxCents));
    }
    for (const [taxId, amount] of byTax) {
      const tax = taxFor(taxId);
      lines.push({
        accountId: tax?.accountId ?? firstPostable(['1300'], 'Input tax'),
        debitCents: amount,
        taxId,
        description: `Input tax on ${number}`,
      });
    }

    // The plug. Whatever is left after the accrual and the tax *is* the price
    // variance, so the entry balances to the cent even after document rounding.
    const variance = bill.totalCents - accrued - taxTotal;
    if (variance !== 0) {
      const accountId = accountFor('priceVariance', 'Purchase price variance');
      lines.push(
        variance > 0
          ? { accountId, debitCents: cents(variance), description: `Price variance on ${number}` }
          : { accountId, creditCents: cents(-variance), description: `Price variance on ${number}` },
      );
    }
  } else {
    // ── §B.4: an expense bill debits the expense or inventory account ────────
    const byAccount = new Map<string, Cents>();
    for (const line of bill.lines) {
      const account = expenseAccountFor(line);
      byAccount.set(account, cents((byAccount.get(account) ?? 0) + line.netCents));
    }
    for (const [accountId, amount] of byAccount) {
      if (amount === 0) continue;
      lines.push({
        accountId,
        debitCents: amount,
        description: `Bill ${number}`,
        partnerType: 'vendor',
        partnerId: bill.vendorId,
      });
    }

    const byTax = new Map<string, Cents>();
    for (const line of bill.lines) {
      if (!line.taxId || line.taxCents === 0) continue;
      byTax.set(line.taxId, cents((byTax.get(line.taxId) ?? 0) + line.taxCents));
    }
    for (const [taxId, amount] of byTax) {
      const tax = taxFor(taxId);
      const accountId = tax?.accountId ?? firstPostable(['1300'], 'Input tax');
      lines.push({ accountId, debitCents: amount, taxId, description: `Input tax on ${number}` });
    }
  }

  lines.push({
    accountCode: '2100',
    creditCents: bill.totalCents,
    description: `Bill ${number}`,
    partnerType: 'vendor',
    partnerId: bill.vendorId,
  });

  const entry = writeJournal(scope, {
    date: bill.date,
    journalCode: 'PUR',
    memo: `Bill ${number} — ${bill.vendorName}`,
    lines,
    sourceType: 'bill',
    sourceId: bill.id,
  });

  conn().run(
    `UPDATE bills SET number = ?, status = 'posted', journal_entry_id = ?, period_id = ?,
       posted_at = ?, posted_by = ?, updated_at = ? WHERE id = ?`,
    [number, entry.id, periodIdFor(bill.date), at, scope.actorId, at, bill.id],
  );
  return getBill(bill.id);
}

export function voidBill(billId: string, reason: string, scope: JournalScope): BillDetail {
  const bill = getBill(billId);
  if (bill.status === 'void') throw conflict('That bill is already void.');
  if (bill.status === 'draft') {
    conn().run('DELETE FROM bill_lines WHERE bill_id = ?', [billId]);
    conn().run('DELETE FROM bills WHERE id = ?', [billId]);
    return { ...bill, status: 'void', lines: [] };
  }
  if (bill.paidCents > 0) throw conflict('Remove the payments allocated to this bill before voiding it.');
  if (!bill.journalEntryId) throw conflict('That bill has no journal entry to reverse.');
  if (reason.trim().length < 3) throw validation('reason', 'Say why the bill is being voided.');

  writeJournalReverse(bill.journalEntryId, `Bill ${bill.number ?? ''} voided: ${reason}`, scope);
  conn().run("UPDATE bills SET status = 'void', updated_at = ? WHERE id = ?", [nowIso(), billId]);
  return getBill(billId);
}

// ── shared helpers for the pages ─────────────────────────────────────────────

/** Recomputes `paid_cents` and the stored status from the allocations (BR-10). */
export function refreshDocumentPaid(docType: 'invoice' | 'bill', docId: string): { paidCents: number; totalCents: number } {
  const table = docType === 'invoice' ? 'invoices' : 'bills';
  const paid = conn().one<{ total: number }>(
    'SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payment_allocations WHERE doc_type = ? AND doc_id = ?',
    [docType, docId],
  );
  const paidCents = Number(paid?.total ?? 0);
  const doc = conn().one<{ total_cents: number; status: string }>(
    `SELECT total_cents, status FROM ${table} WHERE id = ?`,
    [docId],
  );
  if (!doc) throw notFound(docType === 'invoice' ? 'Invoice' : 'Bill');
  if (String(doc.status) !== 'draft' && String(doc.status) !== 'void') {
    const totalCents = Number(doc.total_cents);
    const stored = paidCents >= totalCents && totalCents > 0 ? 'paid' : paidCents > 0 ? 'partially_paid' : 'posted';
    conn().run(`UPDATE ${table} SET paid_cents = ?, status = ?, updated_at = ? WHERE id = ?`, [
      paidCents,
      stored,
      nowIso(),
      docId,
    ]);
  }
  return { paidCents, totalCents: Number(doc.total_cents) };
}

/** Unallocated amount still available on a payment. */
export function openBalance(docType: 'invoice' | 'bill', docId: string): number {
  const table = docType === 'invoice' ? 'invoices' : 'bills';
  const row = conn().one<{ total_cents: number; paid_cents: number; status: string }>(
    `SELECT total_cents, paid_cents, status FROM ${table} WHERE id = ?`,
    [docId],
  );
  if (!row) throw notFound(docType === 'invoice' ? 'Invoice' : 'Bill');
  if (String(row.status) === 'void' || String(row.status) === 'draft') return 0;
  return Math.max(Number(row.total_cents) - Number(row.paid_cents), 0);
}

/** Sum of every open document for a partner — used by the statement template. */
export function partnerBalance(partnerType: 'customer' | 'vendor', partnerId: string): number {
  const table = partnerType === 'customer' ? 'invoices' : 'bills';
  const column = partnerType === 'customer' ? 'customer_id' : 'vendor_id';
  const row = conn().one<{ total: number }>(
    `SELECT COALESCE(SUM(total_cents - paid_cents), 0) AS total FROM ${table}
      WHERE ${column} = ? AND status IN ('posted', 'partially_paid')`,
    [partnerId],
  );
  return Number(row?.total ?? 0);
}

/** The currency every posted amount is expressed in. */
export function ledgerCurrency(): string {
  return baseCurrency();
}
