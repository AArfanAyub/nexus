"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFinanceChannels = registerFinanceChannels;
const finance_1 = require("./services/finance");
const match_1 = require("./services/match");
/** The actor for the audit trail, taken from the dispatcher context. */
function scopeOf(ctx) {
    return { actorId: ctx.actorId, actorName: ctx.actorName };
}
/** Registers every finance channel. */
function registerFinanceChannels(register) {
    // ── chart of accounts ──────────────────────────────────────────────────────
    register({
        channel: 'finance.coa.tree',
        handler: (payload) => (0, finance_1.coaTree)({ includeArchived: payload.includeArchived === true }),
    });
    register({
        channel: 'finance.coa.save',
        handler: (payload) => (0, finance_1.saveAccount)(payload),
    });
    register({
        channel: 'finance.coa.archive',
        handler: (payload) => (0, finance_1.archiveAccount)(payload.id, payload.reason),
    });
    // ── journals ───────────────────────────────────────────────────────────────
    register({
        channel: 'finance.journals.codes',
        handler: () => (0, finance_1.listJournals)(),
    });
    register({
        channel: 'finance.journals.list',
        handler: (payload) => (0, finance_1.listJournalEntries)(payload),
    });
    register({
        channel: 'finance.journals.get',
        handler: (payload) => (0, finance_1.getJournalEntry)(payload.id),
    });
    register({
        channel: 'finance.journals.save',
        handler: (payload, ctx) => (0, finance_1.saveJournal)(payload, scopeOf(ctx)),
    });
    register({
        channel: 'finance.journals.post',
        handler: (payload, ctx) => (0, finance_1.postEntry)(payload.id, scopeOf(ctx)),
    });
    register({
        channel: 'finance.journals.reverse',
        handler: (payload, ctx) => (0, finance_1.reverseEntry)(payload.id, payload.reason, scopeOf(ctx)),
    });
    register({
        channel: 'finance.journals.delete',
        handler: (payload) => (0, finance_1.deleteDraft)(payload.id),
    });
    // ── invoices ───────────────────────────────────────────────────────────────
    register({
        channel: 'finance.invoices.list',
        handler: (payload) => (0, finance_1.listInvoices)(payload),
    });
    register({
        channel: 'finance.invoices.save',
        handler: (payload, ctx) => (0, finance_1.saveInvoice)(payload, scopeOf(ctx)),
    });
    register({
        channel: 'finance.invoices.get',
        handler: (payload) => (0, finance_1.getInvoice)(payload.id),
    });
    register({
        channel: 'finance.invoices.post',
        handler: (payload, ctx) => (0, finance_1.postInvoice)(payload.id, scopeOf(ctx)),
    });
    register({
        channel: 'finance.invoices.void',
        handler: (payload, ctx) => (0, finance_1.voidInvoice)(payload.id, payload.reason, scopeOf(ctx)),
    });
    register({
        channel: 'finance.invoices.duplicate',
        handler: (payload, ctx) => {
            const source = (0, finance_1.getInvoice)(payload.id);
            return (0, finance_1.saveInvoice)({
                customerId: source.customerId,
                date: source.date,
                dueDate: source.dueDate,
                currency: source.currency,
                notes: source.notes,
                terms: source.terms,
                lines: source.lines.map((line) => ({
                    productId: line.productId,
                    description: line.description,
                    qtyMilli: line.qtyMilli,
                    unitPriceCents: line.unitPriceCents,
                    discountBp: line.discountBp,
                    taxId: line.taxId,
                    accountId: line.accountId,
                })),
                sourceType: 'duplicate',
                sourceId: source.id,
            }, scopeOf(ctx));
        },
    });
    // ── bills ──────────────────────────────────────────────────────────────────
    register({
        channel: 'finance.bills.list',
        handler: (payload) => (0, finance_1.listBills)(payload),
    });
    register({
        channel: 'finance.bills.save',
        handler: (payload, ctx) => (0, finance_1.saveBill)(payload, scopeOf(ctx)),
    });
    register({
        channel: 'finance.bills.get',
        handler: (payload) => (0, finance_1.getBill)(payload.id),
    });
    register({
        channel: 'finance.bills.post',
        handler: (payload, ctx) => (0, finance_1.postBill)(payload.id, scopeOf(ctx)),
    });
    register({
        channel: 'finance.bills.void',
        handler: (payload, ctx) => (0, finance_1.voidBill)(payload.id, payload.reason, scopeOf(ctx)),
    });
    // ── payments ───────────────────────────────────────────────────────────────
    register({
        channel: 'finance.payments.list',
        handler: (payload) => (0, finance_1.listPayments)(payload),
    });
    register({
        channel: 'finance.payments.create',
        handler: (payload, ctx) => (0, finance_1.recordPayment)(payload, scopeOf(ctx)),
    });
    register({
        channel: 'finance.payments.allocate',
        handler: (payload) => (0, finance_1.allocate)(payload.id, payload.allocations),
    });
    register({
        channel: 'finance.payments.get',
        handler: (payload) => (0, finance_1.getPayment)(payload.id),
    });
    /**
     * Totals for a document that does not exist yet. Read-only: it computes and
     * returns, writing nothing, which is why it is listed in `READ_ONLY_CHANNELS`
     * and does not open a transaction.
     */
    register({
        channel: 'finance.documents.compute',
        handler: (payload) => (0, finance_1.computeTotals)(payload.lines),
    });
    // ── reports ────────────────────────────────────────────────────────────────
    register({
        channel: 'finance.reports.trialBalance',
        handler: (payload) => (0, finance_1.trialBalance)(payload.asOf),
    });
    register({
        channel: 'finance.reports.pnl',
        handler: (payload) => (0, finance_1.profitAndLoss)(payload.from, payload.to, payload.comparative !== false),
    });
    register({
        channel: 'finance.reports.balanceSheet',
        handler: (payload) => (0, finance_1.balanceSheet)(payload.asOf, payload.comparative !== false),
    });
    register({
        channel: 'finance.reports.cashFlow',
        handler: (payload) => (0, finance_1.cashFlow)(payload.from, payload.to),
    });
    register({
        channel: 'finance.reports.generalLedger',
        handler: (payload) => (0, finance_1.generalLedger)(payload.accountId, payload.from, payload.to, payload.page, payload.pageSize),
    });
    // ── periods ────────────────────────────────────────────────────────────────
    register({
        channel: 'finance.periods.list',
        handler: () => (0, finance_1.listPeriods)(),
    });
    register({
        channel: 'finance.periods.lock',
        handler: (payload, ctx) => (0, finance_1.lockPeriod)(payload.id, payload.reason, scopeOf(ctx)),
    });
    register({
        channel: 'finance.periods.unlock',
        handler: (payload, ctx) => (0, finance_1.unlockPeriod)(payload.id, payload.reason, scopeOf(ctx)),
    });
    register({
        channel: 'finance.periods.close',
        handler: (payload) => (0, finance_1.closeChecklist)(payload.fiscalYearId),
    });
    /*
     * Declared in the catalogue since T06 but never registered — calling it would
     * have reached the dispatcher's "no handler" path. It is the three-way match
     * preview for a bill, which is exactly what `postBill` consults before posting.
     */
    register({
        channel: 'finance.bills.match',
        handler: (payload) => (0, match_1.evaluateMatch)(payload.id),
    });
}
//# sourceMappingURL=ipc.finance.js.map