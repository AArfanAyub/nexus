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
exports.registerCrmChannels = registerCrmChannels;
const crm = __importStar(require("./services/crm"));
const dashboard = __importStar(require("./services/dashboard"));
const search = __importStar(require("./services/search"));
const sales = __importStar(require("./services/sales"));
function scopeOf(ctx) {
    return { actorId: ctx.actorId, actorName: ctx.actorName };
}
function registerCrmChannels(register) {
    // ── pipelines, stages, loss reasons ────────────────────────────────────────
    register({ channel: 'crm.pipelines.list', handler: () => crm.listPipelines() });
    register({
        channel: 'crm.pipelines.save',
        handler: (payload) => crm.savePipeline(payload),
    });
    register({ channel: 'crm.stages.save', handler: (payload) => crm.saveStage(payload) });
    register({
        channel: 'crm.stages.reorder',
        handler: (payload) => crm.reorderStages(payload.pipelineId, payload.ids),
    });
    register({ channel: 'crm.lossReasons.list', handler: () => crm.listLossReasons() });
    register({
        channel: 'crm.lossReasons.save',
        handler: (payload) => crm.saveLossReason(payload),
    });
    // ── the board ──────────────────────────────────────────────────────────────
    register({ channel: 'crm.deal.board', handler: (payload) => crm.board(payload) });
    register({ channel: 'crm.deal.get', handler: (payload) => crm.dealCard(payload.id) });
    // ── moving and closing ─────────────────────────────────────────────────────
    register({
        channel: 'crm.deal.moveStage',
        handler: (payload, ctx) => crm.moveStage(payload, scopeOf(ctx)),
    });
    register({
        channel: 'crm.deal.closeWon',
        handler: (payload, ctx) => crm.closeWon(payload, scopeOf(ctx)),
    });
    register({
        channel: 'crm.deal.closeLost',
        handler: (payload, ctx) => crm.closeLost(payload, scopeOf(ctx)),
    });
    register({
        channel: 'crm.deal.fromWon',
        handler: (payload, ctx) => sales.orderFromDeal(payload.id, payload.customerId, scopeOf(ctx)),
    });
    // ── conversion ─────────────────────────────────────────────────────────────
    register({
        channel: 'crm.lead.convertPreview',
        handler: (payload) => crm.previewConversion(payload),
    });
    register({
        channel: 'crm.lead.convert',
        handler: (payload, ctx) => crm.convertLead(payload, scopeOf(ctx)),
    });
    // ── activities and the timeline ────────────────────────────────────────────
    register({ channel: 'crm.timeline', handler: (payload) => crm.timeline(payload) });
    register({
        channel: 'crm.activity.save',
        handler: (payload, ctx) => crm.saveActivity(payload, scopeOf(ctx)),
    });
    register({
        channel: 'crm.activity.complete',
        handler: (payload) => crm.completeActivity(payload.id, payload.done !== false),
    });
    // ── analytics ──────────────────────────────────────────────────────────────
    register({
        channel: 'crm.analytics',
        handler: (payload) => crm.analytics({ from: payload.from, to: payload.to }, payload.pipelineId),
    });
    // ── dashboard ──────────────────────────────────────────────────────────────
    register({
        channel: 'dashboard.summary',
        handler: (payload) => dashboard.summary(payload),
    });
    // ── search and the palette ─────────────────────────────────────────────────
    register({ channel: 'search.recent.list', handler: () => search.listRecent() });
    register({
        channel: 'search.recent.push',
        handler: (payload) => search.pushRecent(payload),
    });
    register({ channel: 'search.recent.clear', handler: () => search.clearRecent() });
}
//# sourceMappingURL=ipc.crm.js.map