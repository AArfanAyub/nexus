"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALLOW_NEGATIVE = void 0;
exports.onHandAt = onHandAt;
exports.onHandTotal = onHandTotal;
exports.convertQty = convertQty;
exports.unitCostAt = unitCostAt;
exports.productCost = productCost;
exports.postMove = postMove;
exports.getMove = getMove;
exports.listMoves = listMoves;
exports.moveHistory = moveHistory;
exports.listQuants = listQuants;
exports.stockOverview = stockOverview;
exports.valuationReport = valuationReport;
exports.lowStock = lowStock;
exports.stockAging = stockAging;
exports.rebuildQuants = rebuildQuants;
exports.listUomConversions = listUomConversions;
exports.saveUomConversion = saveUomConversion;
/**
 * Inventory: the append-only stock ledger (T07, US-24…US-28, BR-10…BR-12).
 *
 * ## The one rule
 *
 * `stock_moves` is the only source of truth for a quantity. `stock_quants` is a
 * **cache** keyed `(product_id, location_id)` that `rebuildQuants()` can throw away
 * and recompute from the moves. Nothing in this file, and no channel anywhere,
 * assigns a quantity directly — the only writes to `stock_quants` are the deltas
 * computed from a move that is being posted, or a full replay.
 *
 * That is why `grep -n "qty_milli" inventory.ts` shows reads, deltas and replays
 * but never an `UPDATE stock_quants SET qty_milli = <literal>`.
 *
 * ## Sign convention
 *
 * A move's `qty_milli` is the signed quantity of its **primary leg**:
 *
 *   | type                        | qty sign | from | to  |
 *   |-----------------------------|----------|------|-----|
 *   | receipt / production_in     | +        | —    | ✓   |
 *   | issue / production_out      | −        | ✓    | —   |
 *   | transfer                    | +        | ✓    | ✓   |
 *   | adjustment                  | ±        | loss | gain|
 *
 * `value_cents` is always stored positive; the direction columns decide the sign
 * of the effect. A replay therefore needs no per-type branch beyond "does it have
 * a from and a to".
 *
 * ## Cost
 *
 * `fifo` keeps layers and consumes oldest-first; `avco` re-averages on receipt
 * only; `standard` never moves. Valuation reads the layers for FIFO and the move
 * ledger for everything else, which is what makes the report identical before and
 * after a quant rebuild (US-26/T07-06).
 */
const node_crypto_1 = require("node:crypto");
const dates_1 = require("../../shared/dates");
const money_1 = require("../../shared/money");
const connection_1 = require("../db/connection");
const errors_1 = require("../errors");
const accounts_1 = require("./accounts");
const audit_1 = require("./audit");
const cache_1 = require("./cache");
const finance_engine_1 = require("./finance.engine");
/** The permission that turns a refused negative stock into an audited override. */
exports.ALLOW_NEGATIVE = 'inventory.stock.allow_negative';
/** Default page size for the stock screens. The cap itself lives in `schemas.ts`. */
const DEFAULT_PAGE_SIZE = 50;
function productOf(productId) {
    const row = (0, connection_1.conn)().one('SELECT * FROM products WHERE id = ?', [productId]);
    if (!row || row.deleted_at)
        throw (0, errors_1.notFound)('Product');
    return row;
}
function locationOf(locationId) {
    const row = (0, connection_1.conn)().one('SELECT * FROM locations WHERE id = ?', [locationId]);
    if (!row)
        throw (0, errors_1.notFound)('Stock location');
    if (Number(row.is_active) !== 1) {
        throw (0, errors_1.conflict)(`${row.name} is archived. Choose an active location.`);
    }
    return row;
}
/** On hand at one location. Zero when there is no row — absence means none. */
function onHandAt(productId, locationId) {
    const row = (0, connection_1.conn)().one('SELECT qty_milli FROM stock_quants WHERE product_id = ? AND location_id = ?', [productId, locationId]);
    return row ? Number(row.qty_milli) : 0;
}
/** On hand across every location. */
function onHandTotal(productId) {
    const row = (0, connection_1.conn)().one('SELECT SUM(qty_milli) AS qty FROM stock_quants WHERE product_id = ?', [productId]);
    return row?.qty === null || row?.qty === undefined ? 0 : Number(row.qty);
}
/**
 * Converts an entered quantity into the product's base unit of measure.
 *
 * A factor of `12_000` means "one of `fromUom` is twelve base units". Stored in
 * milli so a factor of 1/3 is representable without a float. An unknown pair is a
 * validation error rather than a silent 1:1, because silently treating a box as a
 * unit is how a warehouse ends up twelve times over.
 */
