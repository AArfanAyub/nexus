"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TOLERANCE_ABS_CENTS = exports.DEFAULT_TOLERANCE_BP = exports.TOLERANCE_ABS_KEY = exports.TOLERANCE_BP_KEY = void 0;
exports.evaluateMatch = evaluateMatch;
exports.recordMatchState = recordMatchState;
exports.matchExceptionReason = matchExceptionReason;
const connection_1 = require("../db/connection");
const errors_1 = require("../errors");
const settings_1 = require("./settings");
/** `settings` keys, so the tolerance is data rather than a constant in code. */
exports.TOLERANCE_BP_KEY = 'purchasing.tolerance_bp';
exports.TOLERANCE_ABS_KEY = 'purchasing.tolerance_abs_cents';
exports.DEFAULT_TOLERANCE_BP = 200;
exports.DEFAULT_TOLERANCE_ABS_CENTS = 5000;
function tolerances() {
    const bp = (0, settings_1.readSetting)(exports.TOLERANCE_BP_KEY);
    const abs = (0, settings_1.readSetting)(exports.TOLERANCE_ABS_KEY);
    return {
        bp: typeof bp === 'number' && Number.isFinite(bp) ? bp : exports.DEFAULT_TOLERANCE_BP,
        abs: typeof abs === 'number' && Number.isFinite(abs) ? abs : exports.DEFAULT_TOLERANCE_ABS_CENTS,
    };
}
/** Quantity received against a product on a PO, across every posted receipt. */
function receivedFor(poId, productId) {
    if (!productId)
        return 0;
    const row = (0, connection_1.conn)().one(`SELECT SUM(gl.qty_milli) AS qty
       FROM gr_lines gl
       JOIN goods_receipts gr ON gr.id = gl.receipt_id
      WHERE gr.po_id = ? AND gr.status = 'posted' AND gl.product_id = ?`, [poId, productId]);
    return Number(row?.qty ?? 0);
}
/** The PO price for a product, used when the bill line did not carry one. */
function poPriceFor(poId, productId) {
    if (!productId)
        return null;
    const row = (0, connection_1.conn)().one('SELECT unit_price_cents FROM po_lines WHERE po_id = ? AND product_id = ? ORDER BY line_no LIMIT 1', [poId, productId]);
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
function evaluateMatch(billId) {
    const { bp, abs } = tolerances();
    const bill = (0, connection_1.conn)().one('SELECT id, vendor_id, po_id, status, match_state FROM bills WHERE id = ?', [
        billId,
    ]);
    if (!bill)
        throw (0, errors_1.notFound)('Bill');
    if (!bill.po_id) {
        return {
            withinTolerance: true,
            lines: [],
            reasons: [],
            toleranceBp: bp,
            toleranceAbsCents: abs,
        };
    }
    const lines = (0, connection_1.conn)().all(`SELECT id, product_id, description, qty_milli, unit_price_cents, po_price_cents, received_qty_milli
       FROM bill_lines WHERE bill_id = ? ORDER BY line_no`, [billId]);
    const result = [];
    const reasons = [];
    for (const line of lines) {
        const billed = Number(line.qty_milli);
        const received = line.received_qty_milli !== null ? Number(line.received_qty_milli) : receivedFor(bill.po_id, line.product_id);
        const poPrice = line.po_price_cents !== null ? Number(line.po_price_cents) : poPriceFor(bill.po_id, line.product_id);
        const billPrice = Number(line.unit_price_cents);
        let status = 'ok';
        let note = null;
        const priceDeltaBp = poPrice && poPrice > 0 ? Math.round(((billPrice - poPrice) / poPrice) * 10_000) : 0;
        const totalDelta = (billPrice - (poPrice ?? billPrice)) * (billed / 1000);
        if (billed > received) {
            status = 'qty';
            note = `Billed ${(billed / 1000).toFixed(3)} but only ${(received / 1000).toFixed(3)} was received.`;
            reasons.push(`${line.description}: ${note}`);
        }
        else if (poPrice !== null && poPrice > 0 && billPrice !== poPrice) {
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
function recordMatchState(billId, match, at) {
    (0, connection_1.conn)().run('UPDATE bills SET match_state = ?, exception_reason = ?, updated_at = ? WHERE id = ?', [
        match.withinTolerance ? 'matched' : 'exception',
        match.withinTolerance ? null : match.reasons.join(' '),
        at,
        billId,
    ]);
}
/** The stored exception reason, for the approval screen. */
function matchExceptionReason(billId) {
    const row = (0, connection_1.conn)().one('SELECT exception_reason FROM bills WHERE id = ?', [
        billId,
    ]);
    return row?.exception_reason ?? null;
}
//# sourceMappingURL=match.js.map