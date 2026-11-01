"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPos = listPos;
exports.getPo = getPo;
exports.savePo = savePo;
exports.confirmPo = confirmPo;
exports.cancelPo = cancelPo;
exports.listReceipts = listReceipts;
exports.getReceipt = getReceipt;
exports.saveReceipt = saveReceipt;
exports.postReceipt = postReceipt;
exports.cancelReceipt = cancelReceipt;
exports.billFromReceipt = billFromReceipt;
exports.billMatch = billMatch;
exports.vendorStatement = vendorStatement;
exports.purchaseAnalysis = purchaseAnalysis;
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
const node_crypto_1 = require("node:crypto");
const dates_1 = require("../../shared/dates");
const money_1 = require("../../shared/money");
const connection_1 = require("../db/connection");
const errors_1 = require("../errors");
const accounts_1 = require("./accounts");
const cache_1 = require("./cache");
const finance_documents_1 = require("./finance.documents");
const finance_engine_1 = require("./finance.engine");
const inventory_1 = require("./inventory");
const match_1 = require("./match");
const settings_1 = require("./settings");
const DEFAULT_PAGE_SIZE = 50;
function pageOf(filter) {
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
function toPoRow(row) {
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
function listPos(filter = {}) {
    const where = [];
    const params = [];
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
    const total = (0, connection_1.conn)().one(`SELECT COUNT(*) AS total FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id ${clause}`, params);
    const rows = (0, connection_1.conn)().all(`${PO_SELECT} ${clause} ORDER BY po.date DESC, po.created_at DESC LIMIT ? OFFSET ?`, [
        ...params,
        size,
        offset,
    ]);
    return { rows: rows.map(toPoRow), total: Number(total?.total ?? 0) };
}
function getPo(id) {
    const row = (0, connection_1.conn)().one(`${PO_SELECT} WHERE po.id = ?`, [id]);
    if (!row)
        throw (0, errors_1.notFound)('Purchase order');
    const lines = (0, connection_1.conn)().all(`SELECT pl.id, pl.line_no, pl.product_id, p.sku, pl.description, pl.qty_milli, pl.received_milli,
            pl.unit_price_cents, pl.tax_id, pl.net_cents, pl.tax_cents
       FROM po_lines pl LEFT JOIN products p ON p.id = pl.product_id
      WHERE pl.po_id = ? ORDER BY pl.line_no`, [id]);
    const receiptIds = (0, connection_1.conn)()
        .all("SELECT id FROM goods_receipts WHERE po_id = ? AND status = 'posted' ORDER BY date", [id])
        .map((entry) => entry.id);
    const billIds = (0, connection_1.conn)()
        .all('SELECT id FROM bills WHERE po_id = ? ORDER BY date', [id])
        .map((entry) => entry.id);
    return {
        ...toPoRow(row),
        notes: row.notes,
        warehouseId: row.warehouse_id,
        lines: lines.map((line) => ({
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
function savePo(input) {
    const vendor = (0, connection_1.conn)().one('SELECT id, currency FROM vendors WHERE id = ?', [
        input.vendorId,
    ]);
    if (!vendor)
        throw (0, errors_1.validation)('vendorId', 'Pick a vendor.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date))
        throw (0, errors_1.validation)('date', 'Pick a valid order date.');
    if (input.lines.length === 0)
        throw (0, errors_1.validation)('lines', 'Add at least one line.');
    const totals = (0, finance_documents_1.computeTotals)(input.lines.map((line) => ({
        productId: line.productId ?? null,
        description: line.description,
        qtyMilli: line.qtyMilli,
        unitPriceCents: line.unitPriceCents,
        taxId: line.taxId ?? null,
    })));
    const id = input.id ?? (0, node_crypto_1.randomUUID)();
    const at = (0, dates_1.nowIso)();
    if (input.id) {
        const existing = (0, connection_1.conn)().one('SELECT status FROM purchase_orders WHERE id = ?', [id]);
        if (!existing)
            throw (0, errors_1.notFound)('Purchase order');
        if (String(existing.status) !== 'draft') {
            throw (0, errors_1.conflict)('A confirmed purchase order is read-only. Cancel it and raise a new one.');
        }
        (0, connection_1.conn)().run('DELETE FROM po_lines WHERE po_id = ?', [id]);
        (0, connection_1.conn)().run(`UPDATE purchase_orders SET vendor_id = ?, date = ?, expected_date = ?, warehouse_id = ?,
         subtotal_cents = ?, tax_cents = ?, total_cents = ?, notes = ?, updated_at = ? WHERE id = ?`, [
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
        ]);
    }
    else {
        (0, connection_1.conn)().run(`INSERT INTO purchase_orders (id, number, vendor_id, date, expected_date, status, currency,
         subtotal_cents, tax_cents, total_cents, warehouse_id, notes, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`, [
            id,
            input.vendorId,
            input.date,
            input.expectedDate ?? null,
            vendor.currency ?? (0, finance_engine_1.baseCurrency)(),
            totals.subtotalCents,
            totals.taxCents,
            totals.totalCents,
            input.warehouseId ?? null,
            input.notes?.trim() || null,
            at,
            at,
        ]);
    }
    for (const [index, line] of totals.lines.entries()) {
        (0, connection_1.conn)().run(`INSERT INTO po_lines (id, po_id, line_no, product_id, description, qty_milli, received_milli,
         unit_price_cents, tax_id, net_cents, tax_cents)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`, [
            (0, node_crypto_1.randomUUID)(),
            id,
            index + 1,
            line.productId,
            line.description,
            line.qtyMilli,
            line.unitPriceCents,
            line.taxId,
            line.netCents,
            line.taxCents,
        ]);
    }
    return getPo(id);
}
/** Confirms a draft order and allocates its number (BR-08: numbers at confirm). */
function confirmPo(id) {
    const po = getPo(id);
    if (po.status !== 'draft')
        throw (0, errors_1.conflict)(`That order is already ${po.status.replace('_', ' ')}.`);
    const year = (0, settings_1.fiscalYearFor)(po.date);
    const number = (0, settings_1.nextNumber)('purchase_order', year.id);
    (0, connection_1.conn)().run("UPDATE purchase_orders SET number = ?, status = 'confirmed', updated_at = ? WHERE id = ?", [
        number,
        (0, dates_1.nowIso)(),
        id,
    ]);
    return getPo(id);
}
function cancelPo(id, reason) {
    const po = getPo(id);
    if (po.status === 'cancelled')
        throw (0, errors_1.conflict)('That order is already cancelled.');
    if (po.status === 'received')
        throw (0, errors_1.conflict)('A fully received order cannot be cancelled.');
    if ((reason ?? '').trim().length === 0)
        throw (0, errors_1.validation)('reason', 'Say why the order is being cancelled.');
    if (po.receivedMilli > 0) {
        throw (0, errors_1.conflict)(`${(po.receivedMilli / 1000).toFixed(3)} has already been received against this order. ` +
            'Cancel the receipts first, or close the order instead.');
    }
    (0, connection_1.conn)().run("UPDATE purchase_orders SET status = 'cancelled', updated_at = ? WHERE id = ?", [(0, dates_1.nowIso)(), id]);
    return getPo(id);
}
/** Recomputes the PO status from its lines. Called after every receipt change. */
function refreshPoStatus(poId) {
    const row = (0, connection_1.conn)().one(`SELECT (SELECT COALESCE(SUM(qty_milli),0) FROM po_lines WHERE po_id = ?) AS ordered,
            (SELECT COALESCE(SUM(received_milli),0) FROM po_lines WHERE po_id = ?) AS received,
            status FROM purchase_orders WHERE id = ?`, [poId, poId, poId]);
    if (!row)
        return;
    if (row.status === 'cancelled')
        return;
    const ordered = Number(row.ordered ?? 0);
    const received = Number(row.received ?? 0);
    const next = received === 0 ? 'confirmed' : received >= ordered ? 'received' : 'partially_received';
    (0, connection_1.conn)().run('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?', [next, (0, dates_1.nowIso)(), poId]);
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
function toReceiptRow(row) {
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
function listReceipts(filter = {}) {
    const where = [];
    const params = [];
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
    const total = (0, connection_1.conn)().one(`SELECT COUNT(*) AS total FROM goods_receipts gr ${clause}`, params);
    const rows = (0, connection_1.conn)().all(`${RECEIPT_SELECT} ${clause} ORDER BY gr.date DESC, gr.created_at DESC LIMIT ? OFFSET ?`, [...params, size, offset]);
    return { rows: rows.map(toReceiptRow), total: Number(total?.total ?? 0) };
}
function getReceipt(id) {
    const row = (0, connection_1.conn)().one(`${RECEIPT_SELECT} WHERE gr.id = ?`, [id]);
    if (!row)
        throw (0, errors_1.notFound)('Goods receipt');
    const lines = (0, connection_1.conn)().all(`SELECT gl.id, gl.line_no, gl.po_line_id, gl.product_id, p.sku, p.name AS product_name,
            gl.qty_milli, gl.unit_cost_cents, gl.po_price_cents
       FROM gr_lines gl JOIN products p ON p.id = gl.product_id
      WHERE gl.receipt_id = ? ORDER BY gl.line_no`, [id]);
    return {
        ...toReceiptRow(row),
        notes: row.notes,
        journalEntryId: row.journal_entry_id,
        lines: lines.map((line) => ({
            id: line.id,
            lineNo: Number(line.line_no),
            poLineId: line.po_line_id,
            productId: line.product_id,
            sku: line.sku,
            productName: line.product_name,
            qtyMilli: Number(line.qty_milli),
            unitCostCents: Number(line.unit_cost_cents),
            valueCents: (0, money_1.mulQty)((0, money_1.cents)(Number(line.unit_cost_cents)), Number(line.qty_milli)),
            poPriceCents: line.po_price_cents === null ? null : Number(line.po_price_cents),
        })),
    };
}
/** The location a receipt lands in: the one named, else the warehouse's default. */
function defaultLocationOf(warehouseId) {
    const row = (0, connection_1.conn)().one('SELECT id FROM locations WHERE warehouse_id = ? AND is_active = 1 ORDER BY code LIMIT 1', [warehouseId]);
    if (!row)
        throw (0, errors_1.validation)('warehouseId', 'That warehouse has no active location to receive into.');
    return row.id;
}
function saveReceipt(input) {
    const vendor = (0, connection_1.conn)().one('SELECT id FROM vendors WHERE id = ?', [input.vendorId]);
    if (!vendor)
        throw (0, errors_1.validation)('vendorId', 'Pick a vendor.');
    const warehouse = (0, connection_1.conn)().one('SELECT id FROM warehouses WHERE id = ?', [input.warehouseId]);
    if (!warehouse)
        throw (0, errors_1.validation)('warehouseId', 'Pick a warehouse.');
    if (input.lines.length === 0)
        throw (0, errors_1.validation)('lines', 'Receive at least one line.');
    const id = input.id ?? (0, node_crypto_1.randomUUID)();
    const at = (0, dates_1.nowIso)();
    const locationId = input.locationId ?? defaultLocationOf(input.warehouseId);
    if (input.id) {
        const existing = (0, connection_1.conn)().one('SELECT status FROM goods_receipts WHERE id = ?', [id]);
        if (!existing)
            throw (0, errors_1.notFound)('Goods receipt');
        if (String(existing.status) !== 'draft')
            throw (0, errors_1.conflict)('Posted receipts are read-only.');
        (0, connection_1.conn)().run('DELETE FROM gr_lines WHERE receipt_id = ?', [id]);
        (0, connection_1.conn)().run(`UPDATE goods_receipts SET po_id = ?, vendor_id = ?, date = ?, warehouse_id = ?, location_id = ?,
         notes = ?, updated_at = ? WHERE id = ?`, [input.poId ?? null, input.vendorId, input.date, input.warehouseId, locationId, input.notes?.trim() || null, at, id]);
    }
    else {
        (0, connection_1.conn)().run(`INSERT INTO goods_receipts (id, number, po_id, vendor_id, date, status, warehouse_id, location_id,
         notes, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`, [
            id,
            input.poId ?? null,
            input.vendorId,
            input.date,
            input.warehouseId,
            locationId,
            input.notes?.trim() || null,
            at,
            at,
        ]);
    }
    for (const [index, line] of input.lines.entries()) {
        if (!Number.isInteger(line.qtyMilli) || line.qtyMilli <= 0) {
            throw (0, errors_1.validation)(`lines.${String(index)}.qtyMilli`, 'Received quantity must be greater than zero.');
        }
        let poPrice = null;
        if (line.poLineId) {
            const poLine = (0, connection_1.conn)().one('SELECT unit_price_cents, qty_milli, received_milli, product_id FROM po_lines WHERE id = ?', [line.poLineId]);
            if (!poLine)
                throw (0, errors_1.notFound)('Purchase order line');
            poPrice = Number(poLine.unit_price_cents);
            // Over-receipt is refused at save time *and* again at post time, because a
            // draft can sit while another receipt is posted against the same line.
            const remaining = Number(poLine.qty_milli) - Number(poLine.received_milli);
            if (line.qtyMilli > remaining) {
                throw (0, errors_1.conflict)(`Only ${(remaining / 1000).toFixed(3)} is still outstanding on that order line, ` +
                    `so ${(line.qtyMilli / 1000).toFixed(3)} cannot be received.`);
            }
        }
        (0, connection_1.conn)().run(`INSERT INTO gr_lines (id, receipt_id, line_no, po_line_id, product_id, qty_milli, unit_cost_cents,
         po_price_cents, lot_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            (0, node_crypto_1.randomUUID)(),
            id,
            index + 1,
            line.poLineId ?? null,
            line.productId,
            line.qtyMilli,
            line.unitCostCents ?? poPrice ?? 0,
            poPrice,
            line.lotRef ?? null,
        ]);
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
function postReceipt(id, scope) {
    const receipt = getReceipt(id);
    if (receipt.status !== 'draft')
        throw (0, errors_1.conflict)(`That receipt is already ${receipt.status}.`);
    if (receipt.lines.length === 0)
        throw (0, errors_1.conflict)('Add at least one line before posting.');
    // Re-check the outstanding quantity: another receipt may have posted since save.
    if (receipt.poId) {
        for (const line of receipt.lines) {
            if (!line.poLineId)
                continue;
            const poLine = (0, connection_1.conn)().one('SELECT qty_milli, received_milli FROM po_lines WHERE id = ?', [line.poLineId]);
            const remaining = Number(poLine?.qty_milli ?? 0) - Number(poLine?.received_milli ?? 0);
            if (line.qtyMilli > remaining) {
                throw (0, errors_1.conflict)(`Only ${(remaining / 1000).toFixed(3)} of ${line.sku} is still outstanding on the order, ` +
                    `so this receipt cannot take ${(line.qtyMilli / 1000).toFixed(3)}.`);
            }
        }
    }
    const at = (0, dates_1.nowIso)();
    const year = (0, settings_1.fiscalYearFor)(receipt.date);
    const number = (0, settings_1.nextNumber)('goods_receipt', year.id);
    let total = 0;
    const stockLocation = receipt.locationId ?? defaultLocationOf(receipt.warehouseId);
    for (const line of receipt.lines) {
        const result = (0, inventory_1.postMove)({
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
        }, scope);
        total += result.move.valueCents;
    }
    const lines = [
        {
            accountId: (0, accounts_1.accountFor)('inventory', 'Inventory'),
            debitCents: (0, money_1.cents)(total),
            description: `Goods received ${number}`,
            partnerType: 'vendor',
            partnerId: receipt.vendorId,
        },
        {
            accountId: (0, accounts_1.accountFor)('grni', 'Goods received not invoiced'),
            creditCents: (0, money_1.cents)(total),
            description: `Goods received ${number}`,
            partnerType: 'vendor',
            partnerId: receipt.vendorId,
        },
    ];
    const entry = (0, finance_engine_1.writeJournal)(scope, {
        date: receipt.date,
        journalCode: 'PUR',
        memo: `Goods received ${number} — ${receipt.vendorName}`,
        lines,
        sourceType: 'goods_receipt',
        sourceId: receipt.id,
    });
    (0, connection_1.conn)().run(`UPDATE goods_receipts SET number = ?, status = 'posted', posted_at = ?, posted_by = ?,
       journal_entry_id = ?, updated_at = ? WHERE id = ?`, [number, at, scope.actorId, entry.id, at, receipt.id]);
    (0, connection_1.conn)().run('UPDATE stock_moves SET journal_entry_id = ? WHERE source_type = ? AND source_id = ?', [
        entry.id,
        'goods_receipt',
        receipt.id,
    ]);
    if (receipt.poId) {
        for (const line of receipt.lines) {
            if (!line.poLineId)
                continue;
            (0, connection_1.conn)().run('UPDATE po_lines SET received_milli = received_milli + ? WHERE id = ?', [
                line.qtyMilli,
                line.poLineId,
            ]);
        }
        refreshPoStatus(receipt.poId);
    }
    (0, cache_1.invalidateCache)('report:');
    return getReceipt(receipt.id);
}
/** Cancels a posted receipt: reverses its journal and un-receives the lines. */
function cancelReceipt(id, reason, scope) {
    const receipt = getReceipt(id);
    if (receipt.status === 'cancelled')
        throw (0, errors_1.conflict)('That receipt is already cancelled.');
    if ((reason ?? '').trim().length === 0)
        throw (0, errors_1.validation)('reason', 'Say why the receipt is being cancelled.');
    if (receipt.status === 'posted') {
        if (receipt.journalEntryId)
            (0, finance_engine_1.reverseEntry)(receipt.journalEntryId, reason, scope);
        // Reverse the stock: an issue of the same quantity from the same location.
        const stockLocation = receipt.locationId ?? defaultLocationOf(receipt.warehouseId);
        for (const line of receipt.lines) {
            (0, inventory_1.postMove)({
                type: 'issue',
                productId: line.productId,
                fromLocationId: stockLocation,
                qtyMilli: -line.qtyMilli,
                movedAt: (0, dates_1.todayIso)(),
                reason: `Receipt ${receipt.number ?? ''} cancelled: ${reason}`,
                sourceType: 'goods_receipt_cancel',
                sourceId: receipt.id,
                suppressJournal: true,
            }, scope);
            if (line.poLineId) {
                (0, connection_1.conn)().run('UPDATE po_lines SET received_milli = MAX(0, received_milli - ?) WHERE id = ?', [
                    line.qtyMilli,
                    line.poLineId,
                ]);
            }
        }
        if (receipt.poId)
            refreshPoStatus(receipt.poId);
    }
    (0, connection_1.conn)().run("UPDATE goods_receipts SET status = 'cancelled', updated_at = ? WHERE id = ?", [(0, dates_1.nowIso)(), id]);
    (0, cache_1.invalidateCache)('report:');
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
function billFromReceipt(receiptId) {
    const receipt = getReceipt(receiptId);
    if (receipt.status !== 'posted') {
        throw (0, errors_1.conflict)('Only a posted receipt can be billed. Post it first.');
    }
    if (receipt.billId)
        throw (0, errors_1.conflict)(`That receipt has already been billed on ${receipt.billId}.`);
    const vendor = (0, connection_1.conn)().one('SELECT payment_terms_days, currency FROM vendors WHERE id = ?', [receipt.vendorId]);
    const terms = Number(vendor?.payment_terms_days ?? 0);
    const due = new Date(`${receipt.date}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + terms);
    const dueDate = due.toISOString().slice(0, 10);
    return {
        vendorId: receipt.vendorId,
        date: (0, dates_1.todayIso)(),
        dueDate,
        currency: vendor?.currency ?? (0, finance_engine_1.baseCurrency)(),
        poId: receipt.poId,
        receiptIds: [receipt.id],
        notes: `From goods receipt ${receipt.number ?? ''}`,
        lines: receipt.lines.map((line) => ({
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
function billMatch(billId) {
    return (0, match_1.evaluateMatch)(billId);
}
// ── vendor reporting ─────────────────────────────────────────────────────────
function vendorStatement(vendorId, from, to) {
    const vendor = (0, connection_1.conn)().one('SELECT name, payment_terms_days, currency FROM vendors WHERE id = ?', [vendorId]);
    if (!vendor)
        throw (0, errors_1.notFound)('Vendor');
    const rows = (0, connection_1.conn)().all(`SELECT id, number, date, due_date, status, total_cents, paid_cents FROM bills
      WHERE vendor_id = ? AND date >= ? AND date <= ? AND status <> 'void'
      ORDER BY date`, [vendorId, from, to]);
    const today = (0, dates_1.todayIso)();
    const statementRows = rows.map((row) => {
        const total = Number(row.total_cents);
        const paid = Number(row.paid_cents);
        const overdue = paid < total && row.due_date < today
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
    const billed = (0, money_1.sumCents)(statementRows.map((row) => (0, money_1.cents)(row.totalCents)));
    const paid = (0, money_1.sumCents)(statementRows.map((row) => (0, money_1.cents)(row.paidCents)));
    const open = (0, money_1.sumCents)(statementRows.map((row) => (0, money_1.cents)(row.openCents)));
    const overdue = (0, money_1.sumCents)(statementRows.filter((row) => row.daysOverdue > 0).map((row) => (0, money_1.cents)(row.openCents)));
    return {
        vendorId,
        vendorName: vendor.name,
        termsDays: Number(vendor.payment_terms_days),
        currency: vendor.currency ?? (0, finance_engine_1.baseCurrency)(),
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
function purchaseAnalysis(groupBy, from, to) {
    if (groupBy === 'vendor') {
        const rows = (0, connection_1.conn)().all(`SELECT v.id AS key, v.name AS label, COALESCE(SUM(b.total_cents), 0) AS billed, COUNT(b.id) AS docs
         FROM vendors v LEFT JOIN bills b ON b.vendor_id = v.id AND b.date >= ? AND b.date <= ? AND b.status <> 'void'
        GROUP BY v.id HAVING billed > 0 ORDER BY billed DESC`, [from, to]);
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
        const rows = (0, connection_1.conn)().all(`SELECT p.id AS key, p.name AS label,
              COALESCE(SUM(bl.qty_milli), 0) AS qty,
              COALESCE(SUM(bl.net_cents), 0) AS billed,
              COUNT(DISTINCT bl.bill_id) AS docs
         FROM bill_lines bl
         JOIN bills b ON b.id = bl.bill_id
         JOIN products p ON p.id = bl.product_id
        WHERE b.date >= ? AND b.date <= ? AND b.status <> 'void'
        GROUP BY p.id ORDER BY billed DESC`, [from, to]);
        return rows.map((row) => ({
            key: row.key,
            label: row.label,
            orderCents: 0,
            billedCents: Number(row.billed),
            documentCount: Number(row.docs),
            qtyMilli: Number(row.qty),
        }));
    }
    const rows = (0, connection_1.conn)().all(`SELECT substr(b.date, 1, 7) AS key, COALESCE(SUM(b.total_cents), 0) AS billed, COUNT(b.id) AS docs
       FROM bills b WHERE b.date >= ? AND b.date <= ? AND b.status <> 'void'
      GROUP BY key ORDER BY key`, [from, to]);
    return rows.map((row) => ({
        key: row.key,
        label: row.key,
        orderCents: 0,
        billedCents: Number(row.billed),
        documentCount: Number(row.docs),
        qtyMilli: 0,
    }));
}
//# sourceMappingURL=purchasing.js.map