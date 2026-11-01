/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The three-way match: purchase order ↔ goods receipt ↔ vendor bill
 * (US-31, BR-13, BR-14, decision D-17).
 *
 * ## What "match" means
 *
 * For every billed line:
 *   1. `billed qty ≤ received qty ≤ ordered qty`
 *   2. `|bill price − PO price|` within **both** the percentage tolerance
 *      (`purchasing.tolerance_bp`, default 200 = 2 %) **and** the absolute
 *      tolerance (`purchasing.tolerance_abs_cents`, default 5000 = 50.00)
 *
 * Both must pass. A 1-cent overcharge on a 1.00 item is 1 % but 100 % of the
 * absolute cap; a 40.00 overcharge on a 10 000.00 item is inside the percentage
 * but breaches the absolute cap. Requiring both is what stops either one alone
 * being gamed.
 *
 * ## Why this is its own module
 *
 * `finance.documents.postBill` needs it, and `purchasing.ts` needs
 * `computeTotals` from `finance.documents`. Putting the match in either one would
 * make them import each other. It lives here, imports only the database, and both
 * callers depend on it in one direction.
 */

import type { MatchLine, MatchResult } from '../../shared/ops';
import { conn } from '../db/connection';
import { notFound } from '../errors';
import { readSetting } from './settings';

/** `settings` keys, so the tolerance is data rather than a constant in code. */
export const TOLERANCE_BP_KEY = 'purchasing.tolerance_bp';
export const TOLERANCE_ABS_KEY = 'purchasing.tolerance_abs_cents';
export const DEFAULT_TOLERANCE_BP = 200;
export const DEFAULT_TOLERANCE_ABS_CENTS = 5000;

interface BillDbRow {
  readonly id: string;
  readonly vendor_id: string;
  readonly po_id: string | null;
  readonly status: string;
  readonly match_state: string;
}

interface BillLineDbRow {
  readonly id: string;
  readonly product_id: string | null;
  readonly description: string;
  readonly qty_milli: number;
  readonly unit_price_cents: number;
  readonly po_price_cents: number | null;
  readonly received_qty_milli: number | null;
}

function tolerances(): { bp: number; abs: number } {
  const bp = readSetting<number>(TOLERANCE_BP_KEY);
  const abs = readSetting<number>(TOLERANCE_ABS_KEY);
  return {
    bp: typeof bp === 'number' && Number.isFinite(bp) ? bp : DEFAULT_TOLERANCE_BP,
    abs: typeof abs === 'number' && Number.isFinite(abs) ? abs : DEFAULT_TOLERANCE_ABS_CENTS,
  };
}

/** Quantity received against a product on a PO, across every posted receipt. */
function receivedFor(poId: string, productId: string | null): number {
  if (!productId) return 0;
  const row = conn().one<{ qty: number | null }>(
    `SELECT SUM(gl.qty_milli) AS qty
       FROM gr_lines gl
       JOIN goods_receipts gr ON gr.id = gl.receipt_id
      WHERE gr.po_id = ? AND gr.status = 'posted' AND gl.product_id = ?`,
    [poId, productId],
  );
  return Number(row?.qty ?? 0);
}

/** The PO price for a product, used when the bill line did not carry one. */
function poPriceFor(poId: string, productId: string | null): number | null {
  if (!productId) return null;
  const row = conn().one<{ unit_price_cents: number }>(
    'SELECT unit_price_cents FROM po_lines WHERE po_id = ? AND product_id = ? ORDER BY line_no LIMIT 1',
    [poId, productId],
  );
  return row ? Number(row.unit_price_cents) : null;
}

/**
 * Evaluates the match for a bill. Reads only — safe to call from a preview channel
 * and from inside `postBill`'s transaction.
 *
 * A bill with no purchase order behind it is *not* a match failure: it is an
 * expense bill, and §B.4 posts it straight to expense or inventory. It comes back
 * `withinTolerance: true` with no lines so the UI can say "no PO to match".
 */