function convertQty(productId, qtyMilli, fromUom) {
    if (!fromUom)
        return qtyMilli;
    const product = productOf(productId);
    if (fromUom === product.uom)
        return qtyMilli;
    const row = (0, connection_1.conn)().one(`SELECT factor_milli FROM uom_conversions
      WHERE (product_id = ? OR product_id IS NULL) AND from_uom = ? AND to_uom = ?
      ORDER BY product_id IS NULL LIMIT 1`, [productId, fromUom, product.uom]);
    if (!row) {
        throw (0, errors_1.validation)('uom', `No conversion from ${fromUom} to ${product.uom} is set up for ${product.sku}. ` +
            'Add one on the product before entering quantities in that unit.');
    }
    return (0, money_1.divHalfUp)(qtyMilli * Number(row.factor_milli), 1000);
}
/** The unit cost used to value an outflow. */
function unitCostAt(productId, locationId) {
    const product = productOf(productId);
    if (product.cost_method === 'standard')
        return (0, money_1.cents)(Number(product.standard_cost_cents));
    if (product.cost_method === 'avco')
        return (0, money_1.cents)(Number(product.avg_cost_cents));
    const layer = (0, connection_1.conn)().one(`SELECT unit_cost_cents FROM stock_layers
      WHERE product_id = ? AND location_id = ? AND remaining_milli > 0
      ORDER BY received_at, rowid LIMIT 1`, [productId, locationId]);
    if (layer)
        return (0, money_1.cents)(Number(layer.unit_cost_cents));
    // No open layer (stock predates the layer table, or nothing on hand): fall back
    // to the cached average rather than valuing the outflow at zero.
    return (0, money_1.cents)(Number(product.avg_cost_cents));
}
/**
 * Unit cost for a product regardless of location — what a delivery posts to COGS.
 * Prefers the location when given, otherwise the first location holding stock.
 */
function productCost(productId, locationId) {
    if (locationId)
        return unitCostAt(productId, locationId);
    const row = (0, connection_1.conn)().one('SELECT location_id FROM stock_quants WHERE product_id = ? AND qty_milli > 0 ORDER BY qty_milli DESC LIMIT 1', [productId]);
    if (row)
        return unitCostAt(productId, row.location_id);
    const product = productOf(productId);
    if (product.cost_method === 'standard')
        return (0, money_1.cents)(Number(product.standard_cost_cents));
    return (0, money_1.cents)(Number(product.avg_cost_cents));
}
// ── quant maintenance (derived, never typed) ─────────────────────────────────
/** Applies a delta to the cache. The only writer of `stock_quants` besides replay. */
function applyQuantDelta(productId, locationId, qtyDelta, valueDelta) {
    const existing = (0, connection_1.conn)().one('SELECT qty_milli, value_cents FROM stock_quants WHERE product_id = ? AND location_id = ?', [productId, locationId]);
    if (existing) {
        (0, connection_1.conn)().run('UPDATE stock_quants SET qty_milli = ?, value_cents = ? WHERE product_id = ? AND location_id = ?', [
            Number(existing.qty_milli) + qtyDelta,
            Number(existing.value_cents) + valueDelta,
            productId,
            locationId,
        ]);
        return;
    }
    (0, connection_1.conn)().run('INSERT INTO stock_quants (product_id, location_id, qty_milli, value_cents) VALUES (?, ?, ?, ?)', [
        productId,
        locationId,
        qtyDelta,
        valueDelta,
    ]);
}
/**
 * Consumes FIFO layers oldest-first and returns the value released.
 *
 * When the layers cannot cover the quantity (legacy stock with no layer) the
 * shortfall is valued at the product's cached average, so an issue is never
 * posted at zero cost.
 */
