/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Everything that crosses IPC for CRM (T09) and nothing else.
 *
 * The rule from T01 holds: a shape that the renderer reads lives here, in
 * `shared/`, so neither side imports from the other. Generic record CRUD for
 * accounts, contacts, leads, deals and activities goes through the `entity`
 * family (see `ENTITIES` in `types.ts`) — this file only describes the shapes
 * that need real logic: the board, the funnel, the timeline, conversion.
 */

// ── stages & pipelines ──────────────────────────────────────────────────────

/** Colour tokens a stage may use. Mapped to CSS variables by the renderer. */
export type StageColor = 'info' | 'accent' | 'warning' | 'success' | 'danger' | 'neutral';

export interface DealStageRow {
  readonly id: string;
  readonly pipelineId: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly probabilityBp: number;
  readonly isWon: boolean;
  readonly isLost: boolean;
  readonly color: StageColor;
}

export interface PipelineRow {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly stages: readonly DealStageRow[];
}

// ── the board ───────────────────────────────────────────────────────────────

/** A deal as the Kanban card needs it — no line items, no custom fields. */
export interface DealCard {
  readonly id: string;
  readonly name: string;
  /** The stage the card is in — the board needs it to ignore a no-op drop. */
  readonly stageId: string;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly contactName: string | null;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly valueCents: number;
  readonly currency: string;
  readonly probabilityBp: number;
  readonly expectedCloseDate: string | null;
  /** Whole days since the deal entered its current stage. */
  readonly daysInStage: number;
  /** Whole days since the expected close date passed. 0 when not overdue. */
  readonly daysOverdue: number;
  readonly stageChangedAt: string;
}

/**
 * Column aggregates, computed in SQL.
 *
 * `weightedCents` is `Σ value × probability / 10000` — the forecast, as opposed
 * to the pipeline, and the number a sales manager actually reads.
 */
export interface DealColumn {
  readonly stage: DealStageRow;
  readonly count: number;
  readonly valueCents: number;
  readonly weightedCents: number;
  readonly deals: readonly DealCard[];
}

export interface DealBoard {
  readonly pipeline: PipelineRow;
  readonly columns: readonly DealColumn[];
  readonly totals: {
    readonly count: number;
    readonly valueCents: number;
    readonly weightedCents: number;
  };
  /** Every deal matching the filter but sitting in a won or lost stage. */
  readonly closed: { readonly wonCents: number; readonly lostCents: number; readonly count: number };
}

export interface DealBoardFilter {
  readonly pipelineId?: string;
  readonly ownerId?: string;
  readonly stageId?: string;
  /** Inclusive ISO dates on `expected_close_date`. */
  readonly closeFrom?: string;
  readonly closeTo?: string;
  readonly q?: string;
  /** Cards per column. The board is not a place to page through 500 deals. */
  readonly perColumn?: number;
}

// ── moving and closing ──────────────────────────────────────────────────────

export interface MoveStageInput {
  readonly id: string;
  readonly stageId: string;
  /** Optional note, written onto the `stage_changed` activity. */
  readonly note?: string;
}

export interface CloseLostInput {
  readonly id: string;
  /** Required. A loss with no reason teaches nobody anything. */
  readonly reason: string;
  readonly note?: string;
}

export interface CloseWonInput {
  readonly id: string;
  readonly note?: string;
}

// ── lead conversion ─────────────────────────────────────────────────────────

/**
 * What the wizard shows on step 3 and then submits.
 *
 * Every field is optional except the two that have no sensible default: the
 * account needs a name and the deal needs a pipeline. The wizard pre-fills the
 * rest from the lead, which is why the preview and the commit take the same
 * shape — what you see is literally what is created.
 */
export interface LeadConvertInput {
  readonly leadId: string;
  readonly account: {
    readonly name: string;
    readonly industry?: string | null;
    readonly domain?: string | null;
    readonly phone?: string | null;
    readonly ownerId?: string | null;
    /** Attach to an existing customer record when the lead is already one. */
    readonly customerId?: string | null;
  };
  readonly contact: {
    readonly firstName: string;
    readonly lastName?: string | null;
    readonly title?: string | null;
    readonly email?: string | null;
    readonly phone?: string | null;
    readonly isPrimary?: boolean;
  };
  readonly deal: {
    readonly name: string;
    readonly pipelineId: string;
    readonly stageId?: string | null;
    readonly valueCents: number;
    readonly currency?: string;
    readonly expectedCloseDate?: string | null;
    readonly ownerId?: string | null;
  };
}

export interface LeadConvertPreview {
  readonly lead: {
    readonly id: string;
    readonly name: string;
    readonly company: string | null;
    readonly status: string;
    readonly estimatedValueCents: number;
  };
  readonly willCreate: {
    readonly account: { readonly name: string; readonly industry: string | null };
    readonly contact: { readonly name: string; readonly email: string | null };
    readonly deal: { readonly name: string; readonly valueCents: number; readonly stageName: string };
  };
  readonly blocked: readonly string[];
}

export interface LeadConvertResult {
  readonly accountId: string;
  readonly contactId: string;
  readonly dealId: string;
  readonly leadId: string;
}

// ── timeline ────────────────────────────────────────────────────────────────

export type ActivityType = 'call' | 'email' | 'meeting' | 'task' | 'note' | 'stage_changed' | 'system';

export interface ActivityRow {
  readonly id: string;
  readonly type: ActivityType;
  readonly subject: string;
  readonly body: string | null;
  readonly entity: string;
  readonly entityId: string;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly dueAt: string | null;
  readonly completedAt: string | null;
  readonly isDone: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface TimelineFilter {
  readonly entity?: string;
  readonly entityId?: string;
  /** Open (not done) activities only, soonest first. */
  readonly openOnly?: boolean;
  readonly from?: string;
  readonly to?: string;
  readonly ownerId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface TimelineResult {
  readonly rows: readonly ActivityRow[];
  readonly total: number;
}

// ── analytics ───────────────────────────────────────────────────────────────

export interface AnalyticsPeriod {
  readonly from: string;
  readonly to: string;
}

export interface WinRateBucket {
  readonly label: string;
  readonly won: number;
  readonly lost: number;
  readonly winRateBp: number;
}

export interface FunnelStage {
  readonly stageId: string;
  readonly name: string;
  readonly color: StageColor;
  readonly count: number;
  readonly valueCents: number;
  readonly weightedCents: number;
}

export interface OwnerScore {
  readonly ownerId: string | null;
  readonly ownerName: string;
  readonly wonCents: number;
  readonly wonCount: number;
  readonly lostCount: number;
  readonly openCents: number;
  readonly winRateBp: number;
}

export interface LossReasonBucket {
  readonly reason: string;
  readonly count: number;
  readonly valueCents: number;
}

export interface ForecastPoint {
  readonly month: string;
  readonly wonCents: number;
  readonly lostCents: number;
  readonly openWeightedCents: number;
}

export interface CrmAnalytics {
  readonly period: AnalyticsPeriod;
  readonly kpis: {
    readonly wonCents: number;
    readonly lostCents: number;
    readonly openCents: number;
    readonly weightedCents: number;
    readonly winRateBp: number;
    readonly wonCount: number;
    readonly lostCount: number;
    /** Mean `won_at − created_at` in whole days. `null` when nothing has won. */
    readonly avgCycleDays: number | null;
    readonly avgDealCents: number;
  };
  readonly funnel: readonly FunnelStage[];
  readonly monthly: readonly ForecastPoint[];
  readonly owners: readonly OwnerScore[];
  readonly lossReasons: readonly LossReasonBucket[];
  readonly byMonth: readonly WinRateBucket[];
}