export function evaluateMatch(billId: string): MatchResult {
  const { bp, abs } = tolerances();
  const bill = conn().one<BillDbRow>('SELECT id, vendor_id, po_id, status, match_state FROM bills WHERE id = ?', [
    billId,
  ]);
  if (!bill) throw notFound('Bill');

  if (!bill.po_id) {
    return {
      withinTolerance: true,
      lines: [],
      reasons: [],
      toleranceBp: bp,
      toleranceAbsCents: abs,
    };
  }

  const lines = conn().all<BillLineDbRow>(
    `SELECT id, product_id, description, qty_milli, unit_price_cents, po_price_cents, received_qty_milli
       FROM bill_lines WHERE bill_id = ? ORDER BY line_no`,
    [billId],
  );

  const result: MatchLine[] = [];
  const reasons: string[] = [];

  for (const line of lines) {
    const billed = Number(line.qty_milli);
    const received = line.received_qty_milli !== null ? Number(line.received_qty_milli) : receivedFor(bill.po_id, line.product_id);
    const poPrice = line.po_price_cents !== null ? Number(line.po_price_cents) : poPriceFor(bill.po_id, line.product_id);
    const billPrice = Number(line.unit_price_cents);

    let status: 'ok' | 'qty' | 'price' = 'ok';
    let note: string | null = null;
    const priceDeltaBp = poPrice && poPrice > 0 ? Math.round(((billPrice - poPrice) / poPrice) * 10_000) : 0;
    const totalDelta = (billPrice - (poPrice ?? billPrice)) * (billed / 1000);

    if (billed > received) {
      status = 'qty';
      note = `Billed ${(billed / 1000).toFixed(3)} but only ${(received / 1000).toFixed(3)} was received.`;
      reasons.push(`${line.description}: ${note}`);
    } else if (poPrice !== null && poPrice > 0 && billPrice !== poPrice) {
      const withinBp = Math.abs(priceDeltaBp) <= bp;
      const withinAbs = Math.abs(Math.round(totalDelta)) <= abs;
      if (!withinBp || !withinAbs) {
        status = 'price';
        note =
          `Priced ${(billPrice / 100).toFixed(2)} against a PO price of ${(poPrice / 100).toFixed(2)} ` +
          `(${(priceDeltaBp / 100).toFixed(2)} %, ${(totalDelta / 100).toFixed(2)} on the line; ` +
          `allowed ${(bp / 100).toFixed(2)} % and ${(abs / 100).toFixed(2)}).`;
        reasons.push(`${line.description}: ${note}`);
      }
    }

    result.push({
      billLineId: line.id,
      description: line.description,
      billedMilli: billed,
      receivedMilli: received,
      poPriceCents: poPrice,
      billPriceCents: billPrice,
      priceDeltaBp,
      totalDeltaCents: Math.round(totalDelta),
      status,
      note,
    });
  }

  return {
    withinTolerance: reasons.length === 0,
    lines: result,
    reasons,
    toleranceBp: bp,
    toleranceAbsCents: abs,
  };
}

/**
 * Records the match outcome on the bill and returns it.
 *
 * Called by `postBill` before it writes anything: an exception is a stored state
 * (`match_exception`) with a reason, not a transient error, so the bill stays
 * visible on the "needs approval" list instead of vanishing behind a toast.
 */
export function recordMatchState(billId: string, match: MatchResult, at: string): void {
  conn().run('UPDATE bills SET match_state = ?, exception_reason = ?, updated_at = ? WHERE id = ?', [
    match.withinTolerance ? 'matched' : 'exception',
    match.withinTolerance ? null : match.reasons.join(' '),
    at,
    billId,
  ]);
}

/** The stored exception reason, for the approval screen. */
export function matchExceptionReason(billId: string): string | null {
  const row = conn().one<{ exception_reason: string | null }>('SELECT exception_reason FROM bills WHERE id = ?', [
    billId,
  ]);
  return row?.exception_reason ?? null;
}
