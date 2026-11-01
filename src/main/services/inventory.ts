/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

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

import { randomUUID } from 'node:crypto';

import type {
  AgingBucket,
  AgingRow,
  CostMethod,
  LowStockRow,
  MoveFilter,
  MoveHistoryRow,
  MoveResult,
  MoveType,
  QuantFilter,
  QuantRow,
  StockMoveInput,
  StockMoveRow,
  StockOverviewRow,
  UomConversionRow,
  ValuationReport,
  ValuationRow,
} from '../../shared/ops';
import type { Paged } from '../../shared/types';
import { nowIso, todayIso } from '../../shared/dates';
import { cents, divHalfUp, mulQty, type Cents } from '../../shared/money';
import { conn } from '../db/connection';
import { conflict, notFound, validation } from '../errors';
import { accountFor } from './accounts';
import { append as auditAppend } from './audit';
import { invalidateCache } from './cache';
import { writeJournal, type JournalScope } from './finance.engine';

/** The permission that turns a refused negative stock into an audited override. */
export const ALLOW_NEGATIVE = 'inventory.stock.allow_negative';

/** Default page size for the stock screens. The cap itself lives in `schemas.ts`. */
const DEFAULT_PAGE_SIZE = 50;

// ── small readers ────────────────────────────────────────────────────────────

interface ProductRow {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly uom: string;
  readonly cost_method: CostMethod;
  readonly standard_cost_cents: number;
  readonly avg_cost_cents: number;
  readonly is_stock_tracked: number;
  readonly is_active: number;
  readonly reorder_point_milli: number;
  readonly deleted_at: string | null;
}

function productOf(productId: string): ProductRow {
  const row = conn().one<ProductRow>('SELECT * FROM products WHERE id = ?', [productId]);
  if (!row || row.deleted_at) throw notFound('Product');
  return row;
}

interface LocationRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly warehouse_id: string;
  readonly is_active: number;
}

function locationOf(locationId: string): LocationRow {
  const row = conn().one<LocationRow>('SELECT * FROM locations WHERE id = ?', [locationId]);
  if (!row) throw notFound('Stock location');
  if (Number(row.is_active) !== 1) {
    throw conflict(`${row.name} is archived. Choose an active location.`);
  }
  return row;
}

/** On hand at one location. Zero when there is no row — absence means none. */
export function onHandAt(productId: string, locationId: string): number {
  const row = conn().one<{ qty_milli: number }>(
    'SELECT qty_milli FROM stock_quants WHERE product_id = ? AND location_id = ?',
    [productId, locationId],
  );
  return row ? Number(row.qty_milli) : 0;
}

