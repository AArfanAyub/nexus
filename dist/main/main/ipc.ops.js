"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerOpsChannels = registerOpsChannels;
const errors_1 = require("./errors");
const inventory = __importStar(require("./services/inventory"));
const purchasing = __importStar(require("./services/purchasing"));
const sales = __importStar(require("./services/sales"));
function scopeOf(ctx) {
    return { actorId: ctx.actorId, actorName: ctx.actorName };
}
function registerOpsChannels(register) {
    // ── inventory ──────────────────────────────────────────────────────────────
    register({
        channel: 'inventory.stock.onHand',
        handler: (payload) => payload.locationId
            ? { qtyMilli: inventory.onHandAt(payload.productId, payload.locationId) }
            : { qtyMilli: inventory.onHandTotal(payload.productId) },
    });
    register({
        channel: 'inventory.stock.available',
        handler: (payload) => ({
            qtyMilli: inventory.onHandAt(payload.productId, payload.locationId),
        }),
    });
    register({ channel: 'inventory.moves.list', handler: (payload) => inventory.listMoves(payload) });
    register({
        channel: 'inventory.moves.post',
        handler: (payload, ctx) => inventory.postMove(payload, scopeOf(ctx), ctx.permissions),
    });
    register({
        channel: 'inventory.moves.reverse',
        handler: (payload, ctx) => {
            const original = inventory.getMove(payload.id);
            if ((payload.reason ?? '').trim().length === 0) {
                throw (0, errors_1.conflict)('Say why the move is being reversed.');
            }
            // A reverse is a new opposite move, never a deletion — the ledger is append-only.
            const opposite = original.fromLocationId ? original.toLocationId : original.fromLocationId;
            const input = {
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
        handler: (payload = {}) => inventory.valuationReport(payload.asOf),
    });
    register({ channel: 'inventory.quants.rebuild', handler: () => inventory.rebuildQuants() });
    register({ channel: 'inventory.lowStock', handler: () => inventory.lowStock() });
    register({ channel: 'inventory.quants.list', handler: (payload) => inventory.listQuants(payload) });
    register({
        channel: 'inventory.moves.history',
        handler: (payload) => inventory.moveHistory(payload.productId, payload.locationId, payload.page ?? 1, payload.pageSize ?? 50),
    });
    register({ channel: 'inventory.aging', handler: (payload = {}) => inventory.stockAging(payload.asOf) });
    register({
        channel: 'inventory.stock.overview',
        handler: (payload = {}) => inventory.stockOverview(payload.groupBy ?? 'warehouse'),
    });
    register({
        channel: 'inventory.uom.list',
        handler: (payload = {}) => inventory.listUomConversions(payload.productId),
    });
    register({
        channel: 'inventory.uom.save',
        handler: (payload) => inventory.saveUomConversion(payload),
    });
    // ── purchasing ─────────────────────────────────────────────────────────────
    register({ channel: 'purchasing.po.list', handler: (payload) => purchasing.listPos(payload) });
    register({ channel: 'purchasing.po.get', handler: (payload) => purchasing.getPo(payload.id) });
    register({
        channel: 'purchasing.po.save',
        handler: (payload) => purchasing.savePo(payload),
    });
    register({
        channel: 'purchasing.po.confirm',
        handler: (payload) => purchasing.confirmPo(payload.id),
    });
    register({
        channel: 'purchasing.po.cancel',
        handler: (payload) => purchasing.cancelPo(payload.id, payload.reason),
    });
    register({
        channel: 'purchasing.po.outstanding',
        handler: (payload = {}) => {
            const page = purchasing.listPos({ vendorId: payload.vendorId, status: 'partially_received', pageSize: 200 });
            return page.rows;
        },
    });
    register({ channel: 'purchasing.receipt.list', handler: (payload) => purchasing.listReceipts(payload) });
    register({
        channel: 'purchasing.receipt.get',
        handler: (payload) => purchasing.getReceipt(payload.id),
    });
    register({
        channel: 'purchasing.receipt.create',
        handler: (payload) => purchasing.saveReceipt(payload),
    });
    register({
        channel: 'purchasing.receipt.post',
        handler: (payload, ctx) => purchasing.postReceipt(payload.id, scopeOf(ctx)),
    });
    register({
        channel: 'purchasing.receipt.cancel',
        handler: (payload, ctx) => purchasing.cancelReceipt(payload.id, payload.reason, scopeOf(ctx)),
    });
    register({
        channel: 'purchasing.bill.fromReceipt',
        handler: (payload) => purchasing.billFromReceipt(payload.id),
    });
    register({
        channel: 'purchasing.match.preview',
        handler: (payload) => purchasing.billMatch(payload.id),
    });
    register({
        channel: 'purchasing.vendors.statement',
        handler: (payload) => purchasing.vendorStatement(payload.vendorId, payload.from, payload.to),
    });
    register({
        channel: 'purchasing.analysis',
        handler: (payload) => purchasing.purchaseAnalysis(payload.groupBy, payload.from, payload.to),
    });
    // ── sales ──────────────────────────────────────────────────────────────────
    register({
        channel: 'sales.price.resolve',
        handler: (payload) => sales.resolvePrice(payload.productId, payload.customerId, payload.qtyMilli ?? 1000, payload.at),
    });
    register({ channel: 'sales.quote.list', handler: (payload) => sales.listQuotes(payload) });
    register({ channel: 'sales.quote.get', handler: (payload) => sales.getQuote(payload.id) });
    register({ channel: 'sales.quote.save', handler: (payload) => sales.saveQuote(payload) });
    register({
        channel: 'sales.quote.send',
        handler: (payload) => {
            const quote = sales.getQuote(payload.id);
            if (quote.status !== 'draft')
                throw (0, errors_1.conflict)(`That quotation is already ${quote.status}.`);
            return sales.setQuoteStatus(payload.id, 'sent');
        },
    });
    register({
        channel: 'sales.quote.accept',
        handler: (payload) => {
            const quote = sales.getQuote(payload.id);
            if (quote.status !== 'sent' && quote.status !== 'draft') {
                throw (0, errors_1.conflict)(`That quotation is ${quote.status} and cannot be accepted.`);
            }
            return sales.setQuoteStatus(payload.id, 'accepted');
        },
    });
    register({
        channel: 'sales.quote.expire',
        handler: (payload) => sales.setQuoteStatus(payload.id, 'expired'),
    });
    register({
        channel: 'sales.quote.convert',
        handler: (payload, ctx) => sales.convertQuoteToOrder(payload.id, scopeOf(ctx), payload, ctx.permissions),
    });
    register({ channel: 'sales.order.list', handler: (payload) => sales.listOrders(payload) });
    register({ channel: 'sales.order.get', handler: (payload) => sales.getOrder(payload.id) });
    register({ channel: 'sales.order.save', handler: (payload) => sales.saveOrder(payload) });
    register({
        channel: 'sales.order.confirm',
        handler: (payload, ctx) => sales.confirmOrder(payload.id, scopeOf(ctx), payload, ctx.permissions),
    });
    register({
        channel: 'sales.order.cancel',
        handler: (payload) => sales.cancelOrder(payload.id, payload.reason),
    });
    register({
        channel: 'sales.order.availability',
        handler: (payload) => {
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
        handler: (payload) => sales.invoiceFromOrder(payload.id),
    });
    register({
        channel: 'sales.order.markInvoiced',
        handler: (payload) => {
            sales.markOrderInvoiced(payload.orderId, payload.invoiceId, payload.lines);
            return { ok: true };
        },
    });
    register({ channel: 'sales.delivery.list', handler: (payload) => sales.listDeliveries(payload) });
    register({
        channel: 'sales.delivery.get',
        handler: (payload) => sales.getDelivery(payload.id),
    });
    register({
        channel: 'sales.delivery.create',
        handler: (payload) => sales.saveDelivery(payload),
    });
    register({
        channel: 'sales.delivery.post',
        handler: (payload, ctx) => sales.postDelivery(payload.id, scopeOf(ctx)),
    });
    register({ channel: 'sales.customers.outstanding', handler: (payload = {}) => sales.customerOutstanding(payload.customerId),
    });
    register({ channel: 'sales.pricelist.list', handler: () => sales.listPriceLists() });
    register({
        channel: 'sales.pricelist.items',
        handler: (payload) => sales.getPriceList(payload.id),
    });
    register({
        channel: 'sales.pricelist.saveItems',
        handler: (payload) => sales.savePriceList(payload),
    });
}
//# sourceMappingURL=ipc.ops.js.map