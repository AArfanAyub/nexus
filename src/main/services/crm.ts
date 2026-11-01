/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * CRM (T09): pipelines, the board, lead conversion, and analytics.
 *
 * ## What lives here and what does not
 *
 * Record CRUD for accounts, contacts, leads, deals and activities is **not** in
 * this file: it goes through the generic `entity` family, which already knows how
 * to validate columns against `PRAGMA table_info`, enforce permissions and write
 * an audit row. Duplicating that here would give the CRM five bespoke save paths
 * and five places for the rules to drift.
 *
 * What is here is the logic that is genuinely domain-specific:
 *
 *   - **the board** — one query per pipeline with the aggregates computed in SQL,
 *     because counting 500 deals in JavaScript to draw a column header is how a
 *     Kanban gets a reputation for being slow;
 *   - **moving a stage** — validating that the target belongs to the same
 *     pipeline, re-deriving probability from the stage, and leaving an activity
 *     behind so the timeline explains how the deal got where it is;
 *   - **converting a lead** — account + contact + deal + status, atomically;
 *   - **analytics** — win rate, cycle time, forecast, leaderboard, loss reasons.
 *
 * ## Derived, never stored
 *
 * A deal's probability is a property of its *stage*, not of the deal. Storing it
 * separately means a board where one card in a column shows 40 % and the column
 * header shows 35 %. `moveStage` copies the stage's probability onto the deal on
 * every move, and `saveStage` re-derives it for every deal already sitting there.
 */

import { randomUUID } from 'node:crypto';

import type {
  ActivityRow,
  ActivityType,
  CrmAnalytics,
  DealBoard,
  DealBoardFilter,
  DealCard,
  DealColumn,
  DealStageRow,
  FunnelStage,
  ForecastPoint,
  LeadConvertInput,
  LeadConvertPreview,
  LeadConvertResult,
  LossReasonBucket,
  OwnerScore,
  PipelineRow,
  StageColor,
  TimelineFilter,
  TimelineResult,
  WinRateBucket,
} from '../../shared/crm';
import type { LossReason } from '../../shared/types';
import { nowIso, todayIso } from '../../shared/dates';
import { atomically, conn } from '../db/connection';
import { conflict, notFound, validation } from '../errors';
import * as auditLog from './audit';
import { invalidateCache } from './cache';

export interface CrmScope {
  readonly actorId: string | null;
  readonly actorName: string;
}

/** The pipeline a board opens on when the caller did not name one. */
function defaultPipeline(): { id: string; name: string; is_default: number } {
  const row = conn().one<{ id: string; name: string; is_default: number }>(
    'SELECT id, name, is_default FROM pipelines ORDER BY is_default DESC, created_at ASC LIMIT 1',
  );
  if (!row) throw notFound('Pipeline');
  return row;
}

function stageRows(pipelineId: string): readonly DealStageRow[] {
  return conn()
    .all<{
      id: string;
      pipeline_id: string;
      name: string;
      sort_order: number;
      probability_bp: number;
      is_won: number;
      is_lost: number;
      color: string;
    }>(
      `SELECT id, pipeline_id, name, sort_order, probability_bp, is_won, is_lost, color
         FROM deal_stages WHERE pipeline_id = ? ORDER BY sort_order, name`,
      [pipelineId],
    )
    .map((row) => ({
      id: row.id,
      pipelineId: row.pipeline_id,
      name: row.name,
      sortOrder: Number(row.sort_order),
      probabilityBp: Number(row.probability_bp),
      isWon: Number(row.is_won) === 1,
      isLost: Number(row.is_lost) === 1,
      color: (row.color ?? 'accent') as StageColor,
    }));
}

export function listPipelines(): readonly PipelineRow[] {
  const rows = conn().all<{ id: string; name: string; is_default: number }>(
    'SELECT id, name, is_default FROM pipelines ORDER BY is_default DESC, name',
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    isDefault: Number(row.is_default) === 1,
    stages: stageRows(row.id),
  }));
}

export interface PipelineInput {
  readonly id?: string;
  readonly name: string;
  readonly isDefault?: boolean;
}

export function savePipeline(input: PipelineInput): PipelineRow {
  const name = input.name.trim();
  if (name.length === 0) throw validation('name', 'Give the pipeline a name.');
  const at = nowIso();
  const id = input.id ?? randomUUID();
  atomically(() => {
    if (input.id) {
      const existing = conn().one<{ id: string }>('SELECT id FROM pipelines WHERE id = ?', [id]);
      if (!existing) throw notFound('Pipeline');
      conn().run('UPDATE pipelines SET name = ?, updated_at = ? WHERE id = ?', [name, at, id]);
    } else {
      conn().run('INSERT INTO pipelines (id, name, is_default, created_at, updated_at) VALUES (?, ?, 0, ?, ?)', [
        id,
        name,
        at,
        at,
      ]);
    }
    if (input.isDefault === true) {
      conn().run('UPDATE pipelines SET is_default = 0');
      conn().run('UPDATE pipelines SET is_default = 1 WHERE id = ?', [id]);
    }
  });
  invalidateCache('crm:');
  const pipeline = listPipelines().find((entry) => entry.id === id);
  if (!pipeline) throw notFound('Pipeline');
  return pipeline;
}

export interface StageInput {
  readonly id?: string;
  readonly pipelineId: string;
  readonly name: string;
  readonly sortOrder?: number;
  readonly probabilityBp: number;
  readonly isWon?: boolean;
  readonly isLost?: boolean;
  readonly color?: StageColor;
}

/**
 * Creates or edits a stage and re-derives the probability of every deal in it.
 *
 * That second half is the point: a stage's probability is a statement about the
 * whole column, so changing it and leaving the cards behind produces a forecast
 * that disagrees with its own header.
 */
