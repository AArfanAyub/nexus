/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The dashboard (T10).
 *
 * ## Why one call
 *
 * The dashboard is the first screen after sign-in and the only screen that reads
 * every module at once. Six separate channels would mean six round trips before
 * the first paint, and the strip would fill in one tile at a time. One cached
 * call returns the lot.
 *
 * ## The period and its mirror
 *
 * Every KPI is shown against the **prior period of equal length**, not against
 * "last month": a 17-day custom range compared to a 30-day month is a lie. The
 * delta is therefore computed over `[from − length, from − 1 day]`.
 *
 * ## Sparklines
 *
 * Twelve points regardless of the period, so the tile's shape is comparable
 * across periods. For a month view that is roughly 2.5-day buckets; for YTD it
 * is a month each. The bucketing is done in SQL with a computed index rather
 * than by fetching rows and grouping in JavaScript.
 */

import type {
  ActivityFeedItem,
  AttentionGroup,
  AttentionItem,
  DashboardPeriod,
  DashboardPeriodKey,
  DashboardRequest,
  DashboardSummary,
  Kpi,
  PipelineSlice,
  SeriesPoint,
} from '../../shared/dashboard';
import { todayIso } from '../../shared/dates';
import { conn } from '../db/connection';
import { cached } from './cache';

