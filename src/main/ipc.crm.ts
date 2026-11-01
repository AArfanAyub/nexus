/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * CRM, dashboard and search channel handlers (T09).
 *
 * Thin by design, like `ipc.ops.ts`: the dispatcher validates the shape, checks
 * the permission and owns the transaction; the rules live in `services/crm.ts`,
 * `services/dashboard.ts` and `services/search.ts`.
 */

import type { DealBoardFilter, LeadConvertInput, TimelineFilter } from '../shared/crm';
import type { DashboardRequest } from '../shared/dashboard';
import type { RegisterFn } from './ipc';
import * as crm from './services/crm';
import * as dashboard from './services/dashboard';
import * as search from './services/search';
import * as sales from './services/sales';

function scopeOf(ctx: { readonly actorId: string | null; readonly actorName: string }): crm.CrmScope {
  return { actorId: ctx.actorId, actorName: ctx.actorName };
}

export function registerCrmChannels(register: RegisterFn): void {
  // ── pipelines, stages, loss reasons ────────────────────────────────────────
  register({ channel: 'crm.pipelines.list', handler: () => crm.listPipelines() });
  register({
    channel: 'crm.pipelines.save',
    handler: (payload: crm.PipelineInput) => crm.savePipeline(payload),
  });
  register({ channel: 'crm.stages.save', handler: (payload: crm.StageInput) => crm.saveStage(payload) });
  register({
    channel: 'crm.stages.reorder',
    handler: (payload: { pipelineId: string; ids: readonly string[] }) =>
      crm.reorderStages(payload.pipelineId, payload.ids),
  });
  register({ channel: 'crm.lossReasons.list', handler: () => crm.listLossReasons() });
  register({
    channel: 'crm.lossReasons.save',
    handler: (payload: crm.LossReasonInput) => crm.saveLossReason(payload),
  });

  // ── the board ──────────────────────────────────────────────────────────────
  register({ channel: 'crm.deal.board', handler: (payload: DealBoardFilter) => crm.board(payload) });
  register({ channel: 'crm.deal.get', handler: (payload: { id: string }) => crm.dealCard(payload.id) });

  // ── moving and closing ─────────────────────────────────────────────────────
  register({
    channel: 'crm.deal.moveStage',
    handler: (payload: { id: string; stageId: string; note?: string }, ctx) =>
      crm.moveStage(payload, scopeOf(ctx)),
  });
  register({
    channel: 'crm.deal.closeWon',
    handler: (payload: { id: string; note?: string }, ctx) => crm.closeWon(payload, scopeOf(ctx)),
  });
  register({
    channel: 'crm.deal.closeLost',
    handler: (payload: { id: string; reason: string; note?: string }, ctx) =>
      crm.closeLost(payload, scopeOf(ctx)),
  });
  register({
    channel: 'crm.deal.fromWon',
    handler: (payload: { id: string; customerId: string }, ctx) =>
      sales.orderFromDeal(payload.id, payload.customerId, scopeOf(ctx)),
  });

  // ── conversion ─────────────────────────────────────────────────────────────
  register({
    channel: 'crm.lead.convertPreview',
    handler: (payload: LeadConvertInput) => crm.previewConversion(payload),
  });
  register({
    channel: 'crm.lead.convert',
    handler: (payload: LeadConvertInput, ctx) => crm.convertLead(payload, scopeOf(ctx)),
  });

  // ── activities and the timeline ────────────────────────────────────────────
  register({ channel: 'crm.timeline', handler: (payload: TimelineFilter) => crm.timeline(payload) });
  register({
    channel: 'crm.activity.save',
    handler: (payload: crm.ActivityInput, ctx) => crm.saveActivity(payload, scopeOf(ctx)),
  });
  register({
    channel: 'crm.activity.complete',
    handler: (payload: { id: string; done?: boolean }) => crm.completeActivity(payload.id, payload.done !== false),
  });

  // ── analytics ──────────────────────────────────────────────────────────────
  register({
    channel: 'crm.analytics',
    handler: (payload: { from: string; to: string; pipelineId?: string }) =>
      crm.analytics({ from: payload.from, to: payload.to }, payload.pipelineId),
  });

  // ── dashboard ──────────────────────────────────────────────────────────────
  register({
    channel: 'dashboard.summary',
    handler: (payload: DashboardRequest) => dashboard.summary(payload),
  });

  // ── search and the palette ─────────────────────────────────────────────────
  register({ channel: 'search.recent.list', handler: () => search.listRecent() });
  register({
    channel: 'search.recent.push',
    handler: (payload: Omit<search.RecentItem, 'at'>) => search.pushRecent(payload),
  });
  register({ channel: 'search.recent.clear', handler: () => search.clearRecent() });
}
