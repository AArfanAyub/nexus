/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The document service: preview, save-to-PDF, print and export (T06, US-45..47).
 *
 * The only interesting design decision is that the model is built **here**, from
 * the database, and handed to a pure template. The renderer never sends the
 * contents of a document to be printed — it sends a type and an id — so a
 * preview can never disagree with what was posted.
 */

import fs from 'node:fs';
import path from 'node:path';

import { app, shell } from 'electron';

import type { PdfResult, PrintableDocType } from '../../shared/finance';
import { cents } from '../../shared/money';
import { conn } from '../db/connection';
import { conflict, notFound, validation } from '../errors';
import { getBill, getInvoice, listInvoices, partnerBalance } from './finance';
import { getPo } from './purchasing';
import { getDelivery, getQuote } from './sales';
import { getCompany } from './settings';
import { renderPdf } from '../pdf/render';
import { amountInWords, renderDocumentHtml, renderPreviewHtml, type DocumentModel, type DocumentTotalRow } from '../pdf/template';

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = { USD: '$', EUR: '€', GBP: '£' };

/** Formats minor units for print. Presentation only — never arithmetic. */
function money(value: number, currency: string): string {
  const formatter = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${CURRENCY_SYMBOLS[currency] ?? ''}${formatter.format(value / 100)}`;
}

function quantity(qtyMilli: number): string {
  const whole = Math.trunc(qtyMilli / 1000);
  const fraction = Math.abs(qtyMilli % 1000);
  if (fraction === 0) return String(whole);
  return `${String(whole)}.${String(fraction).padStart(3, '0').replace(/0+$/, '')}`;
}

function logoDataUrl(): string | null {
  const row = conn().one<{ logo_path: string | null }>('SELECT logo_path FROM companies LIMIT 1');
  const file = row?.logo_path;
  if (!file || !fs.existsSync(file)) return null;
  try {
    const stat = fs.statSync(file);
    if (stat.size > 400_000) return null;
    const extension = path.extname(file).toLowerCase();
    const mime = extension === '.svg' ? 'image/svg+xml' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

function companyBlock(): DocumentModel['company'] {
  const company = getCompany();
  if (!company) throw conflict('Set up the company before printing anything.');
  const address = company.address
    ? [
        company.address.line1,
        company.address.line2,
        [company.address.city, company.address.region, company.address.postcode].filter(Boolean).join(' '),
        company.address.country,
      ].filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    : [];
  return {
    name: company.name,
    legalName: company.legalName,
    taxId: company.taxId,
    address,
    logoDataUrl: logoDataUrl(),
  };
}

function customerBlock(customerId: string): { readonly name: string; readonly lines: readonly string[] } {
  const row = conn().one<{
    name: string;
    legal_name: string | null;
    tax_id: string | null;
    email: string | null;
    phone: string | null;
    address_json: string | null;
  }>('SELECT name, legal_name, tax_id, email, phone, address_json FROM customers WHERE id = ?', [customerId]);
  if (!row) throw notFound('Customer');
  const lines: string[] = [];
  if (row.legal_name) lines.push(row.legal_name);
  if (row.address_json) {
    try {
      const address = JSON.parse(row.address_json) as Record<string, unknown>;
      for (const key of ['line1', 'line2', 'city', 'region', 'postalCode', 'country']) {
        const value = address[key];
        if (typeof value === 'string' && value.trim().length > 0) lines.push(value);
      }
    } catch {
      // A malformed address must not stop an invoice from printing.
    }
  }
  if (row.tax_id) lines.push(`Tax ID ${row.tax_id}`);
  if (row.email) lines.push(row.email);
  if (row.phone) lines.push(row.phone);
  return { name: row.name, lines };
}

function vendorBlock(vendorId: string): { readonly name: string; readonly lines: readonly string[] } {
  const row = conn().one<{
    name: string;
    legal_name: string | null;
    tax_id: string | null;
    email: string | null;
    address_json: string | null;
  }>('SELECT name, legal_name, tax_id, email, address_json FROM vendors WHERE id = ?', [vendorId]);
  if (!row) throw notFound('Vendor');
  const lines: string[] = [];
  if (row.legal_name) lines.push(row.legal_name);
  if (row.address_json) {
    try {
      const address = JSON.parse(row.address_json) as Record<string, unknown>;
      for (const key of ['line1', 'city', 'country']) {
        const value = address[key];
        if (typeof value === 'string' && value.trim().length > 0) lines.push(value);
      }
    } catch {
      // ignore
    }
  }
  if (row.tax_id) lines.push(`Tax ID ${row.tax_id}`);
  if (row.email) lines.push(row.email);
  return { name: row.name, lines };
}

function taxLabel(taxId: string | null): string {
  if (!taxId) return 'No tax';
  const row = conn().one<{ name: string; rate_bp: number }>('SELECT name, rate_bp FROM taxes WHERE id = ?', [taxId]);
  if (!row) return 'Tax';
  return `${row.name} (${(Number(row.rate_bp) / 100).toFixed(2)}%)`;
}

/** Builds the printable model for an invoice. */
function invoiceModel(invoiceId: string): DocumentModel {
  const invoice = getInvoice(invoiceId);
  const byTax = new Map<string, { net: number; tax: number }>();
  for (const line of invoice.lines) {
    const key = line.taxId ?? '';
    const current = byTax.get(key) ?? { net: 0, tax: 0 };
    byTax.set(key, { net: current.net + line.netCents, tax: current.tax + line.taxCents });
  }

  const totals: { label: string; value: string; emphasis?: boolean }[] = [
    { label: 'Subtotal', value: money(invoice.subtotalCents, invoice.currency) },
  ];
  if (invoice.discountCents > 0) {
    totals.push({ label: 'Discount', value: `-${money(invoice.discountCents, invoice.currency)}` });
  }
  if (invoice.taxCents > 0) {
    totals.push({ label: 'Tax', value: money(invoice.taxCents, invoice.currency) });
  }
  totals.push({ label: 'Total', value: money(invoice.totalCents, invoice.currency), emphasis: true });
  if (invoice.paidCents > 0) {
    totals.push({ label: 'Paid', value: money(invoice.paidCents, invoice.currency) });
    totals.push({ label: 'Balance due', value: money(invoice.balanceCents, invoice.currency) });
  }

  return {
    docType: 'invoice',
    number: invoice.number ?? 'DRAFT',
    date: invoice.date,
    dueDate: invoice.dueDate,
    reference: null,
    status: invoice.status,
    currency: invoice.currency,
    company: companyBlock(),
    partner: customerBlock(invoice.customerId),
    meta: [],
    lines: invoice.lines.map((line) => ({
      description: line.description,
      qty: quantity(line.qtyMilli),
      unitPrice: money(line.unitPriceCents, invoice.currency),
      discount: line.discountBp > 0 ? `${(line.discountBp / 100).toFixed(2)}%` : undefined,
      tax: money(line.taxCents, invoice.currency),
      total: money(line.totalCents, invoice.currency),
    })),
    taxRows: [...byTax.entries()].map(([taxId, amounts]) => ({
      label: taxLabel(taxId || null),
      net: money(amounts.net, invoice.currency),
      tax: money(amounts.tax, invoice.currency),
    })),
    totals,
    amountInWords: amountInWords(invoice.totalCents, invoice.currency),
    terms: invoice.terms,
    notes: invoice.notes,
  };
}

function billModel(billId: string): DocumentModel {
  const bill = getBill(billId);
  const byTax = new Map<string, { net: number; tax: number }>();
  for (const line of bill.lines) {
    const key = line.taxId ?? '';
    const current = byTax.get(key) ?? { net: 0, tax: 0 };
    byTax.set(key, { net: current.net + line.netCents, tax: current.tax + line.taxCents });
  }

  return {
    docType: 'bill',
    number: bill.number ?? 'DRAFT',
    date: bill.date,
    dueDate: bill.dueDate,
    reference: bill.vendorRef,
    status: bill.status,
    currency: bill.currency,
    company: companyBlock(),
    partner: vendorBlock(bill.vendorId),
    meta: [],
    lines: bill.lines.map((line) => ({
      description: line.description,
      qty: quantity(line.qtyMilli),
      unitPrice: money(line.unitPriceCents, bill.currency),
      tax: money(line.taxCents, bill.currency),
      total: money(line.totalCents, bill.currency),
    })),
    taxRows: [...byTax.entries()].map(([taxId, amounts]) => ({
      label: taxLabel(taxId || null),
      net: money(amounts.net, bill.currency),
      tax: money(amounts.tax, bill.currency),
    })),
    totals: [
      { label: 'Subtotal', value: money(bill.subtotalCents, bill.currency) },
      { label: 'Tax', value: money(bill.taxCents, bill.currency) },
      { label: 'Total', value: money(bill.totalCents, bill.currency), emphasis: true },
      { label: 'Paid', value: money(bill.paidCents, bill.currency) },
      { label: 'Balance', value: money(bill.balanceCents, bill.currency) },
    ],
    amountInWords: amountInWords(bill.totalCents, bill.currency),
    notes: bill.notes,
  };
}

/**
 * A quotation.
 *
 * The expiry date rides in the `dueDate` slot because that is where a reader
 * looks for "this stops being true on" — the template labels it "Due", and a
 * quote that has passed its expiry is exactly as urgent as an overdue invoice.
 * The status is printed verbatim so a converted quote cannot be mistaken for a
 * live one.
 */
function quoteModel(quoteId: string): DocumentModel {
  const quote = getQuote(quoteId);
  const byTax = new Map<string, { net: number; tax: number }>();
  for (const line of quote.lines) {
    const key = line.taxId ?? '';
    const current = byTax.get(key) ?? { net: 0, tax: 0 };
    byTax.set(key, { net: current.net + line.netCents, tax: current.tax + line.taxCents });
  }
  const subtotal = quote.lines.reduce((sum, line) => sum + line.netCents, 0);
  const tax = quote.lines.reduce((sum, line) => sum + line.taxCents, 0);

  const totals: DocumentTotalRow[] = [{ label: 'Subtotal', value: money(subtotal, quote.currency) }];
  if (tax > 0) totals.push({ label: 'Tax', value: money(tax, quote.currency) });
  totals.push({ label: 'Total', value: money(quote.totalCents, quote.currency), emphasis: true });

  return {
    docType: 'quote',
    number: quote.number ?? 'DRAFT',
    date: quote.date,
    dueDate: quote.expiryDate,
    reference: null,
    status: quote.isExpired && quote.status !== 'converted' ? 'expired' : quote.status,
    currency: quote.currency,
    company: companyBlock(),
    partner: customerBlock(quote.customerId),
    meta: [{ label: 'Valid until', value: quote.expiryDate }],
    lines: quote.lines.map((line) => ({
      description: line.description,
      qty: quantity(line.qtyMilli),
      unitPrice: money(line.unitPriceCents, quote.currency),
      discount: line.discountBp > 0 ? `${(line.discountBp / 100).toFixed(2)}%` : undefined,
      tax: money(line.taxCents, quote.currency),
      total: money(line.totalCents, quote.currency),
    })),
    taxRows: [...byTax.entries()].map(([taxId, amounts]) => ({
      label: taxLabel(taxId || null),
      net: money(amounts.net, quote.currency),
      tax: money(amounts.tax, quote.currency),
    })),
    totals,
    amountInWords: amountInWords(quote.totalCents, quote.currency),
    terms: quote.terms,
    notes: quote.notes,
  };
}

/**
 * A purchase order.
 *
 * `received` is printed as a separate meta row rather than folded into the
 * quantity column: a supplier reading a reprinted order after a part delivery
 * needs to see what is still outstanding, and the template has no per-line
 * "received" column to put it in.
 */
function purchaseOrderModel(poId: string): DocumentModel {
  const po = getPo(poId);
  const byTax = new Map<string, { net: number; tax: number }>();
  for (const line of po.lines) {
    const key = line.taxId ?? '';
    const current = byTax.get(key) ?? { net: 0, tax: 0 };
    byTax.set(key, { net: current.net + line.netCents, tax: current.tax + line.taxCents });
  }

  const meta: { label: string; value: string }[] = [];
  if (po.expectedDate) meta.push({ label: 'Expected', value: po.expectedDate });
  meta.push({
    label: 'Received',
    value: `${quantity(po.receivedMilli)} of ${quantity(po.orderedMilli)}`,
  });
  meta.push({ label: 'Status', value: po.status.replace(/_/g, ' ') });

  const totals: DocumentTotalRow[] = [{ label: 'Subtotal', value: money(po.subtotalCents, po.currency) }];
  if (po.taxCents > 0) totals.push({ label: 'Tax', value: money(po.taxCents, po.currency) });
  totals.push({ label: 'Total', value: money(po.totalCents, po.currency), emphasis: true });

  return {
    docType: 'purchase_order',
    number: po.number ?? 'DRAFT',
    date: po.date,
    dueDate: po.expectedDate,
    reference: null,
    status: po.status,
    currency: po.currency,
    company: companyBlock(),
    partner: vendorBlock(po.vendorId),
    meta,
    lines: po.lines.map((line) => ({
      description: line.description,
      qty: quantity(line.qtyMilli),
      unitPrice: money(line.unitPriceCents, po.currency),
      tax: money(line.taxCents, po.currency),
      total: money(line.totalCents, po.currency),
    })),
    taxRows: [...byTax.entries()].map(([taxId, amounts]) => ({
      label: taxLabel(taxId || null),
      net: money(amounts.net, po.currency),
      tax: money(amounts.tax, po.currency),
    })),
    totals,
    amountInWords: amountInWords(po.totalCents, po.currency),
    notes: po.notes,
  };
}

/**
 * A delivery note.
 *
 * There is no money on it that the customer owes — the invoice comes later — so
 * the totals block carries the cost of goods shipped for the operator's copy and
 * the unit prices are shown because a driver and a receiving clerk both need to
 * check the right boxes left the building.
 */
function deliveryNoteModel(deliveryId: string): DocumentModel {
  const delivery = getDelivery(deliveryId);
  const currency = getCompany()?.baseCurrency ?? 'USD';
  const total = delivery.lines.reduce((sum, line) => sum + line.valueCents, 0);

  return {
    docType: 'delivery_note',
    number: delivery.number ?? 'DRAFT',
    date: delivery.date,
    reference: delivery.orderNumber,
    status: delivery.status,
    currency,
    company: companyBlock(),
    partner: customerBlock(delivery.customerId),
    meta: [
      { label: 'Against order', value: delivery.orderNumber ?? '—' },
      { label: 'From', value: delivery.warehouseName },
    ],
    lines: delivery.lines.map((line) => ({
      description: `${line.sku} · ${line.productName}`,
      qty: quantity(line.qtyMilli),
      unitPrice: money(line.unitCostCents, currency),
      total: money(line.valueCents, currency),
    })),
    taxRows: [],
    totals: [{ label: 'Goods value', value: money(total, currency), emphasis: true }],
    amountInWords: '',
    notes: delivery.notes,
    footer: 'Goods received in good order and condition.',
  };
}

/** A statement of account: every open invoice for one customer. */
function statementModel(customerId: string, asOf: string): DocumentModel {
  const invoices = listInvoices({ customerId, pageSize: 200 }).rows.filter(
    (row) => row.status !== 'draft' && row.status !== 'void',
  );
  const currency = invoices[0]?.currency ?? getCompany()?.baseCurrency ?? 'USD';
  const outstanding = partnerBalance('customer', customerId);

  return {
    docType: 'statement',
    number: `ST-${asOf.replace(/-/g, '')}`,
    date: asOf,
    currency,
    company: companyBlock(),
    partner: customerBlock(customerId),
    meta: [{ label: 'Outstanding', value: money(outstanding, currency) }],
    lines: invoices.map((row) => ({
      description: row.number ?? '(draft)',
      detail: `${row.date} — due ${row.dueDate}`,
      qty: '1',
      unitPrice: money(row.totalCents, currency),
      total: money(row.balanceCents, currency),
    })),
    taxRows: [],
    totals: [{ label: 'Total outstanding', value: money(outstanding, currency), emphasis: true }],
    amountInWords: amountInWords(outstanding, currency),
    notes: 'Please settle the outstanding balance at your earliest convenience.',
  };
}

/** Resolves the model for any printable type, or explains why it cannot. */
export function documentModel(docType: PrintableDocType, id: string): DocumentModel {
  switch (docType) {
    case 'invoice':
      return invoiceModel(id);
    case 'bill':
      return billModel(id);
    case 'statement':
      return statementModel(id, new Date().toISOString().slice(0, 10));
    case 'quote':
      return quoteModel(id);
    case 'purchase_order':
      return purchaseOrderModel(id);
    case 'delivery_note':
      return deliveryNoteModel(id);
    case 'credit_note':
      // Honest rather than wrong: a credit note has no table yet, and printing a
      // quotation-shaped document under a credit-note title would be worse than
      // refusing.
      throw notFound('A printable credit note');
    default:
      throw validation('docType', 'That document type cannot be printed.');
  }
}

/** The HTML the renderer shows in the split-view preview. */
export function previewDocument(docType: PrintableDocType, id: string): { readonly html: string } {
  return { html: renderPreviewHtml(documentModel(docType, id)) };
}

function defaultFileName(docType: PrintableDocType, number: string): string {
  const safe = number.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${docType}-${safe}.pdf`;
}