export function saveStage(input: StageInput): DealStageRow {
  const name = input.name.trim();
  if (name.length === 0) throw validation('name', 'Give the stage a name.');
  if (input.probabilityBp < 0 || input.probabilityBp > 10_000) {
    throw validation('probabilityBp', 'Probability must be between 0 % and 100 %.');
  }
  const pipeline = conn().one<{ id: string }>('SELECT id FROM pipelines WHERE id = ?', [input.pipelineId]);
  if (!pipeline) throw notFound('Pipeline');

  const id = input.id ?? randomUUID();
  const order =
    input.sortOrder ??
    Number(
      conn().one<{ next: number }>(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM deal_stages WHERE pipeline_id = ?',
        [input.pipelineId],
      )?.next ?? 0,
    );
  const color = input.color ?? 'accent';

  atomically(() => {
    if (input.id) {
      const existing = conn().one<{ id: string }>('SELECT id FROM deal_stages WHERE id = ?', [id]);
      if (!existing) throw notFound('Stage');
      conn().run(
        'UPDATE deal_stages SET name = ?, sort_order = ?, probability_bp = ?, is_won = ?, is_lost = ?, color = ? WHERE id = ?',
        [
          name,
          order,
          input.probabilityBp,
          input.isWon === true ? 1 : 0,
          input.isLost === true ? 1 : 0,
          color,
          id,
        ],
      );
    } else {
      conn().run(
        `INSERT INTO deal_stages (id, pipeline_id, name, sort_order, probability_bp, is_won, is_lost, color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.pipelineId, name, order, input.probabilityBp, input.isWon === true ? 1 : 0, input.isLost === true ? 1 : 0, color],
      );
    }
    // Every open deal in the stage now carries the stage's probability.
    conn().run(
      "UPDATE deals SET probability_bp = ?, updated_at = ? WHERE stage_id = ? AND status = 'open'",
      [input.probabilityBp, nowIso(), id],
    );
  });
  invalidateCache('crm:');
  const stage = stageRows(input.pipelineId).find((entry) => entry.id === id);
  if (!stage) throw notFound('Stage');
  return stage;
}

/** Rewrites `sort_order` to match the given id order. */
export function reorderStages(pipelineId: string, ids: readonly string[]): readonly DealStageRow[] {
  const known = new Set(stageRows(pipelineId).map((stage) => stage.id));
  for (const id of ids) if (!known.has(id)) throw validation('ids', 'That stage belongs to another pipeline.');
  atomically(() => {
    ids.forEach((id, index) => {
      conn().run('UPDATE deal_stages SET sort_order = ? WHERE id = ?', [index, id]);
    });
  });
  invalidateCache('crm:');
  return stageRows(pipelineId);
}

export function listLossReasons(): readonly LossReason[] {
  return conn()
    .all<{ id: string; label: string; is_active: number }>(
      'SELECT id, label, is_active FROM loss_reasons ORDER BY label',
    )
    .map((row) => ({ id: row.id, label: row.label, isActive: Number(row.is_active) === 1 }));
}

export interface LossReasonInput {
  readonly id?: string;
  readonly label: string;
  readonly isActive?: boolean;
}

export function saveLossReason(input: LossReasonInput): LossReason {
  const label = input.label.trim();
  if (label.length === 0) throw validation('label', 'Give the reason a label.');
  const id = input.id ?? randomUUID();
  if (input.id) {
    conn().run('UPDATE loss_reasons SET label = ?, is_active = ? WHERE id = ?', [
      label,
      input.isActive === false ? 0 : 1,
      id,
    ]);
  } else {
    conn().run('INSERT INTO loss_reasons (id, label, is_active) VALUES (?, ?, ?)', [
      id,
      label,
      input.isActive === false ? 0 : 1,
    ]);
  }
  const row = listLossReasons().find((entry) => entry.id === id);
  if (!row) throw notFound('Loss reason');
  return row;
}

// ── the board ───────────────────────────────────────────────────────────────

interface DealRow {
  readonly id: string;
  readonly name: string;
  readonly stage_id: string;
  readonly account_id: string | null;
  readonly account_name: string | null;
  readonly contact_name: string | null;
  readonly owner_id: string | null;
  readonly owner_name: string | null;
  readonly value_cents: number;
  readonly currency: string;
  readonly probability_bp: number;
  readonly expected_close_date: string | null;
  readonly stage_changed_at: string;
  readonly days_in_stage: number;
  readonly days_overdue: number;
}

function toCard(row: DealRow): DealCard {
  return {
    id: row.id,
    name: row.name,
    stageId: row.stage_id,
    accountId: row.account_id,
    accountName: row.account_name,
    contactName: row.contact_name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    valueCents: Number(row.value_cents),
    currency: row.currency,
    probabilityBp: Number(row.probability_bp),
    expectedCloseDate: row.expected_close_date,
    daysInStage: Number(row.days_in_stage ?? 0),
    daysOverdue: Number(row.days_overdue ?? 0),
    stageChangedAt: row.stage_changed_at,
  };
}

/**
 * One query for the whole board.
 *
 * The aggregates come from `GROUP BY stage_id` in the same round trip as the
 * cards, so a column header and the cards under it can never disagree — and the
 * per-column card list is capped in SQL, not by slicing an array afterwards.
 */
export function board(filter: DealBoardFilter = {}): DealBoard {
  const pipelineRow = filter.pipelineId
    ? (conn().one<{ id: string; name: string; is_default: number }>(
        'SELECT id, name, is_default FROM pipelines WHERE id = ?',
        [filter.pipelineId],
      ) ?? defaultPipeline())
    : defaultPipeline();
  const stages = stageRows(pipelineRow.id);
  if (stages.length === 0) throw conflict('That pipeline has no stages yet.');

  const perColumn = Math.min(Math.max(filter.perColumn ?? 50, 1), 200);
  const where: string[] = ["d.pipeline_id = ?", "d.status = 'open'", 'd.deleted_at IS NULL'];
  const params: (string | number)[] = [pipelineRow.id];
  if (filter.ownerId) {
    where.push('d.owner_id = ?');
    params.push(filter.ownerId);
  }
  if (filter.stageId) {
    where.push('d.stage_id = ?');
    params.push(filter.stageId);
  }
  if (filter.closeFrom) {
    where.push('d.expected_close_date >= ?');
    params.push(filter.closeFrom);
  }
  if (filter.closeTo) {
    where.push('d.expected_close_date <= ?');
    params.push(filter.closeTo);
  }
  if (filter.q && filter.q.trim().length > 0) {
    where.push('(d.name LIKE ? OR a.name LIKE ?)');
    const like = `%${filter.q.trim()}%`;
    params.push(like, like);
  }
  const clause = where.join(' AND ');
  const today = todayIso();

  const cards = conn().all<DealRow>(
    `SELECT d.id, d.name, d.stage_id, d.account_id, a.name AS account_name,
            TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS contact_name,
            d.owner_id, u.full_name AS owner_name, d.value_cents, d.currency,
            d.probability_bp, d.expected_close_date, d.stage_changed_at,
            CAST(julianday(?) - julianday(d.stage_changed_at) AS INTEGER) AS days_in_stage,
            CASE WHEN d.expected_close_date IS NOT NULL AND d.expected_close_date < ?
                 THEN CAST(julianday(?) - julianday(d.expected_close_date) AS INTEGER) ELSE 0 END AS days_overdue
       FROM deals d
       LEFT JOIN crm_accounts a ON a.id = d.account_id
       LEFT JOIN contacts c ON c.id = d.primary_contact_id
       LEFT JOIN users u ON u.id = d.owner_id
      WHERE ${clause}
      ORDER BY d.value_cents DESC, d.name`,
    [today, today, today, ...params],
  );

  const grouped = new Map<string, DealCard[]>();
  for (const card of cards) {
    const bucket = grouped.get(card.stage_id) ?? [];
    bucket.push(toCard(card));
    grouped.set(card.stage_id, bucket);
  }

  const aggregates = new Map<string, { count: number; value: number; weighted: number }>();
  for (const [stageId, list] of grouped) {
    let value = 0;
    let weighted = 0;
    for (const card of list) {
      value += card.valueCents;
      weighted += Math.round((card.valueCents * card.probabilityBp) / 10_000);
    }
    aggregates.set(stageId, { count: list.length, value, weighted });
  }

  const columns: DealColumn[] = stages.map((stage) => {
    const list = grouped.get(stage.id) ?? [];
    const aggregate = aggregates.get(stage.id) ?? { count: 0, value: 0, weighted: 0 };
    return {
      stage,
      count: aggregate.count,
      valueCents: aggregate.value,
      weightedCents: aggregate.weighted,
      deals: list.slice(0, perColumn),
    };
  });

  const totals = columns.reduce(
    (acc, column) => ({
      count: acc.count + column.count,
      valueCents: acc.valueCents + column.valueCents,
      weightedCents: acc.weightedCents + column.weightedCents,
    }),
    { count: 0, valueCents: 0, weightedCents: 0 },
  );

  const closed = conn().one<{ won: number | null; lost: number | null; total: number | null }>(
    `SELECT SUM(CASE WHEN status = 'won' THEN value_cents ELSE 0 END) AS won,
            SUM(CASE WHEN status = 'lost' THEN value_cents ELSE 0 END) AS lost,
            COUNT(*) AS total
       FROM deals WHERE pipeline_id = ? AND status <> 'open' AND deleted_at IS NULL`,
    [pipelineRow.id],
  );

  return {
    pipeline: {
      id: pipelineRow.id,
      name: pipelineRow.name,
      isDefault: Number(pipelineRow.is_default) === 1,
      stages,
    },
    columns,
    totals,
    closed: {
      wonCents: Number(closed?.won ?? 0),
      lostCents: Number(closed?.lost ?? 0),
      count: Number(closed?.total ?? 0),
    },
  };
}

interface DealDbRow {
  readonly id: string;
  readonly name: string;
  readonly pipeline_id: string;
  readonly stage_id: string;
  readonly status: string;
  readonly value_cents: number;
  readonly probability_bp: number;
}

function dealOrThrow(id: string): DealDbRow {
  const row = conn().one<DealDbRow>(
    'SELECT id, name, pipeline_id, stage_id, status, value_cents, probability_bp FROM deals WHERE id = ? AND deleted_at IS NULL',
    [id],
  );
  if (!row) throw notFound('Deal');
  return row;
}

/** One activity row. The timeline and every close path go through it. */
function writeActivity(input: {
  readonly type: ActivityType;
  readonly subject: string;
  readonly body?: string | null;
  readonly entity: string;
  readonly entityId: string;
  readonly ownerId?: string | null;
  readonly scope: CrmScope;
}): string {
  const id = randomUUID();
  const at = nowIso();
  conn().run(
    `INSERT INTO activities (id, type, subject, body, entity, entity_id, owner_id, due_at,
       completed_at, is_done, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
    [
      id,
      input.type,
      input.subject,
      input.body ?? null,
      input.entity,
      input.entityId,
      input.ownerId ?? input.scope.actorId,
      at,
      input.scope.actorId ?? 'system',
      at,
    ],
  );
  return id;
}

/**
 * Moves a deal to another stage in the same pipeline.
 *
 * Refuses a stage from a different pipeline, refuses a *lost* stage (a loss needs
 * a reason, and that is `closeLost`'s job), and accepts a *won* stage because
 * dropping a card on Won is unambiguous. The activity is written in the same
 * transaction as the move, so the timeline cannot miss it.
 */
export function moveStage(input: { id: string; stageId: string; note?: string }, scope: CrmScope): DealCard {
  const deal = dealOrThrow(input.id);
  if (deal.status !== 'open') throw conflict(`That deal is already ${deal.status}.`);
  const stage = conn().one<{
    id: string;
    pipeline_id: string;
    name: string;
    probability_bp: number;
    is_won: number;
    is_lost: number;
  }>('SELECT id, pipeline_id, name, probability_bp, is_won, is_lost FROM deal_stages WHERE id = ?', [input.stageId]);
  if (!stage) throw notFound('Stage');
  if (stage.pipeline_id !== deal.pipeline_id) {
    throw validation('stageId', 'That stage belongs to a different pipeline.');
  }
  if (Number(stage.is_lost) === 1) {
    throw conflict('Dropping a deal on a lost stage needs a reason — close it as lost instead.');
  }
  if (stage.id === deal.stage_id) return dealCard(deal.id);

  const at = nowIso();
  atomically(() => {
    conn().run(
      `UPDATE deals SET stage_id = ?, probability_bp = ?, stage_changed_at = ?, updated_at = ?
        WHERE id = ?`,
      [stage.id, Number(stage.probability_bp), at, at, deal.id],
    );
    writeActivity({
      type: 'stage_changed',
      subject: `Moved to ${stage.name}`,
      body: input.note?.trim() || null,
      entity: 'deals',
      entityId: deal.id,
      ownerId: null,
      scope,
    });
    if (Number(stage.is_won) === 1) {
      conn().run("UPDATE deals SET status = 'won', won_at = ?, probability_bp = 10000 WHERE id = ?", [at, deal.id]);
    }
  });
  invalidateCache('crm:');
  invalidateCache('dashboard:');
  return dealCard(deal.id);
}

/** One card, for a deep link (`?focus=<id>`) that did not come from a board. */
export function dealCard(id: string): DealCard {
  const today = todayIso();
  const row = conn().one<DealRow>(
    `SELECT d.id, d.name, d.stage_id, d.account_id, a.name AS account_name,
            TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS contact_name,
            d.owner_id, u.full_name AS owner_name, d.value_cents, d.currency,
            d.probability_bp, d.expected_close_date, d.stage_changed_at,
            CAST(julianday(?) - julianday(d.stage_changed_at) AS INTEGER) AS days_in_stage,
            CASE WHEN d.expected_close_date IS NOT NULL AND d.expected_close_date < ?
                 THEN CAST(julianday(?) - julianday(d.expected_close_date) AS INTEGER) ELSE 0 END AS days_overdue
       FROM deals d
       LEFT JOIN crm_accounts a ON a.id = d.account_id
       LEFT JOIN contacts c ON c.id = d.primary_contact_id
       LEFT JOIN users u ON u.id = d.owner_id
      WHERE d.id = ?`,
    [today, today, today, id],
  );
  if (!row) throw notFound('Deal');
  return toCard(row);
}

/** The won/lost stage of a pipeline, when the pipeline defines one. */
function terminalStage(pipelineId: string, kind: 'won' | 'lost'): { id: string; name: string } | null {
  const column = kind === 'won' ? 'is_won' : 'is_lost';
  const row = conn().one<{ id: string; name: string }>(
    `SELECT id, name FROM deal_stages WHERE pipeline_id = ? AND ${column} = 1 ORDER BY sort_order LIMIT 1`,
    [pipelineId],
  );
  return row ?? null;
}

export function closeWon(input: { id: string; note?: string }, scope: CrmScope): DealCard {
  const deal = dealOrThrow(input.id);
  if (deal.status === 'won') throw conflict('That deal is already won.');
  if (deal.status === 'lost') throw conflict('That deal was lost. Reopen it before marking it won.');
  const at = nowIso();
  const stage = terminalStage(deal.pipeline_id, 'won');
  atomically(() => {
    conn().run(
      `UPDATE deals SET status = 'won', won_at = ?, probability_bp = 10000, lost_reason = NULL,
         stage_id = COALESCE(?, stage_id), stage_changed_at = ?, updated_at = ?
        WHERE id = ?`,
      [at, stage?.id ?? null, at, at, deal.id],
    );
    writeActivity({
      type: 'stage_changed',
      subject: stage ? `Won — moved to ${stage.name}` : 'Won',
      body: input.note?.trim() || null,
      entity: 'deals',
      entityId: deal.id,
      ownerId: null,
      scope,
    });
    auditLog.append({
      actorId: scope.actorId,
      actorName: scope.actorName,
      entity: 'deals',
      entityId: deal.id,
      action: 'close_won',
      before: { status: deal.status },
      after: { status: 'won', valueCents: Number(deal.value_cents) },
    });
  });
  invalidateCache('crm:');
  invalidateCache('dashboard:');
  return dealCard(deal.id);
}

/**
 * Closes a deal as lost. The reason is mandatory and stored twice on purpose:
 * on the deal (so the record explains itself) and on the activity (so the
 * timeline explains itself). Neither is redundant — one is read by reports, the
 * other by people.
 */
export function closeLost(input: { id: string; reason: string; note?: string }, scope: CrmScope): DealCard {
  const reason = (input.reason ?? '').trim();
  if (reason.length === 0) {
    throw validation('reason', 'A lost deal needs a reason — it is what the loss report counts.');
  }
  const deal = dealOrThrow(input.id);
  if (deal.status === 'lost') throw conflict('That deal is already lost.');
  const at = nowIso();
  const stage = terminalStage(deal.pipeline_id, 'lost');
  atomically(() => {
    conn().run(
      `UPDATE deals SET status = 'lost', lost_at = ?, lost_reason = ?, probability_bp = 0,
         stage_id = COALESCE(?, stage_id), stage_changed_at = ?, updated_at = ?
        WHERE id = ?`,
      [at, reason, stage?.id ?? null, at, at, deal.id],
    );
    writeActivity({
      type: 'stage_changed',
      subject: `Lost — ${reason}`,
      body: input.note?.trim() || null,
      entity: 'deals',
      entityId: deal.id,
      ownerId: null,
      scope,
    });
    auditLog.append({
      actorId: scope.actorId,
      actorName: scope.actorName,
      entity: 'deals',
      entityId: deal.id,
      action: 'close_lost',
      before: { status: deal.status },
      after: { status: 'lost', reason },
    });
  });
  invalidateCache('crm:');
  invalidateCache('dashboard:');
  return dealCard(deal.id);
}

// ── lead conversion ─────────────────────────────────────────────────────────

interface LeadDbRow {
  readonly id: string;
  readonly name: string;
  readonly company: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly source: string | null;
  readonly status: string;
  readonly estimated_value_cents: number;
  readonly owner_id: string | null;
  readonly notes: string | null;
}

function leadOrThrow(id: string): LeadDbRow {
  const row = conn().one<LeadDbRow>(
    'SELECT id, name, company, email, phone, source, status, estimated_value_cents, owner_id, notes FROM leads WHERE id = ?',
    [id],
  );
  if (!row) throw notFound('Lead');
  return row;
}

/** Splits "Ada Lovelace" into first/last without losing a single-word name. */
function splitName(full: string): { first: string; last: string | null } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return { first: 'Unknown', last: null };
  if (parts.length === 1) return { first: parts[0] ?? 'Unknown', last: null };
  return { first: parts[0] ?? 'Unknown', last: parts.slice(1).join(' ') };
}

/**
 * What the wizard's last step shows, computed by the same code that commits.
 *
 * Keeping preview and commit on one function is deliberate: a preview that
 * promises a different account name from the one that gets created is worse than
 * no preview at all.
 */
export function previewConversion(input: LeadConvertInput): LeadConvertPreview {
  const lead = leadOrThrow(input.leadId);
  const blocked: string[] = [];
  if (lead.status === 'converted') blocked.push('That lead has already been converted.');
  if (lead.status === 'lost') blocked.push('That lead was lost. Reopen it before converting.');
  if (input.account.name.trim().length === 0) blocked.push('The account needs a name.');

  const pipeline = conn().one<{ id: string }>('SELECT id FROM pipelines WHERE id = ?', [input.deal.pipelineId]);
  if (!pipeline) blocked.push('Pick a pipeline for the deal.');
  const stages = pipeline ? stageRows(input.deal.pipelineId) : [];
  const wanted = input.deal.stageId ? stages.find((stage) => stage.id === input.deal.stageId) : stages[0];
  if (stages.length === 0) blocked.push('That pipeline has no stages yet.');

  const name = splitName(input.contact.firstName.trim().length > 0 ? input.contact.firstName : lead.name);
  return {
    lead: {
      id: lead.id,
      name: lead.name,
      company: lead.company,
      status: lead.status,
      estimatedValueCents: Number(lead.estimated_value_cents),
    },
    willCreate: {
      account: { name: input.account.name.trim(), industry: input.account.industry ?? null },
      contact: {
        name: [name.first, name.last].filter(Boolean).join(' '),
        email: input.contact.email ?? lead.email,
      },
      deal: {
        name: input.deal.name.trim(),
        valueCents: input.deal.valueCents,
        stageName: wanted?.name ?? '—',
      },
    },
    blocked,
  };
}

/**
 * Creates the account, the contact and the deal, then marks the lead converted.
 *
 * All four writes are one transaction. The interesting failure is the deal: if
 * the pipeline was deleted between the wizard opening and the button being
 * pressed, the account and contact must not survive on their own — a half
 * converted lead is indistinguishable from a real account nobody owns.
 */
export function convertLead(input: LeadConvertInput, scope: CrmScope): LeadConvertResult {
  const lead = leadOrThrow(input.leadId);
  if (lead.status === 'converted') throw conflict('That lead has already been converted.');
  if (lead.status === 'lost') throw conflict('That lead was lost. Reopen it before converting.');
  const accountName = input.account.name.trim();
  if (accountName.length === 0) throw validation('account.name', 'Give the account a name.');
  const dealName = input.deal.name.trim();
  if (dealName.length === 0) throw validation('deal.name', 'Give the deal a name.');
  if (input.deal.valueCents < 0) throw validation('deal.valueCents', 'A deal cannot be worth less than zero.');

  const pipeline = conn().one<{ id: string }>('SELECT id FROM pipelines WHERE id = ?', [input.deal.pipelineId]);
  if (!pipeline) throw validation('deal.pipelineId', 'Pick a pipeline for the deal.');
  const stages = stageRows(input.deal.pipelineId);
  const stage = input.deal.stageId ? stages.find((entry) => entry.id === input.deal.stageId) : stages[0];
  if (!stage) throw validation('deal.stageId', 'That pipeline has no stages yet.');

  const split = splitName(input.contact.firstName.trim().length > 0 ? input.contact.firstName : lead.name);
  const at = nowIso();
  const accountId = randomUUID();
  const contactId = randomUUID();
  const dealId = randomUUID();
  const currency = input.deal.currency ?? 'USD';

  atomically(() => {
    conn().run(
      `INSERT INTO crm_accounts (id, name, industry, website, phone, email, address_json, owner_id,
         customer_id, source, annual_revenue_cents, employees, notes, custom_json, health,
         domain, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, '{}', 'green', ?, ?, ?)`,
      [
        accountId,
        accountName,
        input.account.industry?.trim() || null,
        input.account.phone?.trim() || lead.phone,
        lead.email,
        input.account.ownerId ?? lead.owner_id,
        input.account.customerId ?? null,
        lead.source,
        input.account.domain?.trim() || null,
        at,
        at,
      ],
    );
    conn().run(
      `INSERT INTO contacts (id, account_id, first_name, last_name, title, email, phone, mobile,
         is_primary, notes, custom_json, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, '{}', ?, ?, ?)`,
      [
        contactId,
        accountId,
        split.first,
        split.last,
        input.contact.title?.trim() || null,
        input.contact.email?.trim() || lead.email,
        input.contact.phone?.trim() || lead.phone,
        input.contact.isPrimary === false ? 0 : 1,
        input.account.ownerId ?? lead.owner_id,
        at,
        at,
      ],
    );
    conn().run(
      `INSERT INTO deals (id, name, account_id, pipeline_id, stage_id, owner_id, value_cents, currency,
         probability_bp, expected_close_date, status, lost_reason, won_at, lost_at, lead_id,
         sales_order_id, stage_changed_at, custom_json, primary_contact_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL, ?, NULL, ?, '{}', ?, ?, ?)`,
      [
        dealId,
        dealName,
        accountId,
        input.deal.pipelineId,
        stage.id,
        input.deal.ownerId ?? lead.owner_id,
        input.deal.valueCents,
        currency,
        stage.probabilityBp,
        input.deal.expectedCloseDate ?? null,
        lead.id,
        at,
        contactId,
        at,
        at,
      ],
    );
    conn().run(
      `UPDATE leads SET status = 'converted', converted_account_id = ?, converted_contact_id = ?,
         converted_deal_id = ?, converted_at = ?, updated_at = ? WHERE id = ?`,
      [accountId, contactId, dealId, at, at, lead.id],
    );
    writeActivity({
      type: 'system',
      subject: `Converted from lead ${lead.name}`,
      body: `Created account, contact and deal ${dealName}.`,
      entity: 'deals',
      entityId: dealId,
      ownerId: input.deal.ownerId ?? lead.owner_id,
      scope,
    });
    auditLog.append({
      actorId: scope.actorId,
      actorName: scope.actorName,
      entity: 'leads',
      entityId: lead.id,
      action: 'convert',
      before: { status: lead.status },
      after: { status: 'converted', accountId, contactId, dealId },
    });
  });

  invalidateCache('crm:');
  invalidateCache('dashboard:');
  return { accountId, contactId, dealId, leadId: lead.id };
}

// ── timeline ────────────────────────────────────────────────────────────────

export function timeline(filter: TimelineFilter = {}): TimelineResult {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.entity) {
    where.push('a.entity = ?');
    params.push(filter.entity);
  }
  if (filter.entityId) {
    where.push('a.entity_id = ?');
    params.push(filter.entityId);
  }
  if (filter.openOnly === true) {
    where.push('a.is_done = 0');
  }
  if (filter.ownerId) {
    where.push('a.owner_id = ?');
    params.push(filter.ownerId);
  }
  if (filter.from) {
    where.push('COALESCE(a.due_at, a.created_at) >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('COALESCE(a.due_at, a.created_at) <= ?');
    params.push(filter.to);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  const rows = conn().all<{
    id: string;
    type: ActivityType;
    subject: string;
    body: string | null;
    entity: string;
    entity_id: string;
    owner_id: string | null;
    owner_name: string | null;
    due_at: string | null;
    completed_at: string | null;
    is_done: number;
    created_by: string;
    created_at: string;
  }>(
    `SELECT a.id, a.type, a.subject, a.body, a.entity, a.entity_id, a.owner_id,
            u.full_name AS owner_name, a.due_at, a.completed_at, a.is_done, a.created_by, a.created_at
       FROM activities a LEFT JOIN users u ON u.id = a.owner_id
       ${clause}
      ORDER BY a.is_done ASC, COALESCE(a.due_at, a.created_at) DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const totalRow = conn().one<{ total: number }>(`SELECT COUNT(*) AS total FROM activities a ${clause}`, params);

  return {
    rows: rows.map(
      (row): ActivityRow => ({
        id: row.id,
        type: row.type,
        subject: row.subject,
        body: row.body,
        entity: row.entity,
        entityId: row.entity_id,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        dueAt: row.due_at,
        completedAt: row.completed_at,
        isDone: Number(row.is_done) === 1,
        createdBy: row.created_by,
        createdAt: row.created_at,
      }),
    ),
    total: Number(totalRow?.total ?? 0),
  };
}

export interface ActivityInput {
  readonly id?: string;
  readonly type: ActivityType;
  readonly subject: string;
  readonly body?: string | null;
  readonly entity: string;
  readonly entityId: string;
  readonly ownerId?: string | null;
  readonly dueAt?: string | null;
}

export function saveActivity(input: ActivityInput, scope: CrmScope): ActivityRow {
  const subject = input.subject.trim();
  if (subject.length === 0) throw validation('subject', 'Give the activity a subject.');
  const at = nowIso();
  const id = input.id ?? randomUUID();
  if (input.id) {
    const existing = conn().one<{ id: string }>('SELECT id FROM activities WHERE id = ?', [id]);
    if (!existing) throw notFound('Activity');
    conn().run(
      'UPDATE activities SET type = ?, subject = ?, body = ?, owner_id = ?, due_at = ? WHERE id = ?',
      [input.type, subject, input.body?.trim() || null, input.ownerId ?? scope.actorId, input.dueAt ?? null, id],
    );
  } else {
    conn().run(
      `INSERT INTO activities (id, type, subject, body, entity, entity_id, owner_id, due_at,
         completed_at, is_done, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
      [
        id,
        input.type,
        subject,
        input.body?.trim() || null,
        input.entity,
        input.entityId,
        input.ownerId ?? scope.actorId,
        input.dueAt ?? null,
        scope.actorId ?? 'system',
        at,
      ],
    );
  }
  const row = timeline({ entity: input.entity, entityId: input.entityId, limit: 200 }).rows.find(
    (entry) => entry.id === id,
  );
  if (!row) throw notFound('Activity');
  return row;
}

/** Ticks or un-ticks an activity. Completing stamps the time; un-ticking clears it. */
export function completeActivity(id: string, done: boolean): ActivityRow {
  const existing = conn().one<{ id: string; entity: string; entity_id: string }>(
    'SELECT id, entity, entity_id FROM activities WHERE id = ?',
    [id],
  );
  if (!existing) throw notFound('Activity');
  conn().run('UPDATE activities SET is_done = ?, completed_at = ? WHERE id = ?', [
    done ? 1 : 0,
    done ? nowIso() : null,
    id,
  ]);
  invalidateCache('dashboard:');
  const row = timeline({ entity: existing.entity, entityId: existing.entity_id, limit: 200 }).rows.find(
    (entry) => entry.id === id,
  );
  if (!row) throw notFound('Activity');
  return row;
}

// ── analytics ───────────────────────────────────────────────────────────────

/**
 * The exclusive upper bound of a period: the day after `to`, as a bare date.
 *
 * `won_at` and `lost_at` are ISO timestamps (`2026-10-31T11:57:00.123Z`), and
 * the string comparison SQLite performs here is only sound if both sides are
 * formatted the same way. `'2026-10-31 23:59:59'` is *not*: at index 10 the
 * separator is a space, which sorts below the `T`, so every deal closed on the
 * last day of the period fell outside it and the win report silently lost them.
 * An exclusive bound of `2026-11-01` compares correctly against any timestamp
 * that begins with a date, whatever its time zone suffix.
 */
function periodEnd(to: string): string {
  const date = new Date(`${to.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return to;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function monthsBetween(from: string, to: string): readonly string[] {
  const out: string[] = [];
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return out;
  const cursor = new Date(start);
  let guard = 0;
  while (cursor <= end && guard < 120) {
    out.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    guard += 1;
  }
  return out;
}

/**
 * Everything the Analytics screen shows, in six queries.
 *
 * Deliberately not one giant query: each block answers a different question and
 * a single statement that computed all of them would be unreadable and would
 * re-scan `deals` for every column. Six indexed scans over a bounded period is
 * cheaper and far easier to defend.
 */
export function analytics(period: { from: string; to: string }, pipelineId?: string): CrmAnalytics {
  const database = conn();
  const { from, to } = period;
  const pipelineClause = pipelineId ? 'AND d.pipeline_id = ?' : '';
  const pipelineParams: (string | number)[] = pipelineId ? [pipelineId] : [];

  // Closed inside the period, by outcome.
  const closed = database.one<{ won: number; wonCount: number; lost: number; lostCount: number; avgDeal: number | null }>(
    `SELECT COALESCE(SUM(CASE WHEN d.status = 'won' THEN d.value_cents ELSE 0 END), 0) AS won,
            COALESCE(SUM(CASE WHEN d.status = 'won' THEN 1 ELSE 0 END), 0) AS wonCount,
            COALESCE(SUM(CASE WHEN d.status = 'lost' THEN d.value_cents ELSE 0 END), 0) AS lost,
            COALESCE(SUM(CASE WHEN d.status = 'lost' THEN 1 ELSE 0 END), 0) AS lostCount,
            AVG(CASE WHEN d.status = 'won' THEN d.value_cents END) AS avgDeal
       FROM deals d
      WHERE d.deleted_at IS NULL
        AND ((d.won_at IS NOT NULL AND d.won_at >= ? AND d.won_at < ?)
          OR (d.lost_at IS NOT NULL AND d.lost_at >= ? AND d.lost_at < ?))
        ${pipelineClause}`,
    [from, periodEnd(to), from, periodEnd(to), ...pipelineParams],
  );

  const open = database.one<{ value: number; weighted: number; count: number }>(
    `SELECT COALESCE(SUM(d.value_cents), 0) AS value,
            COALESCE(SUM(CAST(d.value_cents * d.probability_bp / 10000 AS INTEGER)), 0) AS weighted,
            COUNT(*) AS count
       FROM deals d WHERE d.status = 'open' AND d.deleted_at IS NULL ${pipelineClause}`,
    pipelineParams,
  );

  const cycle = database.one<{ days: number | null }>(
    `SELECT AVG(julianday(d.won_at) - julianday(d.created_at)) AS days
       FROM deals d
      WHERE d.status = 'won' AND d.won_at IS NOT NULL AND d.won_at >= ? AND d.won_at < ?
        ${pipelineClause}`,
    [from, periodEnd(to), ...pipelineParams],
  );

  const wonCount = Number(closed?.wonCount ?? 0);
  const lostCount = Number(closed?.lostCount ?? 0);
  const decided = wonCount + lostCount;

  const funnelRows = database.all<{
    stage_id: string;
    name: string;
    color: string;
    count: number;
    value: number;
    weighted: number;
  }>(
    `SELECT s.id AS stage_id, s.name, s.color,
            COUNT(d.id) AS count,
            COALESCE(SUM(d.value_cents), 0) AS value,
            COALESCE(SUM(CAST(d.value_cents * d.probability_bp / 10000 AS INTEGER)), 0) AS weighted
       FROM deal_stages s
       LEFT JOIN deals d ON d.stage_id = s.id AND d.status = 'open' AND d.deleted_at IS NULL
      WHERE s.pipeline_id = COALESCE(?, (SELECT id FROM pipelines ORDER BY is_default DESC, created_at LIMIT 1))
      GROUP BY s.id, s.name, s.color, s.sort_order
      ORDER BY s.sort_order`,
    [pipelineId ?? null],
  );

  const funnel: FunnelStage[] = funnelRows.map((row) => ({
    stageId: row.stage_id,
    name: row.name,
    color: (row.color ?? 'accent') as StageColor,
    count: Number(row.count),
    valueCents: Number(row.value),
    weightedCents: Number(row.weighted),
  }));

  const ownerRows = database.all<{
    owner_id: string | null;
    owner_name: string | null;
    won: number;
    won_count: number;
    lost_count: number;
    open_value: number;
  }>(
    `SELECT d.owner_id, u.full_name AS owner_name,
            COALESCE(SUM(CASE WHEN d.status = 'won' AND d.won_at >= ? AND d.won_at < ? THEN d.value_cents ELSE 0 END), 0) AS won,
            COALESCE(SUM(CASE WHEN d.status = 'won' AND d.won_at >= ? AND d.won_at < ? THEN 1 ELSE 0 END), 0) AS won_count,
            COALESCE(SUM(CASE WHEN d.status = 'lost' AND d.lost_at >= ? AND d.lost_at < ? THEN 1 ELSE 0 END), 0) AS lost_count,
            COALESCE(SUM(CASE WHEN d.status = 'open' THEN d.value_cents ELSE 0 END), 0) AS open_value
       FROM deals d LEFT JOIN users u ON u.id = d.owner_id
      WHERE d.deleted_at IS NULL ${pipelineClause}
      GROUP BY d.owner_id, u.full_name
      ORDER BY won DESC`,
    [from, periodEnd(to), from, periodEnd(to), from, periodEnd(to), ...pipelineParams],
  );

  const owners: OwnerScore[] = ownerRows.map((row) => {
    const wins = Number(row.won_count);
    const losses = Number(row.lost_count);
    return {
      ownerId: row.owner_id,
      ownerName: row.owner_name ?? 'Unassigned',
      wonCents: Number(row.won),
      wonCount: wins,
      lostCount: losses,
      openCents: Number(row.open_value),
      winRateBp: wins + losses === 0 ? 0 : Math.round((wins / (wins + losses)) * 10_000),
    };
  });

  const lossRows = database.all<{ reason: string | null; count: number; value: number }>(
    `SELECT COALESCE(NULLIF(TRIM(d.lost_reason), ''), 'No reason recorded') AS reason,
            COUNT(*) AS count, COALESCE(SUM(d.value_cents), 0) AS value
       FROM deals d
      WHERE d.status = 'lost' AND d.lost_at >= ? AND d.lost_at < ? AND d.deleted_at IS NULL
        ${pipelineClause}
      GROUP BY reason ORDER BY count DESC`,
    [from, periodEnd(to), ...pipelineParams],
  );

  const lossReasons: LossReasonBucket[] = lossRows.map((row) => ({
    reason: row.reason ?? 'No reason recorded',
    count: Number(row.count),
    valueCents: Number(row.value),
  }));

  // Monthly forecast vs closed, over the period's months.
  const months = monthsBetween(from, to);
  const monthlyRows = database.all<{ month: string; won: number; lost: number; open: number }>(
    `SELECT substr(COALESCE(d.won_at, d.lost_at, d.expected_close_date, d.created_at), 1, 7) AS month,
            COALESCE(SUM(CASE WHEN d.status = 'won' THEN d.value_cents ELSE 0 END), 0) AS won,
            COALESCE(SUM(CASE WHEN d.status = 'lost' THEN d.value_cents ELSE 0 END), 0) AS lost,
            COALESCE(SUM(CASE WHEN d.status = 'open' THEN CAST(d.value_cents * d.probability_bp / 10000 AS INTEGER) ELSE 0 END), 0) AS open
       FROM deals d WHERE d.deleted_at IS NULL ${pipelineClause}
      GROUP BY month ORDER BY month`,
    pipelineParams,
  );
  const byMonthMap = new Map(monthlyRows.map((row) => [row.month, row]));
  const monthly: ForecastPoint[] = months.map((month) => {
    const row = byMonthMap.get(month);
    return {
      month,
      wonCents: Number(row?.won ?? 0),
      lostCents: Number(row?.lost ?? 0),
      openWeightedCents: Number(row?.open ?? 0),
    };
  });

  const byMonth: WinRateBucket[] = months.map((month) => {
    const row = byMonthMap.get(month);
    const won = Number(row?.won ?? 0);
    const lost = Number(row?.lost ?? 0);
    return {
      label: month,
      won: Math.round(won / 100),
      lost: Math.round(lost / 100),
      winRateBp: won + lost === 0 ? 0 : Math.round((won / (won + lost)) * 10_000),
    };
  });

  return {
    period: { from, to },
    kpis: {
      wonCents: Number(closed?.won ?? 0),
      lostCents: Number(closed?.lost ?? 0),
      openCents: Number(open?.value ?? 0),
      weightedCents: Number(open?.weighted ?? 0),
      winRateBp: decided === 0 ? 0 : Math.round((wonCount / decided) * 10_000),
      wonCount,
      lostCount,
      avgCycleDays: cycle?.days === null || cycle?.days === undefined ? null : Math.round(Number(cycle.days)),
      avgDealCents: Math.round(Number(closed?.avgDeal ?? 0)),
    },
    funnel,
    monthly,
    owners,
    lossReasons,
    byMonth,
  };
}

/** Month key helper exported for the renderer's own bucketing. */
export { monthKey };
