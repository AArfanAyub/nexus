/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Inventory, purchasing and sales channel handlers (T07/T08).
 *
 * Thin by design, exactly like `ipc.finance.ts`: the dispatcher validates the
 * shape, checks the permission and owns the transaction; every rule lives in
 * `services/inventory.ts`, `services/purchasing.ts` and `services/sales.ts`.
 *
 * The three override permissions (`allow_negative`, `override_expiry`,
 * `override_credit`) are passed *into* the service from `ctx.permissions` rather
 * than checked here, because the decision belongs next to the rule — a handler
 * that forgets to pass them can only ever be stricter, never looser.
 */

import type { StockMoveInput } from '../shared/ops';
import type { RegisterFn } from './ipc';
import { conflict } from './errors';
import * as inventory from './services/inventory';
import * as purchasing from './services/purchasing';
import * as sales from './services/sales';
import type { JournalScope } from './services/finance.engine';

function scopeOf(ctx: { readonly actorId: string | null; readonly actorName: string }): JournalScope {
  return { actorId: ctx.actorId, actorName: ctx.actorName };
}

export function registerOpsChannels(register: RegisterFn): void {
  // ── inventory ──────────────────────────────────────────────────────────────
  register({
    channel: 'inventory.stock.onHand',
    handler: (payload: { productId: string; locationId?: string }) =>
      payload.locationId
        ? { qtyMilli: inventory.onHandAt(payload.productId, payload.locationId) }
        : { qtyMilli: inventory.onHandTotal(payload.productId) },
  });

  register({
    channel: 'inventory.stock.available',
    handler: (payload: { productId: string; locationId: string }) => ({
      qtyMilli: inventory.onHandAt(payload.productId, payload.locationId),
    }),
  });

  register({ channel: 'inventory.moves.list', handler: (payload: never) => inventory.listMoves(payload) });

  register({
    channel: 'inventory.moves.post',
    handler: (payload: StockMoveInput, ctx) => inventory.postMove(payload, scopeOf(ctx), ctx.permissions),
  });

  register({
    channel: 'inventory.moves.reverse',
    handler: (payload: { id: string; reason: string }, ctx) => {
      const original = inventory.getMove(payload.id);
      if ((payload.reason ?? '').trim().length === 0) {
        throw conflict('Say why the move is being reversed.');
      }
      // A reverse is a new opposite move, never a deletion — the ledger is append-only.
      const opposite = original.fromLocationId ? original.toLocationId : original.fromLocationId;
      const input: StockMoveInput = {
        type: original.type === 'receipt' ? 'issue' : original.type === 'issue' ? 'receipt' : original.type,
        productId: original.productId,
        fromLocationId: original.type === 'receipt' ? undefined : (opposite ?? undefined),
        toLocationId: original.type === 'receipt' ? (original.toLocationId ?? undefined) : undefined,
        qtyMilli: original.type === 'receipt' ? -Math.abs(original.qtyMilli) : Math.abs(original.qtyMilli),
        unitCostCents: original.unitCostCents,
        reason: payload.reason,
        movedAt: undefined,
        sourceType: 'move_reversal',
        sourceId: original.id,
        allowNegative: true,
      };
      return inventory.postMove(input, scopeOf(ctx), ctx.permissions);
    },
  });

  register({
    channel: 'inventory.valuation',
    handler: (payload: { asOf?: string } = {}) => inventory.valuationReport(payload.asOf),
  });

  register({ channel: 'inventory.quants.rebuild', handler: () => inventory.rebuildQuants() });

  register({ channel: 'inventory.lowStock', handler: () => inventory.lowStock() });

  register({ channel: 'inventory.quants.list', handler: (payload: never) => inventory.listQuants(payload) });

  register({
    channel: 'inventory.moves.history',
    handler: (payload: { productId: string; locationId?: string; page?: number; pageSize?: number }) =>
      inventory.moveHistory(payload.productId, payload.locationId, payload.page ?? 1, payload.pageSize ?? 50),
  });

  register({ channel: 'inventory.aging', handler: (payload: { asOf?: string } = {}) => inventory.stockAging(payload.asOf) });

  register({
    channel: 'inventory.stock.overview',
    handler: (payload: { groupBy?: 'product' | 'location' | 'warehouse' | 'category' } = {}) =>
      inventory.stockOverview(payload.groupBy ?? 'warehouse'),
  });

  register({
    channel: 'inventory.uom.list',
    handler: (payload: { productId?: string } = {}) => inventory.listUomConversions(payload.productId),
  });

  register({
    channel: 'inventory.uom.save',
    handler: (payload: { productId?: string | null; fromUom: string; toUom: string; factorMilli: number }) =>
      inventory.saveUomConversion(payload),
  });

  // ── purchasing ─────────────────────────────────────────────────────────────
  register({ channel: 'purchasing.po.list', handler: (payload: never) => purchasing.listPos(payload) });
  register({ channel: 'purchasing.po.get', handler: (payload: { id: string }) => purchasing.getPo(payload.id) });
  register({
    channel: 'purchasing.po.save',
    handler: (payload: never) => purchasing.savePo(payload),
  });
  register({
    channel: 'purchasing.po.confirm',
    handler: (payload: { id: string }) => purchasing.confirmPo(payload.id),
  });
  register({
    channel: 'purchasing.po.cancel',
    handler: (payload: { id: string; reason: string }) => purchasing.cancelPo(payload.id, payload.reason),
  });

  register({
    channel: 'purchasing.po.outstanding',
    handler: (payload: { vendorId?: string } = {}) => {
      const page = purchasing.listPos({ vendorId: payload.vendorId, status: 'partially_received', pageSize: 200 });
      return page.rows;
    },
  });

  register({ channel: 'purchasing.receipt.list', handler: (payload: never) => purchasing.listReceipts(payload) });
  register({
    channel: 'purchasing.receipt.get',
    handler: (payload: { id: string }) => purchasing.getReceipt(payload.id),
  });
  register({
    channel: 'purchasing.receipt.create',
    handler: (payload: never) => purchasing.saveReceipt(payload),
  });
  register({
    channel: 'purchasing.receipt.post',
    handler: (payload: { id: string }, ctx) => purchasing.postReceipt(payload.id, scopeOf(ctx)),
  });
  register({
    channel: 'purchasing.receipt.cancel',
    handler: (payload: { id: string; reason: string }, ctx) =>
      purchasing.cancelReceipt(payload.id, payload.reason, scopeOf(ctx)),
  });

  register({
    channel: 'purchasing.bill.fromReceipt',
    handler: (payload: { id: string }) => purchasing.billFromReceipt(payload.id),
  });

  register({
    channel: 'purchasing.match.preview',
    handler: (payload: { id: string }) => purchasing.billMatch(payload.id),
  });

  register({
    channel: 'purchasing.vendors.statement',
    handler: (payload: { vendorId: string; from: string; to: string }) =>
      purchasing.vendorStatement(payload.vendorId, payload.from, payload.to),
  });

  register({
    channel: 'purchasing.analysis',
    handler: (payload: { groupBy: 'vendor' | 'product' | 'month'; from: string; to: string }) =>
      purchasing.purchaseAnalysis(payload.groupBy, payload.from, payload.to),
  });

  // ── sales ──────────────────────────────────────────────────────────────────
  register({
    channel: 'sales.price.resolve',
    handler: (payload: { productId: string; customerId: string; qtyMilli?: number; at?: string }) =>
      sales.resolvePrice(payload.productId, payload.customerId, payload.qtyMilli ?? 1000, payload.at),
  });

  register({ channel: 'sales.quote.list', handler: (payload: never) => sales.listQuotes(payload) });
  register({ channel: 'sales.quote.get', handler: (payload: { id: string }) => sales.getQuote(payload.id) });
  register({ channel: 'sales.quote.save', handler: (payload: never) => sales.saveQuote(payload) });

  register({
    channel: 'sales.quote.send',
    handler: (payload: { id: string }) => {
      const quote = sales.getQuote(payload.id);
      if (quote.status !== 'draft') throw conflict(`That quotation is already ${quote.status}.`);
      return sales.setQuoteStatus(payload.id, 'sent');
    },
  });
  register({
    channel: 'sales.quote.accept',
    handler: (payload: { id: string }) => {
      const quote = sales.getQuote(payload.id);
      if (quote.status !== 'sent' && quote.status !== 'draft') {
        throw conflict(`That quotation is ${quote.status} and cannot be accepted.`);
      }
      return sales.setQuoteStatus(payload.id, 'accepted');
    },
  });
  register({
    channel: 'sales.quote.expire',
    handler: (payload: { id: string }) => sales.setQuoteStatus(payload.id, 'expired'),
  });
  register({
    channel: 'sales.quote.convert',
    handler: (
      payload: { id: string; overrideExpiry?: boolean; reason?: string },
      ctx,
    ) => sales.convertQuoteToOrder(payload.id, scopeOf(ctx), payload, ctx.permissions),
  });

  register({ channel: 'sales.order.list', handler: (payload: never) => sales.listOrders(payload) });
  register({ channel: 'sales.order.get', handler: (payload: { id: string }) => sales.getOrder(payload.id) });
  register({ channel: 'sales.order.save', handler: (payload: never) => sales.saveOrder(payload) });
  register({
    channel: 'sales.order.confirm',
    handler: (payload: { id: string; overrideCredit?: boolean; reason?: string }, ctx) =>
      sales.confirmOrder(payload.id, scopeOf(ctx), payload, ctx.permissions),
  });
  register({
    channel: 'sales.order.cancel',
    handler: (payload: { id: string; reason: string }) => sales.cancelOrder(payload.id, payload.reason),
  });

  register({
    channel: 'sales.order.availability',
    handler: (payload: { orderId: string }) => {
      const order = sales.getOrder(payload.orderId);
      return {
        lines: order.lines.map((line) => ({
          soLineId: line.id,
          productId: line.productId,
          remainingMilli: line.remainingMilli,
          toInvoiceMilli: line.toInvoiceMilli,
          onHandMilli: line.productId ? inventory.onHandTotal(line.productId) : 0,
        })),
      };
    },
  });

  register({
    channel: 'sales.order.invoice',
    handler: (payload: { id: string }) => sales.invoiceFromOrder(payload.id),
  });

  register({
    channel: 'sales.order.markInvoiced',
    handler: (payload: {
      orderId: string;
      invoiceId: string;
      lines: readonly { productId: string | null; qtyMilli: number }[];
    }) => {
      sales.markOrderInvoiced(payload.orderId, payload.invoiceId, payload.lines);
      return { ok: true };
    },
  });

  register({ channel: 'sales.delivery.list', handler: (payload: never) => sales.listDeliveries(payload) });
  register({
    channel: 'sales.delivery.get',
    handler: (payload: { id: string }) => sales.getDelivery(payload.id),
  });
  register({
    channel: 'sales.delivery.create',
    handler: (payload: never) => sales.saveDelivery(payload),
  });
  register({
    channel: 'sales.delivery.post',
    handler: (payload: { id: string }, ctx) => sales.postDelivery(payload.id, scopeOf(ctx)),
  });

  register({ channel: 'sales.customers.outstanding', handler: (payload: { customerId?: string } = {}) =>
    sales.customerOutstanding(payload.customerId),
  });

  register({ channel: 'sales.pricelist.list', handler: () => sales.listPriceLists() });
  register({
    channel: 'sales.pricelist.items',
    handler: (payload: { id: string }) => sales.getPriceList(payload.id),
  });
  register({
    channel: 'sales.pricelist.saveItems',
    handler: (payload: never) => sales.savePriceList(payload),
  });
}
