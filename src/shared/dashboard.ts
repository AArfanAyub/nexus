/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The dashboard contract (T10).
 *
 * One call, one shape. The dashboard is the first screen after sign-in and the
 * only screen that touches every module, so it is the one place where a
 * chatty API is visible as a slow first paint. `dashboard.summary` returns
 * everything at once, computed in SQL, and is cached under `dashboard:`.
 */

/** The four periods the header offers. `custom` carries explicit dates. */
export type DashboardPeriodKey = 'month' | 'quarter' | 'ytd' | 'custom';

export interface DashboardPeriod {
  readonly key: DashboardPeriodKey;
  readonly from: string;
  readonly to: string;
  /** The equal-length period immediately before `from`, used for every delta. */
  readonly priorFrom: string;
  readonly priorTo: string;
  readonly label: string;
}

export interface DashboardRequest {
  readonly period?: DashboardPeriodKey;
  readonly from?: string;
  readonly to?: string;
}

/**
 * A KPI is a number, its movement, and its shape.
 *
 * `unit` is explicit because two of the six are counts, not money: formatting a
 * stock-out count as `12.00` would be the kind of small wrongness that makes an
 * operator distrust the whole strip. `deltaPct` is `null` when the prior period
 * was zero — a 100 % rise from nothing is not a percentage, and printing
 * `+Infinity %` is worse than printing a dash.
 */
export interface Kpi {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly delta: number;
  readonly deltaPct: number | null;
  readonly unit: 'money' | 'count';
  /** 12 points, oldest first, in the KPI's own unit. */
  readonly sparkline: readonly number[];
  /** `true` for revenue, `false` for overdue: the renderer colours by this. */
  readonly higherIsBetter: boolean;
  readonly href: string;
}

export interface SeriesPoint {
  readonly month: string;
  readonly label: string;
  readonly revenueCents: number;
  readonly expenseCents: number;
  readonly profitCents: number;
}

export interface PipelineSlice {
  readonly stageId: string;
  readonly name: string;
  readonly color: string;
  readonly count: number;
  readonly valueCents: number;
  readonly weightedCents: number;
}

/** One row of a "needs attention" list. */
export interface AttentionItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly amountCents: number | null;
  readonly href: string;
  /** Whole days late, or days stalled. 0 when neither applies. */
  readonly days: number;
}

export type AttentionKind = 'overdueInvoices' | 'stalledDeals' | 'lowStock' | 'unpostedDrafts';

export interface AttentionGroup {
  readonly kind: AttentionKind;
  readonly label: string;
  readonly count: number;
  readonly items: readonly AttentionItem[];
}

export interface ActivityFeedItem {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
  readonly at: string;
  readonly actorName: string;
  readonly href: string | null;
}

export interface DashboardSummary {
  readonly period: DashboardPeriod;
  readonly kpis: readonly Kpi[];
  readonly series: readonly SeriesPoint[];
  readonly pipeline: readonly PipelineSlice[];
  readonly attention: readonly AttentionGroup[];
  readonly activity: readonly ActivityFeedItem[];
  /**
   * True when the company has no trading records at all — every list is empty
   * because nothing was entered, not because a filter hid it. The dashboard uses
   * this to offer demo data instead of six zeroes.
   */
  readonly isEmpty: boolean;
  /** Server-side compute time, so the perf budget is observable in the UI. */
  readonly ms: number;
}
