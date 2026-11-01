/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Receipts and payments, and the allocation that turns one into a settlement
 * (T06, US-20, BR-19).
 *
 * Two invariants are enforced here and nowhere else:
 *   - a payment can never be allocated beyond its own amount
 *   - an allocation can never exceed the open balance of its document
 *
 * Both refuse with `CONFLICT` and name the number that is actually available, so
 * the operator can correct the amount instead of guessing. `paid_cents` and the
 * stored status are recomputed from `payment_allocations` after every change
 * (BR-10: derived, never trusted).
 */

import { randomUUID } from 'node:crypto';

import type {
  AllocationInput,
  PaymentAllocation,
  PaymentDetail,
  PaymentInput,
  PaymentRow,
} from '../../shared/finance';
import { nowIso } from '../../shared/dates';
import { cents, formatAmount } from '../../shared/money';
import { conn } from '../db/connection';
import { conflict, notFound, validation } from '../errors';
import { firstPostable } from './accounts';
import { baseCurrency, reverseEntry, writeJournal, type JournalScope } from './finance.engine';
import { refreshDocumentPaid } from './finance.documents';
import { fiscalYearFor, nextNumber } from './settings';

/** Bank/cash account for a payment method. Cash goes to 1010, everything else to 1020. */
function defaultBankAccount(method: string): string {
  const codes = method === 'cash' ? ['1010', '1020'] : ['1020', '1010'];
  for (const code of codes) {
    const row = conn().one<{ id: string }>(
      'SELECT id FROM accounts WHERE code = ? AND is_postable = 1 AND is_archived = 0 AND deleted_at IS NULL',
      [code],
    );
    if (row) return row.id;
  }
  throw conflict('There is no cash or bank account in the chart of accounts to settle against.');
}

/**
 * Account resolution moved to `./accounts` so inventory, purchasing and sales
 * cannot drift from the chart the finance documents use.
 */

function toPaymentRow(row: Record<string, unknown>): PaymentRow {
  return {
    id: String(row['id']),
    number: row['number'] === null ? null : String(row['number']),
    direction: String(row['direction']) as 'in' | 'out',
    partnerType: String(row['partner_type']) as 'customer' | 'vendor',
    partnerId: String(row['partner_id']),
    partnerName: String(row['partner_name'] ?? ''),
    date: String(row['date']),
    method: String(row['method']),
    reference: row['reference'] === null ? null : String(row['reference']),
    amountCents: Number(row['amount_cents']),
    unallocatedCents: Number(row['unallocated_cents']),
    currency: String(row['currency']),
    bankAccountId: row['bank_account_id'] === null ? null : String(row['bank_account_id']),
    journalEntryId: row['journal_entry_id'] === null ? null : String(row['journal_entry_id']),
    notes: row['notes'] === null ? null : String(row['notes']),
  };
}

const PAYMENT_SELECT = `
  SELECT p.*,
         COALESCE(c.name, v.name, '') AS partner_name
    FROM payments p
    LEFT JOIN customers c ON p.partner_type = 'customer' AND c.id = p.partner_id
    LEFT JOIN vendors v ON p.partner_type = 'vendor' AND v.id = p.partner_id`;

function allocationsFor(paymentId: string): readonly PaymentAllocation[] {
  const rows = conn().all<{
    id: string;
    doc_type: 'invoice' | 'bill';
    doc_id: string;
    amount_cents: number;
    number: string | null;
  }>(
    `SELECT pa.id, pa.doc_type, pa.doc_id, pa.amount_cents,
            CASE pa.doc_type WHEN 'invoice' THEN (SELECT number FROM invoices WHERE id = pa.doc_id)
                             ELSE (SELECT number FROM bills WHERE id = pa.doc_id) END AS number
       FROM payment_allocations pa WHERE pa.payment_id = ? ORDER BY pa.created_at`,
    [paymentId],
  );
  return rows.map((row) => ({
    id: row.id,
    docType: row.doc_type,
    docId: row.doc_id,
    docNumber: row.number,
    amountCents: Number(row.amount_cents),
  }));
}