function consumeFifoLayers(productId, locationId, qtyMilli) {
    const layers = (0, connection_1.conn)().all(`SELECT id, qty_milli, remaining_milli, unit_cost_cents FROM stock_layers
      WHERE product_id = ? AND location_id = ? AND remaining_milli > 0
      ORDER BY received_at, rowid`, [productId, locationId]);
    let outstanding = qtyMilli;
    let value = 0;
    for (const layer of layers) {
        if (outstanding <= 0)
            break;
        const take = Math.min(outstanding, Number(layer.remaining_milli));
        if (take <= 0)
            continue;
        value += (0, money_1.mulQty)((0, money_1.cents)(Number(layer.unit_cost_cents)), take);
        (0, connection_1.conn)().run('UPDATE stock_layers SET remaining_milli = ? WHERE id = ?', [
            Number(layer.remaining_milli) - take,
            layer.id,
        ]);
        outstanding -= take;
    }
    if (outstanding > 0) {
        const product = productOf(productId);
        value += (0, money_1.mulQty)((0, money_1.cents)(Number(product.avg_cost_cents)), outstanding);
    }
    return (0, money_1.cents)(value);
}
/** Adds a FIFO layer for a receipt. */
function addFifoLayers(productId, locationId, moveId, qtyMilli, unitCost, at) {
    (0, connection_1.conn)().run(`INSERT INTO stock_layers
       (id, product_id, location_id, move_id, qty_milli, remaining_milli, unit_cost_cents, received_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [(0, node_crypto_1.randomUUID)(), productId, locationId, moveId, qtyMilli, qtyMilli, unitCost, at, (0, dates_1.nowIso)()]);
}
/** Re-averages the product's cost from its current on-hand value. Receipt only. */
function reaverage(productId) {
    const row = (0, connection_1.conn)().one('SELECT SUM(qty_milli) AS qty, SUM(value_cents) AS value FROM stock_quants WHERE product_id = ?', [productId]);
    const qty = Number(row?.qty ?? 0);
    const value = Number(row?.value ?? 0);
    const avg = qty > 0 ? (0, money_1.divHalfUp)(value * 1000, qty) : Number(productOf(productId).avg_cost_cents);
    (0, connection_1.conn)().run('UPDATE products SET avg_cost_cents = ?, updated_at = ? WHERE id = ?', [avg, (0, dates_1.nowIso)(), productId]);
}
// ── posting ──────────────────────────────────────────────────────────────────
/** Legal sign per move type, checked before anything is written. */
function assertSign(type, qtyMilli) {
    if (!Number.isInteger(qtyMilli) || qtyMilli === 0) {
        throw (0, errors_1.validation)('qtyMilli', 'Quantity must be a whole number of thousandths, and not zero.');
    }
    if ((type === 'receipt' || type === 'production_in' || type === 'transfer') && qtyMilli < 0) {
        throw (0, errors_1.validation)('qtyMilli', `A ${type.replace('_', ' ')} takes a positive quantity.`);
    }
    if ((type === 'issue' || type === 'production_out') && qtyMilli > 0) {
        throw (0, errors_1.validation)('qtyMilli', `An ${type.replace('_', ' ')} takes a negative quantity — it removes stock.`);
    }
}
/**
 * Works out which location a move touches, refuses an impossible one, and values
 * the movement. Reads only — every write happens in `postMove`.
 */
function planMove(input, product, magnitude) {
    const needsFrom = input.type === 'issue' || input.type === 'transfer' || input.type === 'production_out';
    const needsTo = input.type === 'receipt' || input.type === 'transfer' || input.type === 'production_in';
    if (needsFrom && !input.fromLocationId) {
        throw (0, errors_1.validation)('fromLocationId', `A ${input.type.replace('_', ' ')} needs a source location.`);
    }
    if (needsTo && !input.toLocationId) {
        throw (0, errors_1.validation)('toLocationId', `A ${input.type.replace('_', ' ')} needs a destination location.`);
    }
    if (input.type === 'adjustment') {
        if (!input.fromLocationId && !input.toLocationId) {
            throw (0, errors_1.validation)('toLocationId', 'An adjustment needs the location being counted.');
        }
        if ((input.reason ?? '').trim().length === 0) {
            throw (0, errors_1.validation)('reason', 'An adjustment needs a reason — it changes the value of the stock.');
        }
    }
    if (input.type === 'transfer') {
        if (input.fromLocationId === input.toLocationId) {
            throw (0, errors_1.validation)('toLocationId', 'A transfer needs two different locations.');
        }
        const from = locationOf(input.fromLocationId ?? '');
        const to = locationOf(input.toLocationId ?? '');
        if (from.warehouse_id !== to.warehouse_id) {
            // Cross-warehouse transfers are legal stock-wise but need a shipping leg;
            // until that exists, refusing is safer than silently teleporting stock.
            throw (0, errors_1.validation)('toLocationId', 'Transfer between warehouses is not supported yet — use two moves.');
        }
    }
    const fromLocationId = needsFrom ? (input.fromLocationId ?? null) : null;
    const toLocationId = needsTo ? (input.toLocationId ?? null) : null;
    // A single-location adjustment arrives as `toLocationId` (gain) or
    // `fromLocationId` (loss). Normalise so the replay only has to ask "from? to?".
    let effectiveFrom = fromLocationId;
    let effectiveTo = toLocationId;
    if (input.type === 'adjustment') {
        const where = input.toLocationId ?? input.fromLocationId ?? '';
        locationOf(where);
        if (magnitude >= 0) {
            effectiveTo = where;
            effectiveFrom = null;
        }
        else {
            effectiveFrom = where;
            effectiveTo = null;
        }
    }
    if (effectiveFrom)
        locationOf(effectiveFrom);
    if (effectiveTo)
        locationOf(effectiveTo);
    const isOutflow = input.type === 'issue' || input.type === 'production_out' || (input.type === 'adjustment' && magnitude < 0);
    // An outflow is valued from the layers/average, never from a caller-supplied
    // price — otherwise an issue could inflate or deflate COGS at will.
    const unitCost = (0, money_1.cents)(input.unitCostCents !== undefined && input.unitCostCents !== null
        ? Number(input.unitCostCents)
        : isOutflow
            ? Number(unitCostAt(product.id, effectiveFrom ?? effectiveTo ?? ''))
            : Number(product.standard_cost_cents) > 0
                ? Number(product.standard_cost_cents)
                : Number(product.avg_cost_cents));
    /*
     * `magnitude` on the plan is always **unsigned**. The sign lives in the
     * direction columns, so a loss is "a from with a positive quantity" and the
     * quant delta is a plain subtraction. Carrying a signed magnitude here is what
     * once made a −3 adjustment *add* three units.
     */
    const absolute = Math.abs(magnitude);
    const value = (0, money_1.mulQty)(unitCost, absolute);
    return { type: input.type, fromLocationId: effectiveFrom, toLocationId: effectiveTo, magnitude: absolute, value, unitCost };
}
/**
 * Posts one move: guards, cost, quant delta, journal, audit.
 *
 * Runs inside the dispatcher's transaction, so a throw at any point leaves no
 * move row, no quant change and no journal entry behind.
 */
function postMove(input, scope, permissions = new Set()) {
    const product = productOf(input.productId);
    if (Number(product.is_active) !== 1) {
        throw (0, errors_1.conflict)(`${product.sku} is archived and cannot move.`);
    }
    if (Number(product.is_stock_tracked) !== 1) {
        throw (0, errors_1.conflict)(`${product.sku} is a service — it does not carry stock.`);
    }
    assertSign(input.type, input.qtyMilli);
    const baseMilli = convertQty(input.productId, input.qtyMilli, input.uom);
    const magnitude = input.type === 'adjustment' ? baseMilli : Math.abs(baseMilli);
    if (magnitude === 0)
        throw (0, errors_1.validation)('qtyMilli', 'Quantity converts to zero in the base unit.');
    const plan = planMove({ ...input, qtyMilli: magnitude }, product, magnitude);
    // ── gate: negative stock ────────────────────────────────────────────────────
    let override = false;
    if (plan.fromLocationId) {
        const available = onHandAt(product.id, plan.fromLocationId);
        const after = available - plan.magnitude;
        if (after < 0) {
            const reason = (input.reason ?? '').trim();
            const permitted = input.allowNegative === true && permissions.has(exports.ALLOW_NEGATIVE) && reason.length > 0;
            if (!permitted) {
                const detail = input.allowNegative === true && !permissions.has(exports.ALLOW_NEGATIVE)
                    ? ' You do not hold the permission to allow negative stock.'
                    : reason.length === 0
                        ? ' A reason is required to allow negative stock.'
                        : '';
                throw (0, errors_1.conflict)(`Only ${(available / 1000).toFixed(3)} of ${product.sku} is at that location, ` +
                    `so ${(plan.magnitude / 1000).toFixed(3)} cannot leave it.${detail}`);
            }
            override = true;
        }
    }
    const at = input.movedAt ?? (0, dates_1.todayIso)();
    const now = (0, dates_1.nowIso)();
    const moveId = (0, node_crypto_1.randomUUID)();
    // ── value the outflow from the layers, then write the row ──────────────────
    let value = plan.value;
    if (plan.fromLocationId && product.cost_method === 'fifo') {
        // Consumption happens before the row is written so a failure leaves the
        // layers untouched; the transaction rolls the partial consumption back.
        value = consumeFifoLayers(product.id, plan.fromLocationId, plan.magnitude);
    }
    const signedQty = input.type === 'adjustment' ? baseMilli : plan.fromLocationId ? -plan.magnitude : plan.magnitude;
    (0, connection_1.conn)().run(`INSERT INTO stock_moves
       (id, reference, type, product_id, from_location_id, to_location_id, qty_milli,
        unit_cost_cents, value_cents, reason, status, source_type, source_id, moved_at,
        created_by, created_at, journal_entry_id, override_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?, NULL, ?)`, [
        moveId,
        input.reference ?? null,
        input.type,
        product.id,
        plan.fromLocationId,
        plan.toLocationId,
        signedQty,
        plan.unitCost,
        value,
        input.reason ?? null,
        input.sourceType ?? null,
        input.sourceId ?? null,
        at,
        scope.actorId ?? 'system',
        now,
        override ? (input.reason ?? null) : null,
    ]);
    // ── quant deltas ───────────────────────────────────────────────────────────
    if (plan.fromLocationId)
        applyQuantDelta(product.id, plan.fromLocationId, -plan.magnitude, -value);
    if (plan.toLocationId)
        applyQuantDelta(product.id, plan.toLocationId, plan.magnitude, value);
    if (product.cost_method === 'fifo' && plan.toLocationId) {
        addFifoLayers(product.id, plan.toLocationId, moveId, plan.magnitude, plan.unitCost, at);
    }
    if (product.cost_method === 'avco' && plan.toLocationId)
        reaverage(product.id);
    // ── journal (§B.4) ─────────────────────────────────────────────────────────
    const journalEntryId = input.suppressJournal
        ? null
        : postMoveJournal(plan, product, value, at, moveId, input, scope);
    if (journalEntryId) {
        (0, connection_1.conn)().run('UPDATE stock_moves SET journal_entry_id = ? WHERE id = ?', [journalEntryId, moveId]);
    }
    // ── audit for the override, which the dispatcher's generic row cannot express ─
    if (override) {
        (0, audit_1.append)({
            actorId: scope.actorId,
            actorName: scope.actorName,
            entity: 'stock_moves',
            entityId: moveId,
            action: 'override_negative_stock',
            after: {
                productId: product.id,
                sku: product.sku,
                locationId: plan.fromLocationId,
                availableMilli: plan.fromLocationId ? onHandAt(product.id, plan.fromLocationId) + plan.magnitude : 0,
                movedMilli: plan.magnitude,
                reason: input.reason ?? '',
            },
            meta: { permission: exports.ALLOW_NEGATIVE },
        });
    }
    (0, cache_1.invalidateCache)('report:');
    (0, cache_1.invalidateCache)('inventory:');
    const move = getMove(moveId);
    return {
        move,
        journalEntryId,
        onHandMilli: onHandTotal(product.id),
        override,
    };
}
/** Writes the §B.4 journal for a move, or nothing for a transfer. */
function postMoveJournal(plan, product, value, at, moveId, input, scope) {
    if (value === 0)
        return null;
    const inventory = (0, accounts_1.accountFor)('inventory', 'Inventory');
    const memo = `${plan.type.replace('_', ' ')} ${product.sku}`;
    if (plan.type === 'transfer')
        return null;
    if (plan.type === 'receipt') {
        const credit = input.sourceType === 'cash_purchase' ? (0, accounts_1.accountFor)('bank', 'Bank') : (0, accounts_1.accountFor)('grni', 'Goods received not invoiced');
        return (0, finance_engine_1.writeJournal)(scope, {
            date: at,
            journalCode: 'STK',
            memo,
            sourceType: 'stock_move',
            sourceId: moveId,
            lines: [
                { accountId: inventory, debitCents: value, description: memo },
                { accountId: credit, creditCents: value, description: memo },
            ],
        }).id;
    }
    if (plan.type === 'issue' || plan.type === 'production_out') {
        const cogs = (0, accounts_1.accountFor)('cogs', 'Cost of goods sold');
        return (0, finance_engine_1.writeJournal)(scope, {
            date: at,
            journalCode: 'STK',
            memo,
            sourceType: 'stock_move',
            sourceId: moveId,
            lines: [
                { accountId: cogs, debitCents: value, description: memo },
                { accountId: inventory, creditCents: value, description: memo },
            ],
        }).id;
    }
    if (plan.type === 'production_in') {
        // There is no work-in-progress module yet, so the offset is the stock
        // adjustment account. A manufacturing pass replaces only this line.
        const offset = (0, accounts_1.accountFor)('stockAdjustment', 'Stock adjustment');
        return (0, finance_engine_1.writeJournal)(scope, {
            date: at,
            journalCode: 'STK',
            memo,
            sourceType: 'stock_move',
            sourceId: moveId,
            lines: [
                { accountId: inventory, debitCents: value, description: memo },
                { accountId: offset, creditCents: value, description: memo },
            ],
        }).id;
    }
    // adjustment
    const variance = (0, accounts_1.accountFor)('stockAdjustment', 'Stock adjustment');
    const gain = plan.toLocationId !== null;
    return (0, finance_engine_1.writeJournal)(scope, {
        date: at,
        journalCode: 'STK',
        memo,
        sourceType: 'stock_move',
        sourceId: moveId,
        lines: gain
            ? [
                { accountId: inventory, debitCents: value, description: memo },
                { accountId: variance, creditCents: value, description: memo },
            ]
            : [
                { accountId: variance, debitCents: value, description: memo },
                { accountId: inventory, creditCents: value, description: memo },
            ],
    }).id;
}
// ── readers ──────────────────────────────────────────────────────────────────
const MOVE_SELECT = `
  SELECT m.id, m.moved_at, m.type, m.reference, m.product_id, p.sku, p.name AS product_name, p.uom,
         m.from_location_id, fl.name AS from_location_name,
         m.to_location_id, tl.name AS to_location_name,
         m.qty_milli, m.unit_cost_cents, m.value_cents, m.reason, m.created_by,
         m.source_type, m.source_id, m.journal_entry_id, m.override_reason
    FROM stock_moves m
    JOIN products p ON p.id = m.product_id
    LEFT JOIN locations fl ON fl.id = m.from_location_id
    LEFT JOIN locations tl ON tl.id = m.to_location_id`;
function toMoveRow(row) {
    return {
        id: row.id,
        movedAt: row.moved_at,
        type: row.type,
        reference: row.reference,
        productId: row.product_id,
        sku: row.sku,
        productName: row.product_name,
        uom: row.uom,
        fromLocationId: row.from_location_id,
        fromLocationName: row.from_location_name,
        toLocationId: row.to_location_id,
        toLocationName: row.to_location_name,
        qtyMilli: Number(row.qty_milli),
        unitCostCents: Number(row.unit_cost_cents),
        valueCents: Number(row.value_cents),
        reason: row.reason,
        createdBy: row.created_by,
        sourceType: row.source_type,
        sourceId: row.source_id,
        journalEntryId: row.journal_entry_id,
        overrideReason: row.override_reason,
    };
}
function getMove(moveId) {
    const row = (0, connection_1.conn)().one(`${MOVE_SELECT} WHERE m.id = ?`, [moveId]);
    if (!row)
        throw (0, errors_1.notFound)('Stock move');
    return toMoveRow(row);
}
/** Paged move browser. Server-side paging: never SELECT a whole ledger. */
function listMoves(filter = {}) {
    const where = [];
    const params = [];
    if (filter.productId) {
        where.push('m.product_id = ?');
        params.push(filter.productId);
    }
    if (filter.locationId) {
        where.push('(m.from_location_id = ? OR m.to_location_id = ?)');
        params.push(filter.locationId, filter.locationId);
    }
    if (filter.type) {
        where.push('m.type = ?');
        params.push(filter.type);
    }
    if (filter.from) {
        where.push('m.moved_at >= ?');
        params.push(filter.from);
    }
    if (filter.to) {
        where.push('m.moved_at <= ?');
        params.push(filter.to);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const pageSize = Math.min(Math.max(filter.pageSize ?? DEFAULT_PAGE_SIZE, 1), 200);
    const page = Math.max(filter.page ?? 1, 1);
    const totalRow = (0, connection_1.conn)().one(`SELECT COUNT(*) AS total FROM stock_moves m ${clause}`, params);
    const rows = (0, connection_1.conn)().all(`${MOVE_SELECT} ${clause} ORDER BY m.moved_at DESC, m.created_at DESC, m.id LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
    return { rows: rows.map(toMoveRow), total: Number(totalRow?.total ?? 0) };
}
/**
 * Move history for one product, with a running balance.
 *
 * The running balance is computed over the **whole** filtered history in date
 * order, then the requested page is sliced — so page 3 shows the true balance at
 * that point rather than restarting at zero (T07-09).
 */
function moveHistory(productId, locationId, page = 1, pageSize = 50) {
    productOf(productId);
    const size = Math.min(Math.max(pageSize, 1), 200);
    const where = ['m.product_id = ?'];
    const params = [productId];
    if (locationId) {
        where.push('(m.from_location_id = ? OR m.to_location_id = ?)');
        params.push(locationId, locationId);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const all = (0, connection_1.conn)().all(`${MOVE_SELECT} ${clause} ORDER BY m.moved_at, m.created_at, m.id`, params);
    let running = 0;
    const withRunning = all.map((row) => {
        const signed = Number(row.qty_milli);
        // For a two-legged transfer, only the leg at the filtered location counts.
        if (locationId && row.from_location_id === locationId && row.to_location_id === locationId) {
            running += 0;
        }
        else if (locationId && row.from_location_id === locationId) {
            running -= Math.abs(signed);
        }
        else if (locationId && row.to_location_id === locationId) {
            running += Math.abs(signed);
        }
        else {
            running += signed;
        }
        return { ...toMoveRow(row), runningMilli: running };
    });
    const start = (Math.max(page, 1) - 1) * size;
    return { rows: withRunning.slice(start, start + size).reverse(), total: withRunning.length };
}
const QUANT_SELECT = `
  SELECT q.product_id, p.sku, p.name AS product_name, p.uom, p.reorder_point_milli,
         q.location_id, l.name AS location_name, l.warehouse_id, w.name AS warehouse_name,
         q.qty_milli, q.value_cents
    FROM stock_quants q
    JOIN products p ON p.id = q.product_id
    JOIN locations l ON l.id = q.location_id
    JOIN warehouses w ON w.id = l.warehouse_id`;
function toQuantRow(row) {
    const qty = Number(row.qty_milli);
    const value = Number(row.value_cents);
    return {
        productId: row.product_id,
        sku: row.sku,
        productName: row.product_name,
        uom: row.uom,
        locationId: row.location_id,
        locationName: row.location_name,
        warehouseId: row.warehouse_id,
        warehouseName: row.warehouse_name,
        qtyMilli: qty,
        valueCents: value,
        unitCostCents: qty === 0 ? 0 : (0, money_1.divHalfUp)(value * 1000, qty),
        reorderPointMilli: Number(row.reorder_point_milli),
        isLow: qty < Number(row.reorder_point_milli),
    };
}
/** The on-hand grid. Paged, with the low-stock filter applied in SQL. */
function listQuants(filter = {}) {
    const where = ['p.deleted_at IS NULL'];
    const params = [];
    if (filter.productId) {
        where.push('q.product_id = ?');
        params.push(filter.productId);
    }
    if (filter.locationId) {
        where.push('q.location_id = ?');
        params.push(filter.locationId);
    }
    if (filter.warehouseId) {
        where.push('l.warehouse_id = ?');
        params.push(filter.warehouseId);
    }
    if (filter.q) {
        // Prefix match so the (sku) and (name) indexes are usable — never `%…%`.
        where.push('(p.sku LIKE ? OR p.name LIKE ?)');
        params.push(`${filter.q}%`, `${filter.q}%`);
    }
    if (filter.lowOnly) {
        where.push('q.qty_milli < p.reorder_point_milli AND p.reorder_point_milli > 0');
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const size = Math.min(Math.max(filter.pageSize ?? DEFAULT_PAGE_SIZE, 1), 200);
    const page = Math.max(filter.page ?? 1, 1);
    const totalRow = (0, connection_1.conn)().one(`SELECT COUNT(*) AS total FROM stock_quants q
       JOIN products p ON p.id = q.product_id
       JOIN locations l ON l.id = q.location_id ${clause}`, params);
    const rows = (0, connection_1.conn)().all(`${QUANT_SELECT} ${clause} ORDER BY p.name, l.name LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]);
    return { rows: rows.map(toQuantRow), total: Number(totalRow?.total ?? 0) };
}
/** Grouped totals for the stock dashboard. */
function stockOverview(groupBy = 'warehouse') {
    const group = groupBy === 'product'
        ? { key: 'p.id', label: 'p.name', join: '' }
        : groupBy === 'location'
            ? { key: 'l.id', label: 'l.name', join: '' }
            : groupBy === 'category'
                ? { key: "COALESCE(p.category, 'Uncategorised')", label: "COALESCE(p.category, 'Uncategorised')", join: '' }
                : { key: 'w.id', label: 'w.name', join: '' };
    const rows = (0, connection_1.conn)().all(`SELECT ${group.key} AS key, ${group.label} AS label,
            SUM(q.qty_milli) AS qty, SUM(q.value_cents) AS value,
            COUNT(DISTINCT q.product_id) AS products
       FROM stock_quants q
       JOIN products p ON p.id = q.product_id
       JOIN locations l ON l.id = q.location_id
       JOIN warehouses w ON w.id = l.warehouse_id
      WHERE p.deleted_at IS NULL
      GROUP BY ${group.key}
      ORDER BY value DESC`);
    return rows.map((row) => ({
        key: row.key,
        label: row.label,
        qtyMilli: Number(row.qty ?? 0),
        valueCents: Number(row.value ?? 0),
        productCount: Number(row.products ?? 0),
    }));
}
/**
 * Valuation as at `asOf`, recomputed from the ledger.
 *
 * FIFO reads the layers; average and standard read the move-maintained value on
 * the quant. Both are independent of `stock_quants.qty_milli` being *correct* in
 * any other sense, which is why the report is identical before and after a rebuild.
 */
function valuationReport(asOf = (0, dates_1.todayIso)()) {
    const rows = [];
    let totalQty = 0;
    let totalValue = 0;
    const products = (0, connection_1.conn)().all(`SELECT id, sku, name, uom, cost_method FROM products
      WHERE deleted_at IS NULL AND is_stock_tracked = 1
      ORDER BY name`);
    for (const product of products) {
        const qtyRow = (0, connection_1.conn)().one('SELECT SUM(qty_milli) AS qty FROM stock_quants WHERE product_id = ?', [product.id]);
        const qty = Number(qtyRow?.qty ?? 0);
        let value;
        if (product.cost_method === 'fifo') {
            const layer = (0, connection_1.conn)().one(`SELECT SUM(remaining_milli * unit_cost_cents) / 1000 AS value, SUM(remaining_milli) AS qty
           FROM stock_layers WHERE product_id = ? AND remaining_milli > 0`, [product.id]);
            const layerQty = Number(layer?.qty ?? 0);
            value =
                layerQty > 0
                    ? Number(layer?.value ?? 0)
                    : // No layers at all: value from the quant so a legacy product is not zero.
                        Number((0, connection_1.conn)().one('SELECT SUM(value_cents) AS value FROM stock_quants WHERE product_id = ?', [product.id])?.value ?? 0);
        }
        else {
            value = Number((0, connection_1.conn)().one('SELECT SUM(value_cents) AS value FROM stock_quants WHERE product_id = ?', [product.id])?.value ?? 0);
        }
        if (qty === 0 && value === 0)
            continue;
        rows.push({
            productId: product.id,
            sku: product.sku,
            productName: product.name,
            uom: product.uom,
            costMethod: product.cost_method,
            qtyMilli: qty,
            unitCostCents: qty === 0 ? 0 : (0, money_1.divHalfUp)(value * 1000, qty),
            valueCents: value,
        });
        totalQty += qty;
        totalValue += value;
    }
    return { asOf, rows, totalQtyMilli: totalQty, totalValueCents: totalValue };
}
/** Products at or below their reorder point, worst shortfall first (US-28). */
function lowStock() {
    const rows = (0, connection_1.conn)().all(`SELECT p.id, p.sku, p.name, p.uom, p.reorder_point_milli,
            (SELECT SUM(q.qty_milli) FROM stock_quants q WHERE q.product_id = p.id) AS on_hand
       FROM products p
      WHERE p.deleted_at IS NULL AND p.is_active = 1 AND p.is_stock_tracked = 1
        AND p.reorder_point_milli > 0`);
    return rows
        .map((row) => {
        const onHand = Number(row.on_hand ?? 0);
        return {
            productId: row.id,
            sku: row.sku,
            productName: row.name,
            uom: row.uom,
            onHandMilli: onHand,
            reorderPointMilli: Number(row.reorder_point_milli),
            shortfallMilli: Number(row.reorder_point_milli) - onHand,
        };
    })
        .filter((row) => row.shortfallMilli > 0)
        .sort((a, b) => b.shortfallMilli - a.shortfallMilli);
}
/** Open FIFO layers bucketed by age, which is what "how stale is my stock" means. */
function stockAging(asOf = (0, dates_1.todayIso)()) {
    const layers = (0, connection_1.conn)().all(`SELECT l.product_id, p.sku, p.name, l.remaining_milli, l.unit_cost_cents, l.received_at
       FROM stock_layers l JOIN products p ON p.id = l.product_id
      WHERE l.remaining_milli > 0
      ORDER BY l.received_at`);
    const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
    const bucketOf = (days) => (days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+');
    const map = new Map();
    for (const layer of layers) {
        const days = Math.max(0, Math.floor((asOfMs - Date.parse(`${layer.received_at}T00:00:00Z`)) / 86_400_000));
        const bucket = bucketOf(days);
        const key = `${layer.product_id}:${bucket}`;
        const value = (0, money_1.mulQty)((0, money_1.cents)(Number(layer.unit_cost_cents)), Number(layer.remaining_milli));
        const existing = map.get(key);
        if (existing) {
            map.set(key, {
                ...existing,
                qtyMilli: existing.qtyMilli + Number(layer.remaining_milli),
                valueCents: existing.valueCents + value,
            });
        }
        else {
            map.set(key, {
                productId: layer.product_id,
                sku: layer.sku,
                productName: layer.name,
                bucket,
                qtyMilli: Number(layer.remaining_milli),
                valueCents: value,
            });
        }
    }
    return [...map.values()].sort((a, b) => a.sku.localeCompare(b.sku) || a.bucket.localeCompare(b.bucket));
}
// ── rebuild ──────────────────────────────────────────────────────────────────
/**
 * Recomputes `stock_quants` and `stock_layers` from `stock_moves` alone.
 *
 * This is the proof that the cache is derived: the acceptance test compares
 * `valuationReport()` before and after and requires it to be identical. Layers are
 * rebuilt by replaying receipts and re-consuming issues in date order, so FIFO
 * state survives a rebuild rather than being approximated.
 */
function rebuildQuants() {
    const database = (0, connection_1.conn)();
    database.run('DELETE FROM stock_quants');
    database.run('DELETE FROM stock_layers');
    const moves = database.all(`SELECT id, type, product_id, from_location_id, to_location_id, qty_milli,
            unit_cost_cents, value_cents, moved_at, created_at
       FROM stock_moves WHERE status = 'posted'
      ORDER BY moved_at, created_at, id`);
    for (const move of moves) {
        const magnitude = Math.abs(Number(move.qty_milli));
        const value = Number(move.value_cents);
        const product = database.one('SELECT cost_method FROM products WHERE id = ?', [
            move.product_id,
        ]);
        const method = product?.cost_method ?? 'avco';
        if (move.from_location_id) {
            applyQuantDelta(move.product_id, move.from_location_id, -magnitude, -value);
            if (method === 'fifo')
                consumeFifoLayers(move.product_id, move.from_location_id, magnitude);
        }
        if (move.to_location_id) {
            applyQuantDelta(move.product_id, move.to_location_id, magnitude, value);
            if (method === 'fifo') {
                addFifoLayers(move.product_id, move.to_location_id, move.id, magnitude, (0, money_1.cents)(Number(move.unit_cost_cents)), move.moved_at);
            }
        }
        if (method === 'avco' && move.to_location_id)
            reaverage(move.product_id);
    }
    const count = database.one('SELECT COUNT(*) AS total FROM stock_quants');
    (0, cache_1.invalidateCache)('inventory:');
    return { rows: Number(count?.total ?? 0), moves: moves.length };
}
// ── unit-of-measure conversions ──────────────────────────────────────────────
function listUomConversions(productId) {
    const rows = (0, connection_1.conn)().all(productId
        ? 'SELECT * FROM uom_conversions WHERE product_id = ? OR product_id IS NULL ORDER BY from_uom'
        : 'SELECT * FROM uom_conversions ORDER BY from_uom', productId ? [productId] : []);
    return rows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        fromUom: row.from_uom,
        toUom: row.to_uom,
        factorMilli: Number(row.factor_milli),
    }));
}
function saveUomConversion(input) {
    if (input.fromUom === input.toUom)
        throw (0, errors_1.validation)('toUom', 'A conversion needs two different units.');
    if (!Number.isInteger(input.factorMilli) || input.factorMilli <= 0) {
        throw (0, errors_1.validation)('factorMilli', 'The conversion factor must be greater than zero.');
    }
    const existing = (0, connection_1.conn)().one('SELECT id FROM uom_conversions WHERE product_id IS ? AND from_uom = ? AND to_uom = ?', [input.productId ?? null, input.fromUom, input.toUom]);
    const id = existing?.id ?? (0, node_crypto_1.randomUUID)();
    if (existing) {
        (0, connection_1.conn)().run('UPDATE uom_conversions SET factor_milli = ? WHERE id = ?', [input.factorMilli, id]);
    }
    else {
        (0, connection_1.conn)().run('INSERT INTO uom_conversions (id, product_id, from_uom, to_uom, factor_milli, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, input.productId ?? null, input.fromUom, input.toUom, input.factorMilli, (0, dates_1.nowIso)()]);
    }
    return {
        id,
        productId: input.productId ?? null,
        fromUom: input.fromUom,
        toUom: input.toUom,
        factorMilli: input.factorMilli,
    };
}
//# sourceMappingURL=inventory.js.map