/** On hand across every location. */
export function onHandTotal(productId: string): number {
  const row = conn().one<{ qty: number | null }>(
    'SELECT SUM(qty_milli) AS qty FROM stock_quants WHERE product_id = ?',
    [productId],
  );
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
export function convertQty(productId: string, qtyMilli: number, fromUom?: string): number {
  if (!fromUom) return qtyMilli;
  const product = productOf(productId);
  if (fromUom === product.uom) return qtyMilli;
  const row = conn().one<{ factor_milli: number }>(
    `SELECT factor_milli FROM uom_conversions
      WHERE (product_id = ? OR product_id IS NULL) AND from_uom = ? AND to_uom = ?
      ORDER BY product_id IS NULL LIMIT 1`,
    [productId, fromUom, product.uom],
  );
  if (!row) {
    throw validation(
      'uom',
      `No conversion from ${fromUom} to ${product.uom} is set up for ${product.sku}. ` +
        'Add one on the product before entering quantities in that unit.',
    );
  }
  return divHalfUp(qtyMilli * Number(row.factor_milli), 1000);
}

/** The unit cost used to value an outflow. */
export function unitCostAt(productId: string, locationId: string): Cents {
  const product = productOf(productId);
  if (product.cost_method === 'standard') return cents(Number(product.standard_cost_cents));
  if (product.cost_method === 'avco') return cents(Number(product.avg_cost_cents));
  const layer = conn().one<{ unit_cost_cents: number }>(
    `SELECT unit_cost_cents FROM stock_layers
      WHERE product_id = ? AND location_id = ? AND remaining_milli > 0
      ORDER BY received_at, rowid LIMIT 1`,
    [productId, locationId],
  );
  if (layer) return cents(Number(layer.unit_cost_cents));
  // No open layer (stock predates the layer table, or nothing on hand): fall back
  // to the cached average rather than valuing the outflow at zero.
  return cents(Number(product.avg_cost_cents));
}

/**
 * Unit cost for a product regardless of location — what a delivery posts to COGS.
 * Prefers the location when given, otherwise the first location holding stock.
 */
export function productCost(productId: string, locationId?: string): Cents {
  if (locationId) return unitCostAt(productId, locationId);
  const row = conn().one<{ location_id: string }>(
    'SELECT location_id FROM stock_quants WHERE product_id = ? AND qty_milli > 0 ORDER BY qty_milli DESC LIMIT 1',
    [productId],
  );
  if (row) return unitCostAt(productId, row.location_id);
  const product = productOf(productId);
  if (product.cost_method === 'standard') return cents(Number(product.standard_cost_cents));
  return cents(Number(product.avg_cost_cents));
}

// ── quant maintenance (derived, never typed) ─────────────────────────────────

/** Applies a delta to the cache. The only writer of `stock_quants` besides replay. */
function applyQuantDelta(productId: string, locationId: string, qtyDelta: number, valueDelta: number): void {
  const existing = conn().one<{ qty_milli: number; value_cents: number }>(
    'SELECT qty_milli, value_cents FROM stock_quants WHERE product_id = ? AND location_id = ?',
    [productId, locationId],
  );
  if (existing) {
    conn().run('UPDATE stock_quants SET qty_milli = ?, value_cents = ? WHERE product_id = ? AND location_id = ?', [
      Number(existing.qty_milli) + qtyDelta,
      Number(existing.value_cents) + valueDelta,
      productId,
      locationId,
    ]);
    return;
  }
  conn().run('INSERT INTO stock_quants (product_id, location_id, qty_milli, value_cents) VALUES (?, ?, ?, ?)', [
    productId,
    locationId,
    qtyDelta,
    valueDelta,
  ]);
}

interface LayerRow {
  readonly id: string;
  readonly qty_milli: number;
  readonly remaining_milli: number;
  readonly unit_cost_cents: number;
}

/**
 * Consumes FIFO layers oldest-first and returns the value released.
 *
 * When the layers cannot cover the quantity (legacy stock with no layer) the
 * shortfall is valued at the product's cached average, so an issue is never
 * posted at zero cost.
 */
function consumeFifoLayers(productId: string, locationId: string, qtyMilli: number): Cents {
  const layers = conn().all<LayerRow>(
    `SELECT id, qty_milli, remaining_milli, unit_cost_cents FROM stock_layers
      WHERE product_id = ? AND location_id = ? AND remaining_milli > 0
      ORDER BY received_at, rowid`,
    [productId, locationId],
  );
  let outstanding = qtyMilli;
  let value = 0;
  for (const layer of layers) {
    if (outstanding <= 0) break;
    const take = Math.min(outstanding, Number(layer.remaining_milli));
    if (take <= 0) continue;
    value += mulQty(cents(Number(layer.unit_cost_cents)), take);
    conn().run('UPDATE stock_layers SET remaining_milli = ? WHERE id = ?', [
      Number(layer.remaining_milli) - take,
      layer.id,
    ]);
    outstanding -= take;
  }
  if (outstanding > 0) {
    const product = productOf(productId);
    value += mulQty(cents(Number(product.avg_cost_cents)), outstanding);
  }
  return cents(value);
}

/** Adds a FIFO layer for a receipt. */
function addFifoLayers(
  productId: string,
  locationId: string,
  moveId: string,
  qtyMilli: number,
  unitCost: Cents,
  at: string,
): void {
  conn().run(
    `INSERT INTO stock_layers
       (id, product_id, location_id, move_id, qty_milli, remaining_milli, unit_cost_cents, received_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), productId, locationId, moveId, qtyMilli, qtyMilli, unitCost, at, nowIso()],
  );
}

/** Re-averages the product's cost from its current on-hand value. Receipt only. */
function reaverage(productId: string): void {
  const row = conn().one<{ qty: number | null; value: number | null }>(
    'SELECT SUM(qty_milli) AS qty, SUM(value_cents) AS value FROM stock_quants WHERE product_id = ?',
    [productId],
  );
  const qty = Number(row?.qty ?? 0);
  const value = Number(row?.value ?? 0);
  const avg = qty > 0 ? divHalfUp(value * 1000, qty) : Number(productOf(productId).avg_cost_cents);
  conn().run('UPDATE products SET avg_cost_cents = ?, updated_at = ? WHERE id = ?', [avg, nowIso(), productId]);
}

// ── posting ──────────────────────────────────────────────────────────────────

/** Legal sign per move type, checked before anything is written. */
function assertSign(type: MoveType, qtyMilli: number): void {
  if (!Number.isInteger(qtyMilli) || qtyMilli === 0) {
    throw validation('qtyMilli', 'Quantity must be a whole number of thousandths, and not zero.');
  }
  if ((type === 'receipt' || type === 'production_in' || type === 'transfer') && qtyMilli < 0) {
    throw validation('qtyMilli', `A ${type.replace('_', ' ')} takes a positive quantity.`);
  }
  if ((type === 'issue' || type === 'production_out') && qtyMilli > 0) {
    throw validation('qtyMilli', `An ${type.replace('_', ' ')} takes a negative quantity — it removes stock.`);
  }
}

interface MovePlan {
  readonly type: MoveType;
  readonly fromLocationId: string | null;
  readonly toLocationId: string | null;
  readonly magnitude: number;
  readonly value: Cents;
  readonly unitCost: Cents;
}

/**
 * Works out which location a move touches, refuses an impossible one, and values
 * the movement. Reads only — every write happens in `postMove`.
 */
function planMove(input: StockMoveInput, product: ProductRow, magnitude: number): MovePlan {
  const needsFrom = input.type === 'issue' || input.type === 'transfer' || input.type === 'production_out';
  const needsTo = input.type === 'receipt' || input.type === 'transfer' || input.type === 'production_in';

  if (needsFrom && !input.fromLocationId) {
    throw validation('fromLocationId', `A ${input.type.replace('_', ' ')} needs a source location.`);
  }
  if (needsTo && !input.toLocationId) {
    throw validation('toLocationId', `A ${input.type.replace('_', ' ')} needs a destination location.`);
  }
  if (input.type === 'adjustment') {
    if (!input.fromLocationId && !input.toLocationId) {
      throw validation('toLocationId', 'An adjustment needs the location being counted.');
    }
    if ((input.reason ?? '').trim().length === 0) {
      throw validation('reason', 'An adjustment needs a reason — it changes the value of the stock.');
    }
  }
  if (input.type === 'transfer') {
    if (input.fromLocationId === input.toLocationId) {
      throw validation('toLocationId', 'A transfer needs two different locations.');
    }
    const from = locationOf(input.fromLocationId ?? '');
    const to = locationOf(input.toLocationId ?? '');
    if (from.warehouse_id !== to.warehouse_id) {
      // Cross-warehouse transfers are legal stock-wise but need a shipping leg;
      // until that exists, refusing is safer than silently teleporting stock.
      throw validation('toLocationId', 'Transfer between warehouses is not supported yet — use two moves.');
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
    } else {
      effectiveFrom = where;
      effectiveTo = null;
    }
  }

  if (effectiveFrom) locationOf(effectiveFrom);
  if (effectiveTo) locationOf(effectiveTo);

  const isOutflow =
    input.type === 'issue' || input.type === 'production_out' || (input.type === 'adjustment' && magnitude < 0);

  // An outflow is valued from the layers/average, never from a caller-supplied
  // price — otherwise an issue could inflate or deflate COGS at will.
  const unitCost = cents(
    input.unitCostCents !== undefined && input.unitCostCents !== null
      ? Number(input.unitCostCents)
      : isOutflow
        ? Number(unitCostAt(product.id, effectiveFrom ?? effectiveTo ?? ''))
        : Number(product.standard_cost_cents) > 0
          ? Number(product.standard_cost_cents)
          : Number(product.avg_cost_cents),
  );

  /*
   * `magnitude` on the plan is always **unsigned**. The sign lives in the
   * direction columns, so a loss is "a from with a positive quantity" and the
   * quant delta is a plain subtraction. Carrying a signed magnitude here is what
   * once made a −3 adjustment *add* three units.
   */
  const absolute = Math.abs(magnitude);
  const value = mulQty(unitCost, absolute);

  return { type: input.type, fromLocationId: effectiveFrom, toLocationId: effectiveTo, magnitude: absolute, value, unitCost };
}

/**
 * Posts one move: guards, cost, quant delta, journal, audit.
 *
 * Runs inside the dispatcher's transaction, so a throw at any point leaves no
 * move row, no quant change and no journal entry behind.
 */
export function postMove(
  input: StockMoveInput,
  scope: JournalScope,
  permissions: ReadonlySet<string> = new Set<string>(),
): MoveResult {
  const product = productOf(input.productId);
  if (Number(product.is_active) !== 1) {
    throw conflict(`${product.sku} is archived and cannot move.`);
  }
  if (Number(product.is_stock_tracked) !== 1) {
    throw conflict(`${product.sku} is a service — it does not carry stock.`);
  }
  assertSign(input.type, input.qtyMilli);

  const baseMilli = convertQty(input.productId, input.qtyMilli, input.uom);
  const magnitude = input.type === 'adjustment' ? baseMilli : Math.abs(baseMilli);
  if (magnitude === 0) throw validation('qtyMilli', 'Quantity converts to zero in the base unit.');

  const plan = planMove({ ...input, qtyMilli: magnitude }, product, magnitude);

  // ── gate: negative stock ────────────────────────────────────────────────────
  let override = false;
  if (plan.fromLocationId) {
    const available = onHandAt(product.id, plan.fromLocationId);
    const after = available - plan.magnitude;
    if (after < 0) {
      const reason = (input.reason ?? '').trim();
      const permitted = input.allowNegative === true && permissions.has(ALLOW_NEGATIVE) && reason.length > 0;
      if (!permitted) {
        const detail =
          input.allowNegative === true && !permissions.has(ALLOW_NEGATIVE)
            ? ' You do not hold the permission to allow negative stock.'
            : reason.length === 0
              ? ' A reason is required to allow negative stock.'
              : '';
        throw conflict(
          `Only ${(available / 1000).toFixed(3)} of ${product.sku} is at that location, ` +
            `so ${(plan.magnitude / 1000).toFixed(3)} cannot leave it.${detail}`,
        );
      }
      override = true;
    }
  }

  const at = input.movedAt ?? todayIso();
  const now = nowIso();
  const moveId = randomUUID();

  // ── value the outflow from the layers, then write the row ──────────────────
  let value = plan.value;
  if (plan.fromLocationId && product.cost_method === 'fifo') {
    // Consumption happens before the row is written so a failure leaves the
    // layers untouched; the transaction rolls the partial consumption back.
    value = consumeFifoLayers(product.id, plan.fromLocationId, plan.magnitude);
  }

  const signedQty =
    input.type === 'adjustment' ? baseMilli : plan.fromLocationId ? -plan.magnitude : plan.magnitude;

  conn().run(
    `INSERT INTO stock_moves
       (id, reference, type, product_id, from_location_id, to_location_id, qty_milli,
        unit_cost_cents, value_cents, reason, status, source_type, source_id, moved_at,
        created_by, created_at, journal_entry_id, override_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?, NULL, ?)`,
    [
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
    ],
  );

  // ── quant deltas ───────────────────────────────────────────────────────────
  if (plan.fromLocationId) applyQuantDelta(product.id, plan.fromLocationId, -plan.magnitude, -value);
  if (plan.toLocationId) applyQuantDelta(product.id, plan.toLocationId, plan.magnitude, value);

  if (product.cost_method === 'fifo' && plan.toLocationId) {
    addFifoLayers(product.id, plan.toLocationId, moveId, plan.magnitude, plan.unitCost, at);
  }
  if (product.cost_method === 'avco' && plan.toLocationId) reaverage(product.id);

  // ── journal (§B.4) ─────────────────────────────────────────────────────────
  const journalEntryId = input.suppressJournal
    ? null
    : postMoveJournal(plan, product, value, at, moveId, input, scope);
  if (journalEntryId) {
    conn().run('UPDATE stock_moves SET journal_entry_id = ? WHERE id = ?', [journalEntryId, moveId]);
  }

  // ── audit for the override, which the dispatcher's generic row cannot express ─
  if (override) {
    auditAppend({
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
      meta: { permission: ALLOW_NEGATIVE },
    });
  }

  invalidateCache('report:');
  invalidateCache('inventory:');

  const move = getMove(moveId);
  return {
    move,
    journalEntryId,
    onHandMilli: onHandTotal(product.id),
    override,
  };
}

/** Writes the §B.4 journal for a move, or nothing for a transfer. */
function postMoveJournal(
  plan: MovePlan,
  product: ProductRow,
  value: Cents,
  at: string,
  moveId: string,
  input: StockMoveInput,
  scope: JournalScope,
): string | null {
  if (value === 0) return null;
  const inventory = accountFor('inventory', 'Inventory');
  const memo = `${plan.type.replace('_', ' ')} ${product.sku}`;

  if (plan.type === 'transfer') return null;

  if (plan.type === 'receipt') {
    const credit =
      input.sourceType === 'cash_purchase' ? accountFor('bank', 'Bank') : accountFor('grni', 'Goods received not invoiced');
    return writeJournal(scope, {
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
    const cogs = accountFor('cogs', 'Cost of goods sold');
    return writeJournal(scope, {
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
    const offset = accountFor('stockAdjustment', 'Stock adjustment');
    return writeJournal(scope, {
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
  const variance = accountFor('stockAdjustment', 'Stock adjustment');
  const gain = plan.toLocationId !== null;
  return writeJournal(scope, {
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

interface MoveDbRow {
  readonly id: string;
  readonly moved_at: string;
  readonly type: MoveType;
  readonly reference: string | null;
  readonly product_id: string;
  readonly sku: string;
  readonly product_name: string;
  readonly uom: string;
  readonly from_location_id: string | null;
  readonly from_location_name: string | null;
  readonly to_location_id: string | null;
  readonly to_location_name: string | null;
  readonly qty_milli: number;
  readonly unit_cost_cents: number;
  readonly value_cents: number;
  readonly reason: string | null;
  readonly created_by: string;
  readonly source_type: string | null;
  readonly source_id: string | null;
  readonly journal_entry_id: string | null;
  readonly override_reason: string | null;
}

function toMoveRow(row: MoveDbRow): StockMoveRow {
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

export function getMove(moveId: string): StockMoveRow {
  const row = conn().one<MoveDbRow>(`${MOVE_SELECT} WHERE m.id = ?`, [moveId]);
  if (!row) throw notFound('Stock move');
  return toMoveRow(row);
}

/** Paged move browser. Server-side paging: never SELECT a whole ledger. */
export function listMoves(filter: MoveFilter = {}): Paged<StockMoveRow> {
  const where: string[] = [];
  const params: (string | number)[] = [];
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

  const totalRow = conn().one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM stock_moves m ${clause}`,
    params,
  );
  const rows = conn().all<MoveDbRow>(
    `${MOVE_SELECT} ${clause} ORDER BY m.moved_at DESC, m.created_at DESC, m.id LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { rows: rows.map(toMoveRow), total: Number(totalRow?.total ?? 0) };
}

/**
 * Move history for one product, with a running balance.
 *
 * The running balance is computed over the **whole** filtered history in date
 * order, then the requested page is sliced — so page 3 shows the true balance at
 * that point rather than restarting at zero (T07-09).
 */
export function moveHistory(productId: string, locationId?: string, page = 1, pageSize = 50): Paged<MoveHistoryRow> {
  productOf(productId);
  const size = Math.min(Math.max(pageSize, 1), 200);
  const where = ['m.product_id = ?'];
  const params: (string | number)[] = [productId];
  if (locationId) {
    where.push('(m.from_location_id = ? OR m.to_location_id = ?)');
    params.push(locationId, locationId);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const all = conn().all<MoveDbRow>(`${MOVE_SELECT} ${clause} ORDER BY m.moved_at, m.created_at, m.id`, params);

  let running = 0;
  const withRunning: MoveHistoryRow[] = all.map((row) => {
    const signed = Number(row.qty_milli);
    // For a two-legged transfer, only the leg at the filtered location counts.
    if (locationId && row.from_location_id === locationId && row.to_location_id === locationId) {
      running += 0;
    } else if (locationId && row.from_location_id === locationId) {
      running -= Math.abs(signed);
    } else if (locationId && row.to_location_id === locationId) {
      running += Math.abs(signed);
    } else {
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

interface QuantDbRow {
  readonly product_id: string;
  readonly sku: string;
  readonly product_name: string;
  readonly uom: string;
  readonly reorder_point_milli: number;
  readonly location_id: string;
  readonly location_name: string;
  readonly warehouse_id: string;
  readonly warehouse_name: string;
  readonly qty_milli: number;
  readonly value_cents: number;
}

function toQuantRow(row: QuantDbRow): QuantRow {
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
    unitCostCents: qty === 0 ? 0 : divHalfUp(value * 1000, qty),
    reorderPointMilli: Number(row.reorder_point_milli),
    isLow: qty < Number(row.reorder_point_milli),
  };
}

/** The on-hand grid. Paged, with the low-stock filter applied in SQL. */
export function listQuants(filter: QuantFilter = {}): Paged<QuantRow> {
  const where: string[] = ['p.deleted_at IS NULL'];
  const params: (string | number)[] = [];
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
  const totalRow = conn().one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM stock_quants q
       JOIN products p ON p.id = q.product_id
       JOIN locations l ON l.id = q.location_id ${clause}`,
    params,
  );
  const rows = conn().all<QuantDbRow>(
    `${QUANT_SELECT} ${clause} ORDER BY p.name, l.name LIMIT ? OFFSET ?`,
    [...params, size, (page - 1) * size],
  );
  return { rows: rows.map(toQuantRow), total: Number(totalRow?.total ?? 0) };
}

/** Grouped totals for the stock dashboard. */
export function stockOverview(groupBy: 'product' | 'location' | 'warehouse' | 'category' = 'warehouse'): StockOverviewRow[] {
  const group =
    groupBy === 'product'
      ? { key: 'p.id', label: 'p.name', join: '' }
      : groupBy === 'location'
        ? { key: 'l.id', label: 'l.name', join: '' }
        : groupBy === 'category'
          ? { key: "COALESCE(p.category, 'Uncategorised')", label: "COALESCE(p.category, 'Uncategorised')", join: '' }
          : { key: 'w.id', label: 'w.name', join: '' };
  const rows = conn().all<{ key: string; label: string; qty: number; value: number; products: number }>(
    `SELECT ${group.key} AS key, ${group.label} AS label,
            SUM(q.qty_milli) AS qty, SUM(q.value_cents) AS value,
            COUNT(DISTINCT q.product_id) AS products
       FROM stock_quants q
       JOIN products p ON p.id = q.product_id
       JOIN locations l ON l.id = q.location_id
       JOIN warehouses w ON w.id = l.warehouse_id
      WHERE p.deleted_at IS NULL
      GROUP BY ${group.key}
      ORDER BY value DESC`,
  );
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
export function valuationReport(asOf = todayIso()): ValuationReport {
  const rows: ValuationRow[] = [];
  let totalQty = 0;
  let totalValue = 0;

  const products = conn().all<{
    id: string;
    sku: string;
    name: string;
    uom: string;
    cost_method: CostMethod;
  }>(
    `SELECT id, sku, name, uom, cost_method FROM products
      WHERE deleted_at IS NULL AND is_stock_tracked = 1
      ORDER BY name`,
  );

  for (const product of products) {
    const qtyRow = conn().one<{ qty: number | null }>(
      'SELECT SUM(qty_milli) AS qty FROM stock_quants WHERE product_id = ?',
      [product.id],
    );
    const qty = Number(qtyRow?.qty ?? 0);

    let value: number;
    if (product.cost_method === 'fifo') {
      const layer = conn().one<{ value: number | null; qty: number | null }>(
        `SELECT SUM(remaining_milli * unit_cost_cents) / 1000 AS value, SUM(remaining_milli) AS qty
           FROM stock_layers WHERE product_id = ? AND remaining_milli > 0`,
        [product.id],
      );
      const layerQty = Number(layer?.qty ?? 0);
      value =
        layerQty > 0
          ? Number(layer?.value ?? 0)
          : // No layers at all: value from the quant so a legacy product is not zero.
            Number(
              conn().one<{ value: number | null }>(
                'SELECT SUM(value_cents) AS value FROM stock_quants WHERE product_id = ?',
                [product.id],
              )?.value ?? 0,
            );
    } else {
      value = Number(
        conn().one<{ value: number | null }>(
          'SELECT SUM(value_cents) AS value FROM stock_quants WHERE product_id = ?',
          [product.id],
        )?.value ?? 0,
      );
    }

    if (qty === 0 && value === 0) continue;
    rows.push({
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      uom: product.uom,
      costMethod: product.cost_method,
      qtyMilli: qty,
      unitCostCents: qty === 0 ? 0 : divHalfUp(value * 1000, qty),
      valueCents: value,
    });
    totalQty += qty;
    totalValue += value;
  }

  return { asOf, rows, totalQtyMilli: totalQty, totalValueCents: totalValue };
}

/** Products at or below their reorder point, worst shortfall first (US-28). */
export function lowStock(): LowStockRow[] {
  const rows = conn().all<{
    id: string;
    sku: string;
    name: string;
    uom: string;
    reorder_point_milli: number;
    on_hand: number | null;
  }>(
    `SELECT p.id, p.sku, p.name, p.uom, p.reorder_point_milli,
            (SELECT SUM(q.qty_milli) FROM stock_quants q WHERE q.product_id = p.id) AS on_hand
       FROM products p
      WHERE p.deleted_at IS NULL AND p.is_active = 1 AND p.is_stock_tracked = 1
        AND p.reorder_point_milli > 0`,
  );
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
export function stockAging(asOf = todayIso()): AgingRow[] {
  const layers = conn().all<{
    product_id: string;
    sku: string;
    name: string;
    remaining_milli: number;
    unit_cost_cents: number;
    received_at: string;
  }>(
    `SELECT l.product_id, p.sku, p.name, l.remaining_milli, l.unit_cost_cents, l.received_at
       FROM stock_layers l JOIN products p ON p.id = l.product_id
      WHERE l.remaining_milli > 0
      ORDER BY l.received_at`,
  );
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const bucketOf = (days: number): AgingBucket => (days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+');

  const map = new Map<string, AgingRow>();
  for (const layer of layers) {
    const days = Math.max(0, Math.floor((asOfMs - Date.parse(`${layer.received_at}T00:00:00Z`)) / 86_400_000));
    const bucket = bucketOf(days);
    const key = `${layer.product_id}:${bucket}`;
    const value = mulQty(cents(Number(layer.unit_cost_cents)), Number(layer.remaining_milli));
    const existing = map.get(key);
    if (existing) {
      map.set(key, {
        ...existing,
        qtyMilli: existing.qtyMilli + Number(layer.remaining_milli),
        valueCents: existing.valueCents + value,
      });
    } else {
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
export function rebuildQuants(): { readonly rows: number; readonly moves: number } {
  const database = conn();
  database.run('DELETE FROM stock_quants');
  database.run('DELETE FROM stock_layers');

  const moves = database.all<{
    id: string;
    type: MoveType;
    product_id: string;
    from_location_id: string | null;
    to_location_id: string | null;
    qty_milli: number;
    unit_cost_cents: number;
    value_cents: number;
    moved_at: string;
    created_at: string;
  }>(
    `SELECT id, type, product_id, from_location_id, to_location_id, qty_milli,
            unit_cost_cents, value_cents, moved_at, created_at
       FROM stock_moves WHERE status = 'posted'
      ORDER BY moved_at, created_at, id`,
  );

  for (const move of moves) {
    const magnitude = Math.abs(Number(move.qty_milli));
    const value = Number(move.value_cents);
    const product = database.one<{ cost_method: CostMethod }>('SELECT cost_method FROM products WHERE id = ?', [
      move.product_id,
    ]);
    const method = product?.cost_method ?? 'avco';

    if (move.from_location_id) {
      applyQuantDelta(move.product_id, move.from_location_id, -magnitude, -value);
      if (method === 'fifo') consumeFifoLayers(move.product_id, move.from_location_id, magnitude);
    }
    if (move.to_location_id) {
      applyQuantDelta(move.product_id, move.to_location_id, magnitude, value);
      if (method === 'fifo') {
        addFifoLayers(
          move.product_id,
          move.to_location_id,
          move.id,
          magnitude,
          cents(Number(move.unit_cost_cents)),
          move.moved_at,
        );
      }
    }
    if (method === 'avco' && move.to_location_id) reaverage(move.product_id);
  }

  const count = database.one<{ total: number }>('SELECT COUNT(*) AS total FROM stock_quants');
  invalidateCache('inventory:');
  return { rows: Number(count?.total ?? 0), moves: moves.length };
}

// ── unit-of-measure conversions ──────────────────────────────────────────────

export function listUomConversions(productId?: string): readonly UomConversionRow[] {
  const rows = conn().all<{
    id: string;
    product_id: string | null;
    from_uom: string;
    to_uom: string;
    factor_milli: number;
  }>(
    productId
      ? 'SELECT * FROM uom_conversions WHERE product_id = ? OR product_id IS NULL ORDER BY from_uom'
      : 'SELECT * FROM uom_conversions ORDER BY from_uom',
    productId ? [productId] : [],
  );
  return rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    fromUom: row.from_uom,
    toUom: row.to_uom,
    factorMilli: Number(row.factor_milli),
  }));
}

export function saveUomConversion(input: {
  readonly productId?: string | null;
  readonly fromUom: string;
  readonly toUom: string;
  readonly factorMilli: number;
}): UomConversionRow {
  if (input.fromUom === input.toUom) throw validation('toUom', 'A conversion needs two different units.');
  if (!Number.isInteger(input.factorMilli) || input.factorMilli <= 0) {
    throw validation('factorMilli', 'The conversion factor must be greater than zero.');
  }
  const existing = conn().one<{ id: string }>(
    'SELECT id FROM uom_conversions WHERE product_id IS ? AND from_uom = ? AND to_uom = ?',
    [input.productId ?? null, input.fromUom, input.toUom],
  );
  const id = existing?.id ?? randomUUID();
  if (existing) {
    conn().run('UPDATE uom_conversions SET factor_milli = ? WHERE id = ?', [input.factorMilli, id]);
  } else {
    conn().run(
      'INSERT INTO uom_conversions (id, product_id, from_uom, to_uom, factor_milli, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, input.productId ?? null, input.fromUom, input.toUom, input.factorMilli, nowIso()],
    );
  }
  return {
    id,
    productId: input.productId ?? null,
    fromUom: input.fromUom,
    toUom: input.toUom,
    factorMilli: input.factorMilli,
  };
}