export function getPayment(id: string): PaymentDetail {
  const row = conn().one<Record<string, unknown>>(`${PAYMENT_SELECT} WHERE p.id = ?`, [id]);
  if (!row) throw notFound('Payment');
  return { ...toPaymentRow(row), allocations: allocationsFor(id), fxDifferenceCents: 0 };
}

export interface PaymentFilter {
  readonly from?: string;
  readonly to?: string;
  readonly partnerType?: 'customer' | 'vendor';
  readonly partnerId?: string;
  readonly direction?: 'in' | 'out';
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export function listPayments(filter: PaymentFilter = {}): { readonly rows: readonly PaymentRow[]; readonly total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.from) {
    where.push('p.date >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('p.date <= ?');
    params.push(filter.to);
  }
  if (filter.partnerType) {
    where.push('p.partner_type = ?');
    params.push(filter.partnerType);
  }
  if (filter.partnerId) {
    where.push('p.partner_id = ?');
    params.push(filter.partnerId);
  }
  if (filter.direction) {
    where.push('p.direction = ?');
    params.push(filter.direction);
  }
  if (filter.q && filter.q.trim().length > 0) {
    where.push('(p.number LIKE ? OR p.reference LIKE ?)');
    const like = `%${filter.q.trim()}%`;
    params.push(like, like);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(Math.max(Math.trunc(filter.pageSize ?? 100), 1), 1000);
  const page = Math.max(Math.trunc(filter.page ?? 1), 1);

  const rows = conn().all<Record<string, unknown>>(
    `${PAYMENT_SELECT} ${clause} ORDER BY p.date DESC, p.created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  const count = conn().one<{ total: number }>(`SELECT COUNT(*) AS total FROM payments p ${clause}`, params);
  return { rows: rows.map(toPaymentRow), total: Number(count?.total ?? 0) };
}

/**
 * Records a receipt or a payment and books it: `Dr bank / Cr AR` inbound,
 * `Dr AP / Cr bank` outbound (§B.4). Allocation is a separate step so a receipt
 * can sit unallocated until the operator decides which invoices it settles.
 */
export function recordPayment(input: PaymentInput, scope: JournalScope): PaymentDetail {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw validation('amountCents', 'Enter an amount greater than zero.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw validation('date', 'Pick a valid date.');

  const partnerTable = input.partnerType === 'customer' ? 'customers' : 'vendors';
  const partner = conn().one<{ id: string }>(`SELECT id FROM ${partnerTable} WHERE id = ?`, [input.partnerId]);
  if (!partner) throw validation('partnerId', `Pick a ${input.partnerType}.`);

  const bankAccountId = input.bankAccountId ?? defaultBankAccount(input.method);
  const control = input.partnerType === 'customer'
    ? firstPostable(['1100'], 'Accounts receivable')
    : firstPostable(['2100'], 'Accounts payable');

  const year = fiscalYearFor(input.date);
  const number = nextNumber('payment', year.id);
  const id = randomUUID();
  const at = nowIso();

  const lines = input.direction === 'in'
    ? [
        { accountId: bankAccountId, debitCents: input.amountCents, description: `Receipt ${number}` },
        {
          accountId: control,
          creditCents: input.amountCents,
          description: `Receipt ${number}`,
          partnerType: input.partnerType,
          partnerId: input.partnerId,
        },
      ]
    : [
        {
          accountId: control,
          debitCents: input.amountCents,
          description: `Payment ${number}`,
          partnerType: input.partnerType,
          partnerId: input.partnerId,
        },
        { accountId: bankAccountId, creditCents: input.amountCents, description: `Payment ${number}` },
      ];

  const entry = writeJournal(scope, {
    date: input.date,
    journalCode: input.method === 'cash' ? 'CSH' : 'BNK',
    memo: `${input.direction === 'in' ? 'Receipt' : 'Payment'} ${number} — ${input.reference ?? input.partnerType}`,
    lines,
    sourceType: 'payment',
    sourceId: id,
  });

  conn().run(
    `INSERT INTO payments (id, number, direction, partner_type, partner_id, date, method, reference,
       amount_cents, unallocated_cents, currency, bank_account_id, journal_entry_id, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      number,
      input.direction,
      input.partnerType,
      input.partnerId,
      input.date,
      input.method,
      input.reference?.trim() || null,
      input.amountCents,
      input.amountCents,
      input.currency || baseCurrency(),
      bankAccountId,
      entry.id,
      input.notes?.trim() || null,
      at,
      at,
    ],
  );

  return getPayment(id);
}

/**
 * Applies a payment to one or more documents.
 *
 * Refuses (a) allocating more than the payment still has, and (b) allocating
 * more than a document still owes — both naming the available figure (BR-19).
 */
export function allocate(paymentId: string, allocations: readonly AllocationInput[]): PaymentDetail {
  if (allocations.length === 0) throw validation('allocations', 'Choose at least one document to settle.');
  const payment = getPayment(paymentId);

  const requested = allocations.reduce((total, allocation) => total + allocation.amountCents, 0);
  if (!Number.isInteger(requested) || requested <= 0) {
    throw validation('amountCents', 'Each allocation must be a positive whole amount.');
  }
  if (requested > payment.unallocatedCents) {
    throw conflict(
      `That is ${formatAmount(cents(requested - payment.unallocatedCents))} more than this payment has left. ` +
        `Available: ${formatAmount(cents(payment.unallocatedCents))}.`,
    );
  }

  const at = nowIso();
  let remaining = payment.unallocatedCents;

  for (const allocation of allocations) {
    if (!Number.isInteger(allocation.amountCents) || allocation.amountCents <= 0) {
      throw validation('amountCents', 'Each allocation must be a positive whole amount.');
    }
    const docType: 'invoice' | 'bill' = allocation.invoiceId ? 'invoice' : 'bill';
    const docId = allocation.invoiceId ?? allocation.billId ?? '';
    if (!docId) throw validation('allocations', 'Each allocation needs an invoice or a bill.');

    if (docType === 'invoice' && payment.partnerType !== 'customer') {
      throw validation('allocations', 'A vendor payment cannot settle a sales invoice.');
    }
    if (docType === 'bill' && payment.partnerType !== 'vendor') {
      throw validation('allocations', 'A customer receipt cannot settle a vendor bill.');
    }

    const table = docType === 'invoice' ? 'invoices' : 'bills';
    const doc = conn().one<{ total_cents: number; paid_cents: number; status: string; number: string | null }>(
      `SELECT total_cents, paid_cents, status, number FROM ${table} WHERE id = ?`,
      [docId],
    );
    if (!doc) throw notFound(docType === 'invoice' ? 'Invoice' : 'Bill');
    if (String(doc.status) === 'void' || String(doc.status) === 'draft') {
      throw conflict('Only posted documents can be settled.');
    }

    const open = Math.max(Number(doc.total_cents) - Number(doc.paid_cents), 0);
    if (allocation.amountCents > open) {
      throw conflict(
        `${docType === 'invoice' ? 'Invoice' : 'Bill'} ${doc.number ?? docId} only has ${formatAmount(cents(open))} outstanding. ` +
          `You tried to allocate ${formatAmount(cents(allocation.amountCents))}.`,
      );
    }

    conn().run(
      `INSERT INTO payment_allocations (id, payment_id, doc_type, doc_id, amount_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), paymentId, docType, docId, allocation.amountCents, at],
    );
    remaining -= allocation.amountCents;
    refreshDocumentPaid(docType, docId);
  }

  conn().run('UPDATE payments SET unallocated_cents = ?, updated_at = ? WHERE id = ?', [remaining, at, paymentId]);
  return getPayment(paymentId);
}

/** Reverses a payment by reversing its journal; the allocations are released. */
export function voidPayment(paymentId: string, reason: string, scope: JournalScope): PaymentDetail {
  const payment = getPayment(paymentId);
  if (payment.allocations.length > 0) {
    throw conflict('Remove the allocations before voiding this payment.');
  }
  if (!payment.journalEntryId) throw conflict('That payment has no journal entry to reverse.');
  if (reason.trim().length < 3) throw validation('reason', 'Say why the payment is being voided.');
  reverseEntry(payment.journalEntryId, `Payment ${payment.number ?? ''} voided: ${reason}`, scope);
  conn().run('DELETE FROM payments WHERE id = ?', [paymentId]);
  return { ...payment, number: payment.number, unallocatedCents: 0 };
}