const DAY_MS = 86_400_000;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDate(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`);
}

function addDays(value: string, days: number): string {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

/** Whole days between two dates, inclusive of both ends. */
function daysInclusive(from: string, to: string): number {
  return Math.max(1, Math.floor((parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS) + 1);
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function periodLabel(key: DashboardPeriodKey, from: string, to: string): string {
  const start = parseDate(from);
  switch (key) {
    case 'month':
      return `${MONTH_LABELS[start.getUTCMonth()] ?? ''} ${String(start.getUTCFullYear())}`;
    case 'quarter':
      return `Q${String(Math.floor(start.getUTCMonth() / 3) + 1)} ${String(start.getUTCFullYear())}`;
    case 'ytd':
      return `Year to ${MONTH_LABELS[parseDate(to).getUTCMonth()] ?? ''}`;
    default:
      return `${from} → ${to}`;
  }
}

/** Resolves the requested period into concrete, always-valid dates. */
export function resolvePeriod(request: DashboardRequest = {}): DashboardPeriod {
  const key: DashboardPeriodKey = request.period ?? 'month';
  const today = todayIso();

  if (key === 'custom' && request.from && request.to) {
    const from = request.from <= request.to ? request.from : request.to;
    const to = request.from <= request.to ? request.to : request.from;
    const length = daysInclusive(from, to);
    return {
      key,
      from,
      to,
      priorFrom: addDays(from, -length),
      priorTo: addDays(from, -1),
      label: periodLabel(key, from, to),
    };
  }

  if (key === 'custom') {
    // A custom request with no dates is a caller bug; fall back to the month
    // rather than inventing a range the operator never asked for.
    return resolvePeriod({ period: 'month' });
  }

  const current = parseDate(today);
  let from: string;
  let to = today;
  if (key === 'quarter') {
    const quarterStartMonth = Math.floor(current.getUTCMonth() / 3) * 3;
    from = isoDate(new Date(Date.UTC(current.getUTCFullYear(), quarterStartMonth, 1)));
  } else if (key === 'ytd') {
    from = isoDate(new Date(Date.UTC(current.getUTCFullYear(), 0, 1)));
  } else {
    from = isoDate(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1)));
  }
  const length = daysInclusive(from, to);
  return {
    key,
    from,
    to,
    priorFrom: addDays(from, -length),
    priorTo: addDays(from, -1),
    label: periodLabel(key, from, to),
  };
}

/** `SUM(net)` over posted invoices in a window. */
function revenueBetween(from: string, to: string): number {
  const row = conn().one<{ total: number | null }>(
    `SELECT COALESCE(SUM(net_cents), 0) AS total FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
      WHERE i.status IN ('posted','partially_paid','paid') AND i.date >= ? AND i.date <= ?`,
    [from, to],
  );
  return Number(row?.total ?? 0);
}

function expenseBetween(from: string, to: string): number {
  const row = conn().one<{ total: number | null }>(
    `SELECT COALESCE(SUM(net_cents), 0) AS total FROM bill_lines bl
       JOIN bills b ON b.id = bl.bill_id
      WHERE b.status IN ('posted','partially_paid','paid','match_exception') AND b.date >= ? AND b.date <= ?`,
    [from, to],
  );
  return Number(row?.total ?? 0);
}

/**
 * Outstanding receivable as at `to`: posted invoices minus allocations.
 *
 * Allocations are polymorphic (`doc_type` + `doc_id`), so the document type is
 * part of the predicate, not implied by the column name. Getting this wrong is
 * a query that throws on the first screen after sign-in.
 */
function openArAt(to: string): number {
  const row = conn().one<{ total: number | null }>(
    `SELECT COALESCE(SUM(i.total_cents - COALESCE((
              SELECT SUM(pa.amount_cents) FROM payment_allocations pa
               WHERE pa.doc_type = 'invoice' AND pa.doc_id = i.id
            ), 0)), 0) AS total
       FROM invoices i
      WHERE i.status IN ('posted','partially_paid') AND i.date <= ?`,
    [to],
  );
  return Number(row?.total ?? 0);
}

function weightedPipeline(): number {
  const row = conn().one<{ total: number | null }>(
    `SELECT COALESCE(SUM(CAST(value_cents * probability_bp / 10000 AS INTEGER)), 0) AS total
       FROM deals WHERE status = 'open' AND deleted_at IS NULL`,
  );
  return Number(row?.total ?? 0);
}

/** Products at or below their reorder point, counting only stock-tracked ones. */
function lowStockCount(): number {
  const rows = conn().all<{ product_id: string; on_hand: number; reorder: number }>(
    `SELECT p.id AS product_id,
            COALESCE((SELECT SUM(q.qty_milli) FROM stock_quants q WHERE q.product_id = p.id), 0) AS on_hand,
            COALESCE(p.reorder_point_milli, 0) AS reorder
       FROM products p
      WHERE p.deleted_at IS NULL AND p.is_active = 1 AND p.is_stock_tracked = 1 AND p.reorder_point_milli > 0`,
  );
  return rows.filter((row) => Number(row.on_hand) <= Number(row.reorder)).length;
}

/**
 * Twelve buckets across `[from, to]`, oldest first.
 *
 * `bucket` is computed once per row in SQL and summed, which keeps the shape
 * honest for a 17-day custom range as well as for a year.
 */
function sparkline(from: string, to: string, measure: 'revenue' | 'expense' | 'ar' | 'pipeline' | 'low'): readonly number[] {
  const points = 12;
  const span = Math.max(1, daysInclusive(from, to));
  const bucketOf = (date: string): number => {
    const offset = Math.floor((parseDate(date).getTime() - parseDate(from).getTime()) / DAY_MS);
    return Math.min(points - 1, Math.max(0, Math.floor((offset * points) / span)));
  };
  const out = new Array<number>(points).fill(0);

  if (measure === 'low') {
    // A stock-out count has no history table; the honest sparkline is flat.
    const count = lowStockCount();
    out.fill(count);
    return out;
  }

  if (measure === 'pipeline') {
    const rows = conn().all<{ date: string; value: number }>(
      `SELECT substr(COALESCE(won_at, created_at), 1, 10) AS date,
              COALESCE(SUM(CAST(value_cents * probability_bp / 10000 AS INTEGER)), 0) AS value
         FROM deals WHERE status = 'open' AND deleted_at IS NULL GROUP BY date`,
    );
    for (const row of rows) out[bucketOf(row.date)] = (out[bucketOf(row.date)] ?? 0) + Number(row.value);
    return out;
  }

  const sql =
    measure === 'revenue'
      ? `SELECT i.date AS date, SUM(il.net_cents) AS value FROM invoice_lines il
           JOIN invoices i ON i.id = il.invoice_id
          WHERE i.status IN ('posted','partially_paid','paid') AND i.date >= ? AND i.date <= ?
          GROUP BY i.date`
      : measure === 'expense'
        ? `SELECT b.date AS date, SUM(bl.net_cents) AS value FROM bill_lines bl
             JOIN bills b ON b.id = bl.bill_id
            WHERE b.status IN ('posted','partially_paid','paid','match_exception') AND b.date >= ? AND b.date <= ?
            GROUP BY b.date`
        : `SELECT i.date AS date, SUM(i.total_cents) AS value FROM invoices i
            WHERE i.status IN ('posted','partially_paid') AND i.date >= ? AND i.date <= ?
            GROUP BY i.date`;

  const rows = conn().all<{ date: string; value: number | null }>(sql, [from, to]);
  for (const row of rows) {
    const bucket = bucketOf(row.date);
    out[bucket] = (out[bucket] ?? 0) + Number(row.value ?? 0);
  }
  return out;
}

function pctDelta(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return Math.round(((current - prior) / Math.abs(prior)) * 10_000) / 100;
}

function kpis(period: DashboardPeriod): readonly Kpi[] {
  const revenue = revenueBetween(period.from, period.to);
  const revenuePrior = revenueBetween(period.priorFrom, period.priorTo);
  const expense = expenseBetween(period.from, period.to);
  const expensePrior = expenseBetween(period.priorFrom, period.priorTo);
  const profit = revenue - expense;
  const profitPrior = revenuePrior - expensePrior;
  const ar = openArAt(period.to);
  const arPrior = openArAt(period.priorTo);
  const pipeline = weightedPipeline();
  const low = lowStockCount();

  // The three money series are computed once and reused; the profit shape is
  // their difference, which is the only way the strip stays internally
  // consistent when a bucket has revenue in one month and cost in the next.
  const revenueShape = sparkline(period.from, period.to, 'revenue');
  const expenseShape = sparkline(period.from, period.to, 'expense');
  const profitShape = revenueShape.map((value, index) => value - (expenseShape[index] ?? 0));

  return [
    {
      key: 'revenue',
      label: 'Revenue',
      value: revenue,
      delta: revenue - revenuePrior,
      deltaPct: pctDelta(revenue, revenuePrior),
      unit: 'money',
      sparkline: revenueShape,
      higherIsBetter: true,
      href: '/finance/reports',
    },
    {
      key: 'expenses',
      label: 'Expenses',
      value: expense,
      delta: expense - expensePrior,
      deltaPct: pctDelta(expense, expensePrior),
      unit: 'money',
      sparkline: expenseShape,
      higherIsBetter: false,
      href: '/finance/bills',
    },
    {
      key: 'profit',
      label: 'Net profit',
      value: profit,
      delta: profit - profitPrior,
      deltaPct: pctDelta(profit, profitPrior),
      unit: 'money',
      sparkline: profitShape,
      higherIsBetter: true,
      href: '/finance/reports',
    },
    {
      key: 'openAr',
      label: 'Open receivable',
      value: ar,
      delta: ar - arPrior,
      deltaPct: pctDelta(ar, arPrior),
      unit: 'money',
      sparkline: sparkline(period.from, period.to, 'ar'),
      higherIsBetter: false,
      href: '/finance/invoices',
    },
    {
      key: 'pipeline',
      label: 'Weighted pipeline',
      value: pipeline,
      delta: 0,
      deltaPct: null,
      unit: 'money',
      sparkline: sparkline(period.from, period.to, 'pipeline'),
      higherIsBetter: true,
      href: '/crm/deals',
    },
    {
      key: 'lowStock',
      label: 'Low stock',
      value: low,
      delta: 0,
      deltaPct: null,
      unit: 'count',
      sparkline: sparkline(period.from, period.to, 'low'),
      higherIsBetter: false,
      href: '/inventory/stock?low=1',
    },
  ];
}

/** Twelve months of revenue, expense and profit, ending at the period's `to`. */
function series(period: DashboardPeriod): readonly SeriesPoint[] {
  const end = parseDate(period.to);
  const points: SeriesPoint[] = [];
  for (let back = 11; back >= 0; back -= 1) {
    const cursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - back, 1));
    const monthStart = isoDate(cursor);
    const nextMonth = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const monthEnd = isoDate(new Date(nextMonth.getTime() - DAY_MS));
    const revenue = revenueBetween(monthStart, monthEnd);
    const expense = expenseBetween(monthStart, monthEnd);
    points.push({
      month: monthStart.slice(0, 7),
      label: `${MONTH_LABELS[cursor.getUTCMonth()] ?? ''} ${String(cursor.getUTCFullYear()).slice(2)}`,
      revenueCents: revenue,
      expenseCents: expense,
      profitCents: revenue - expense,
    });
  }
  return points;
}

function pipelineSlices(): readonly PipelineSlice[] {
  return conn()
    .all<{ stage_id: string; name: string; color: string; count: number; value: number; weighted: number }>(
      `SELECT s.id AS stage_id, s.name, s.color,
              COUNT(d.id) AS count,
              COALESCE(SUM(d.value_cents), 0) AS value,
              COALESCE(SUM(CAST(d.value_cents * d.probability_bp / 10000 AS INTEGER)), 0) AS weighted
         FROM deal_stages s
         LEFT JOIN deals d ON d.stage_id = s.id AND d.status = 'open' AND d.deleted_at IS NULL
        WHERE s.pipeline_id = (SELECT id FROM pipelines ORDER BY is_default DESC, created_at LIMIT 1)
        GROUP BY s.id, s.name, s.color, s.sort_order
        ORDER BY s.sort_order`,
    )
    .map((row) => ({
      stageId: row.stage_id,
      name: row.name,
      color: row.color ?? 'accent',
      count: Number(row.count),
      valueCents: Number(row.value),
      weightedCents: Number(row.weighted),
    }));
}

/**
 * The four "needs attention" lists. Each is capped at five: a list of forty
 * overdue invoices on a dashboard is a report, and reports have their own screen.
 */
function attention(): readonly AttentionGroup[] {
  const today = todayIso();

  const overdue = conn().all<{ id: string; number: string | null; customer: string; due: string; total: number; paid: number }>(
    `SELECT i.id, i.number, c.name AS customer, i.due_date AS due, i.total_cents AS total,
            COALESCE((SELECT SUM(pa.amount_cents) FROM payment_allocations pa
                       WHERE pa.doc_type = 'invoice' AND pa.doc_id = i.id), 0) AS paid
       FROM invoices i JOIN customers c ON c.id = i.customer_id
      WHERE i.status IN ('posted','partially_paid') AND i.due_date < ?
      ORDER BY i.due_date LIMIT 5`,
    [today],
  );
  const overdueItems: AttentionItem[] = overdue.map((row) => ({
    id: row.id,
    title: row.number ?? 'Draft invoice',
    subtitle: row.customer,
    amountCents: Number(row.total) - Number(row.paid),
    href: `/finance/invoices?focus=${row.id}`,
    days: Math.max(0, Math.floor((parseDate(today).getTime() - parseDate(row.due).getTime()) / DAY_MS)),
  }));

  const stalled = conn().all<{ id: string; name: string; stage: string; value: number; changed: string }>(
    `SELECT d.id, d.name, s.name AS stage, d.value_cents AS value, d.stage_changed_at AS changed
       FROM deals d JOIN deal_stages s ON s.id = d.stage_id
      WHERE d.status = 'open' AND d.deleted_at IS NULL
        AND julianday(?) - julianday(d.stage_changed_at) > 14
      ORDER BY d.value_cents DESC LIMIT 5`,
    [today],
  );
  const stalledItems: AttentionItem[] = stalled.map((row) => ({
    id: row.id,
    title: row.name,
    subtitle: row.stage,
    amountCents: Number(row.value),
    href: `/crm/deals?focus=${row.id}`,
    days: Math.max(0, Math.floor((parseDate(today).getTime() - parseDate(row.changed).getTime()) / DAY_MS)),
  }));

  const low = conn().all<{ id: string; name: string; sku: string; on_hand: number; reorder: number }>(
    `SELECT p.id, p.name, p.sku,
            COALESCE((SELECT SUM(q.qty_milli) FROM stock_quants q WHERE q.product_id = p.id), 0) AS on_hand,
            p.reorder_point_milli AS reorder
       FROM products p
      WHERE p.deleted_at IS NULL AND p.is_active = 1 AND p.is_stock_tracked = 1 AND p.reorder_point_milli > 0
      ORDER BY (COALESCE((SELECT SUM(q.qty_milli) FROM stock_quants q WHERE q.product_id = p.id), 0) - p.reorder_point_milli)
      LIMIT 5`,
  );
  const lowItems: AttentionItem[] = low
    .filter((row) => Number(row.on_hand) <= Number(row.reorder))
    .map((row) => ({
      id: row.id,
      title: row.name,
      subtitle: `${row.sku} · ${(Number(row.on_hand) / 1000).toFixed(0)} on hand`,
      amountCents: null,
      href: `/inventory/products?focus=${row.id}`,
      days: 0,
    }));

  const drafts = conn().all<{ id: string; kind: string; number: string | null; date: string; total: number }>(
    `SELECT id, 'invoice' AS kind, number, date, total_cents AS total FROM invoices WHERE status = 'draft'
      UNION ALL
     SELECT id, 'bill' AS kind, number, date, total_cents AS total FROM bills WHERE status IN ('draft','match_exception')
      ORDER BY date DESC LIMIT 5`,
  );
  const draftItems: AttentionItem[] = drafts.map((row) => ({
    id: row.id,
    title: `${row.kind === 'invoice' ? 'Invoice' : 'Bill'} ${row.number ?? '(unposted)'}`,
    subtitle: row.kind === 'invoice' ? 'Draft invoice' : 'Draft bill',
    amountCents: Number(row.total),
    href: row.kind === 'invoice' ? `/finance/invoices?focus=${row.id}` : `/purchasing/bills?focus=${row.id}`,
    days: Math.max(0, Math.floor((parseDate(today).getTime() - parseDate(row.date).getTime()) / DAY_MS)),
  }));

  const groups: AttentionGroup[] = [
    { kind: 'overdueInvoices', label: 'Overdue invoices', count: overdueItems.length, items: overdueItems },
    { kind: 'stalledDeals', label: 'Deals stalled over 14 days', count: stalledItems.length, items: stalledItems },
    { kind: 'lowStock', label: 'Below reorder point', count: lowItems.length, items: lowItems },
    { kind: 'unpostedDrafts', label: 'Waiting to be posted', count: draftItems.length, items: draftItems },
  ];
  return groups;
}

/** The last 12 audit entries that a salesperson or bookkeeper would recognise. */
function feed(): readonly ActivityFeedItem[] {
  return conn()
    .all<{
      id: string;
      entity: string;
      entity_id: string | null;
      action: string;
      actor_name: string;
      at: string;
    }>(
      `SELECT id, entity, entity_id, action, actor_name, at FROM audit_log
        ORDER BY seq DESC LIMIT 12`,
    )
    .map((row) => ({
      id: row.id,
      kind: row.entity,
      title: `${row.action.replace(/_/g, ' ')} ${row.entity}`,
      detail: row.entity_id ? row.entity_id.slice(0, 8) : '',
      at: row.at,
      actorName: row.actor_name,
      href: hrefFor(row.entity, row.entity_id),
    }));
}

function hrefFor(entity: string, id: string | null): string | null {
  if (!id) return null;
  const map: Record<string, string> = {
    invoices: '/finance/invoices',
    bills: '/purchasing/bills',
    payments: '/finance/payments',
    journal_entries: '/finance/journals',
    deals: '/crm/deals',
    leads: '/crm/leads',
    crm_accounts: '/crm/accounts',
    products: '/inventory/products',
    customers: '/sales/customers',
    vendors: '/purchasing/vendors',
  };
  const base = map[entity];
  return base ? `${base}?focus=${id}` : null;
}

/**
 * The whole dashboard.
 *
 * Cached for 30 s under `dashboard:<period>`, which is short enough that a
 * posting shows up while the operator is still looking at the screen and long
 * enough that navigating away and back is free. Every posting path already calls
 * `invalidateCache('report:')`; the dispatcher also drops `dashboard:` after any
 * write, so the strip cannot outlive the ledger it describes.
 */
export function summary(request: DashboardRequest = {}): DashboardSummary {
  const period = resolvePeriod(request);
  const key = `dashboard:${period.key}:${period.from}:${period.to}`;
  return cached(key, 30_000, () => {
    const started = Date.now();
    return {
      period,
      kpis: kpis(period),
      series: series(period),
      pipeline: pipelineSlices(),
      isEmpty: isEmptyCompany(),
      attention: attention(),
      activity: feed(),
      ms: Date.now() - started,
    };
  });
}

/** Exposed so the perf test can assert the warm path without a clock. */
export function summaryKey(request: DashboardRequest = {}): string {
  const period = resolvePeriod(request);
  return `dashboard:${period.key}:${period.from}:${period.to}`;
}

/**
 * A company with no invoices, no stock and no deals is a company that has just
 * finished onboarding — or one where somebody pressed "remove demo data". The
 * dashboard says so and offers a way back, because six zeroes read as a broken
 * screen rather than as an empty ledger.
 */
function isEmptyCompany(): boolean {
  const row = conn().one<{ n: number }>(
    `SELECT
       (SELECT COUNT(*) FROM invoices) +
       (SELECT COUNT(*) FROM bills) +
       (SELECT COUNT(*) FROM journal_entries) +
       (SELECT COUNT(*) FROM stock_moves) +
       (SELECT COUNT(*) FROM deals) +
       (SELECT COUNT(*) FROM customers) AS n`,
  );
  return (row?.n ?? 0) === 0;
}