/** Renders and writes a PDF to a path the operator chose. */
export async function saveDocumentPdf(
  docType: PrintableDocType,
  id: string,
  targetPath: string,
): Promise<PdfResult> {
  const model = documentModel(docType, id);
  const resolved = targetPath.trim().length > 0
    ? targetPath
    : path.join(app.getPath('documents'), defaultFileName(docType, model.number));
  const directory = path.dirname(resolved);
  if (!fs.existsSync(directory)) {
    throw validation('path', `The folder ${directory} does not exist.`);
  }

  const { pdf, pages } = await renderPdf(renderDocumentHtml(model));
  fs.writeFileSync(resolved, pdf);
  return { path: resolved, pages };
}

/**
 * Prints by writing a temporary PDF and handing it to the OS viewer.
 *
 * Electron's `webContents.print()` on a hidden window is unreliable across
 * platforms (it silently no-ops on some Linux desktops); the system viewer always
 * shows the real print dialog for the real bytes.
 */
export async function printDocument(docType: PrintableDocType, id: string): Promise<PdfResult> {
  const model = documentModel(docType, id);
  const directory = path.join(app.getPath('temp'), 'nexus-print');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, defaultFileName(docType, model.number));
  const { pdf, pages } = await renderPdf(renderDocumentHtml(model));
  fs.writeFileSync(target, pdf);
  const error = await shell.openPath(target);
  if (error) throw conflict(`The PDF was created at ${target} but could not be opened: ${error}`);
  return { path: target, pages };
}

/** Total open amount for a partner — used by the statement and the AR pages. */
export function openBalanceFor(partnerType: 'customer' | 'vendor', partnerId: string): number {
  return cents(partnerBalance(partnerType, partnerId));
}
