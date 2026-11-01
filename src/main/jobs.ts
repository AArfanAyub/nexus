/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the Proprietary Perpetual License. See LICENSE. */

/**
 * In-process scheduler (TASKS T04). Three scans, no network, no new threads:
 *
 *   - `overdue_invoice` — posted invoices past `due_date` with money outstanding
 *   - `low_stock`       — quant quantity at or below `products.reorder_point_milli`
 *   - `backup_reminder` — no `backup.run` recorded in the last seven days
 *
 * Every scan writes `notifications` rows and **deduplicates** on
 * `(kind, link)` while an unread row exists, so a 15-minute tick does not turn
 * the bell into a waterfall. A failure in one scan never blocks the others.
 */

import { randomUUID } from 'node:crypto';

import { daysBetween, nowIso, todayIso } from '../shared/dates';
import { conn } from './db/connection';
import { logError, logInfo } from './log';
import { readSetting } from './services/settings';

const TICK_MS = 15 * 60 * 1000;
const BACKUP_REMINDER_DAYS = 7;

let timer: NodeJS.Timeout | null = null;
let running = false;

export interface JobResult {
  readonly created: number;
  readonly skipped: number;
}

/** Inserts a notification unless an unread one for the same link already exists. */
function notify(input: {
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly link: string;
  readonly severity: 'info' | 'success' | 'warning' | 'danger';
}): boolean {
  const clash = conn().one<{ id: string }>(
    'SELECT id FROM notifications WHERE kind = ? AND link = ? AND read_at IS NULL LIMIT 1',
    [input.kind, input.link],
  );
  if (clash) return false;

  conn().run(
    `INSERT INTO notifications (id, user_id, kind, title, body, link, severity, read_at, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?)`,
    [randomUUID(), input.kind, input.title, input.body, input.link, input.severity, nowIso()],
  );
  return true;
}

/** Posted invoices with money still owed and a due date in the past. */
export function scanOverdueInvoices(): JobResult {
  const rows = conn().all<{
    id: string;
    number: string | null;
    total_cents: number;
    paid_cents: number;
    due_date: string;
  }>(
    `SELECT id, number, total_cents, paid_cents, due_date
       FROM invoices
      WHERE status IN ('posted','partially_paid')
        AND total_cents > paid_cents
        AND due_date < ?
      ORDER BY due_date ASC
      LIMIT 50`,
    [todayIso()],
  );

  let created = 0;
  for (const row of rows) {
    const outstanding = Number(row.total_cents) - Number(row.paid_cents);
    const overdueDays = daysBetween(row.due_date, todayIso());
    if (
      notify({
        kind: 'overdue_invoice',
        title: `Invoice ${row.number ?? '(draft)'} is ${String(overdueDays)} days overdue`,
        body: `${String((outstanding / 100).toFixed(2))} is still outstanding. Record a payment or send a reminder.`,
        link: `/finance/invoices/${row.id}`,
        severity: 'danger',
      })
    ) {
      created += 1;
    }
  }
  return { created, skipped: rows.length - created };
}

/** Products whose total on-hand quantity is at or below their reorder point. */
export function scanLowStock(): JobResult {
  const rows = conn().all<{ id: string; sku: string; name: string; on_hand: number; reorder: number }>(
    `SELECT p.id, p.sku, p.name,
            COALESCE(SUM(q.qty_milli), 0) AS on_hand,
            p.reorder_point_milli AS reorder
       FROM products p
       LEFT JOIN stock_quants q ON q.product_id = p.id
      WHERE p.is_active = 1 AND p.is_stock_tracked = 1 AND p.deleted_at IS NULL
      GROUP BY p.id
     HAVING on_hand <= reorder
      ORDER BY (reorder - on_hand) DESC
      LIMIT 50`,
  );

  let created = 0;
  for (const row of rows) {
    if (
      notify({
        kind: 'low_stock',
        title: `${row.name} is at or below its reorder point`,
        body: `On hand ${String(Number(row.on_hand) / 1000)} — reorder point ${String(Number(row.reorder) / 1000)}.`,
        link: '/inventory/products',
        severity: 'warning',
      })
    ) {
      created += 1;
    }
  }
  return { created, skipped: rows.length - created };
}

/** Nags when the last backup is older than a week (or never happened). */
export function scanBackupReminder(): JobResult {
  const last = readSetting<string>('backup.last_at');
  if (last) {
    const age = daysBetween(last.slice(0, 10), todayIso());
    if (age < BACKUP_REMINDER_DAYS) return { created: 0, skipped: 1 };
  }
  const created = notify({
    kind: 'backup_reminder',
    title: last ? 'Your last backup is over a week old' : 'You have not backed up yet',
    body: 'Open Settings → Data to write an encrypted copy of your database.',
    link: '/settings/backup',
    severity: 'info',
  })
    ? 1
    : 0;
  return { created, skipped: created === 1 ? 0 : 1 };
}

/** Runs all three scans. Never throws: one failing scan must not stop the rest. */
export function runOnce(): { readonly created: number } {
  if (running) return { created: 0 };
  running = true;
  let created = 0;
  try {
    for (const [name, scan] of [
      ['overdue_invoice', scanOverdueInvoices],
      ['low_stock', scanLowStock],
      ['backup_reminder', scanBackupReminder],
    ] as const) {
      try {
        const result = scan();
        created += result.created;
        if (result.created > 0) logInfo('jobs', `${name}: ${String(result.created)} notification(s)`);
      } catch (error) {
        logError('jobs', error, { scan: name });
      }
    }
    if (created > 0) conn().markDirty();
  } finally {
    running = false;
  }
  return { created };
}

/** Starts the 15-minute loop and runs once immediately. Idempotent. */
export function startJobs(): void {
  if (timer) return;
  runOnce();
  timer = setInterval(runOnce, TICK_MS);
  // Never hold the event loop open just for the scheduler.
  if (typeof timer.unref === 'function') timer.unref();
}

/** Stops the loop. Called on `before-quit`. */
export function stopJobs(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** True when the scheduler is live — used by the boot smoke test. */
export function jobsRunning(): boolean {
  return timer !== null;
}
