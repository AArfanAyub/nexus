"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanOverdueInvoices = scanOverdueInvoices;
exports.scanLowStock = scanLowStock;
exports.scanBackupReminder = scanBackupReminder;
exports.runOnce = runOnce;
exports.startJobs = startJobs;
exports.stopJobs = stopJobs;
exports.jobsRunning = jobsRunning;
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
const node_crypto_1 = require("node:crypto");
const dates_1 = require("../shared/dates");
const connection_1 = require("./db/connection");
const log_1 = require("./log");
const settings_1 = require("./services/settings");
const TICK_MS = 15 * 60 * 1000;
const BACKUP_REMINDER_DAYS = 7;
let timer = null;
let running = false;
/** Inserts a notification unless an unread one for the same link already exists. */
function notify(input) {
    const clash = (0, connection_1.conn)().one('SELECT id FROM notifications WHERE kind = ? AND link = ? AND read_at IS NULL LIMIT 1', [input.kind, input.link]);
    if (clash)
        return false;
    (0, connection_1.conn)().run(`INSERT INTO notifications (id, user_id, kind, title, body, link, severity, read_at, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?)`, [(0, node_crypto_1.randomUUID)(), input.kind, input.title, input.body, input.link, input.severity, (0, dates_1.nowIso)()]);
    return true;
}
/** Posted invoices with money still owed and a due date in the past. */
function scanOverdueInvoices() {
    const rows = (0, connection_1.conn)().all(`SELECT id, number, total_cents, paid_cents, due_date
       FROM invoices
      WHERE status IN ('posted','partially_paid')
        AND total_cents > paid_cents
        AND due_date < ?
      ORDER BY due_date ASC
      LIMIT 50`, [(0, dates_1.todayIso)()]);
    let created = 0;
    for (const row of rows) {
        const outstanding = Number(row.total_cents) - Number(row.paid_cents);
        const overdueDays = (0, dates_1.daysBetween)(row.due_date, (0, dates_1.todayIso)());
        if (notify({
            kind: 'overdue_invoice',
            title: `Invoice ${row.number ?? '(draft)'} is ${String(overdueDays)} days overdue`,
            body: `${String((outstanding / 100).toFixed(2))} is still outstanding. Record a payment or send a reminder.`,
            link: `/finance/invoices/${row.id}`,
            severity: 'danger',
        })) {
            created += 1;
        }
    }
    return { created, skipped: rows.length - created };
}
/** Products whose total on-hand quantity is at or below their reorder point. */
function scanLowStock() {
    const rows = (0, connection_1.conn)().all(`SELECT p.id, p.sku, p.name,
            COALESCE(SUM(q.qty_milli), 0) AS on_hand,
            p.reorder_point_milli AS reorder
       FROM products p
       LEFT JOIN stock_quants q ON q.product_id = p.id
      WHERE p.is_active = 1 AND p.is_stock_tracked = 1 AND p.deleted_at IS NULL
      GROUP BY p.id
     HAVING on_hand <= reorder
      ORDER BY (reorder - on_hand) DESC
      LIMIT 50`);
    let created = 0;
    for (const row of rows) {
        if (notify({
            kind: 'low_stock',
            title: `${row.name} is at or below its reorder point`,
            body: `On hand ${String(Number(row.on_hand) / 1000)} — reorder point ${String(Number(row.reorder) / 1000)}.`,
            link: '/inventory/products',
            severity: 'warning',
        })) {
            created += 1;
        }
    }
    return { created, skipped: rows.length - created };
}
/** Nags when the last backup is older than a week (or never happened). */
function scanBackupReminder() {
    const last = (0, settings_1.readSetting)('backup.last_at');
    if (last) {
        const age = (0, dates_1.daysBetween)(last.slice(0, 10), (0, dates_1.todayIso)());
        if (age < BACKUP_REMINDER_DAYS)
            return { created: 0, skipped: 1 };
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
function runOnce() {
    if (running)
        return { created: 0 };
    running = true;
    let created = 0;
    try {
        for (const [name, scan] of [
            ['overdue_invoice', scanOverdueInvoices],
            ['low_stock', scanLowStock],
            ['backup_reminder', scanBackupReminder],
        ]) {
            try {
                const result = scan();
                created += result.created;
                if (result.created > 0)
                    (0, log_1.logInfo)('jobs', `${name}: ${String(result.created)} notification(s)`);
            }
            catch (error) {
                (0, log_1.logError)('jobs', error, { scan: name });
            }
        }
        if (created > 0)
            (0, connection_1.conn)().markDirty();
    }
    finally {
        running = false;
    }
    return { created };
}
/** Starts the 15-minute loop and runs once immediately. Idempotent. */
function startJobs() {
    if (timer)
        return;
    runOnce();
    timer = setInterval(runOnce, TICK_MS);
    // Never hold the event loop open just for the scheduler.
    if (typeof timer.unref === 'function')
        timer.unref();
}
/** Stops the loop. Called on `before-quit`. */
function stopJobs() {
    if (!timer)
        return;
    clearInterval(timer);
    timer = null;
}
/** True when the scheduler is live — used by the boot smoke test. */
function jobsRunning() {
    return timer !== null;
}
//# sourceMappingURL=jobs.js.map