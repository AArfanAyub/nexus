/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * End-to-end administration driver (development only, never shipped).
 *
 * Walks the trust chain over the real bridge:
 *
 *   onboarding → sign in → import 200 customers (3 of them bad) → exactly 197
 *   committed → a second commit is refused → back up → change the database →
 *   restore → the change is gone and the backup is intact → the audit log
 *   filters, diffs and still verifies
 *
 * The step that matters is the import report: an import that silently drops a
 * bad row is worse than one that refuses the file, because nobody finds out
 * until a customer cannot be invoiced. 197 of 200 must be visible *before*
 * anything is written, and the number that gets written must be that number.
 *
 * Usage:
 *   npx electron . --remote-debugging-port=9225 --user-data-dir=/tmp/nexus-admin
 *   node scripts/e2e-admin.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PORT = Number(process.env.NEXUS_CDP_PORT ?? 9225);
const ENDPOINT = `http://127.0.0.1:${PORT}/json/list`;
const DEADLINE_MS = 90_000;

const ADMIN = { username: 'owner', password: 'Quiet-Harbor-92x' };

const ONBOARDING = {
  company: { name: 'Harbour Admin', legalName: 'Harbour Admin Ltd', taxId: '88-7654321' },
  presetId: 'wholesale_retail',
  currency: 'USD',
  fiscalStartMonth: 1,
  admin: { username: ADMIN.username, fullName: 'Ada Owner', email: 'owner@harbour.test', password: ADMIN.password },
  loadDemo: false,
};

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-e2e-admin-'));
const BACKUP_DIR = path.join(WORK_DIR, 'backups');
const CSV_PATH = path.join(WORK_DIR, 'customers.csv');

const IMPORT_ROWS = 200;
const IMPORT_BAD = 3;

const steps = [];

function note(step, detail) {
  steps.push({ step, detail });
  console.log(`  \u2713 ${step}${detail === undefined ? '' : ` \u2014 ${detail}`}`);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function findPage() {
  const started = Date.now();
  while (Date.now() - started < DEADLINE_MS) {
    try {
      const response = await fetch(ENDPOINT);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // The debugger port is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no renderer page appeared on port ${PORT} within ${DEADLINE_MS} ms`);
}

function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  return {
    async send(method, params = {}) {
      await opened;
      nextId += 1;
      const id = nextId;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`renderer threw: ${text}`);
  }
  return result.result.value;
}

/** Invokes a channel and throws on refusal, so every step asserts. */
async function invoke(client, channel, payload = {}) {
  const result = await evaluate(
    client,
    `window.nexus.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`,
  );
  if (!result || !result.ok) {
    throw new Error(`${channel} refused: ${JSON.stringify(result?.error ?? result)}`);
  }
  return result.data;
}

/** Invokes a channel that MUST be refused, and asserts the typed error code. */
async function refused(client, channel, payload, expectedCode) {
  const result = await evaluate(
    client,
    `window.nexus.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`,
  );
  if (!result || result.ok) throw new Error(`${channel} should have been refused, but succeeded`);
  const code = result.error?.code;
  check(
    code === expectedCode,
    `${channel} refused with ${String(code)} (expected ${expectedCode}): ${String(result.error?.message)}`,
  );
  return result.error;
}

/**
 * A file a real operator would upload: a correct header, 197 good rows, and the
 * three failures that actually happen — a missing key, a missing name, and the
 * same key twice.
 */
function writeImportFile() {
  const lines = ['Code,Name,Email,Payment terms (days),Credit limit'];
  for (let index = 0; index < IMPORT_ROWS - IMPORT_BAD; index += 1) {
    const number = String(index).padStart(3, '0');
    lines.push(`HAR-${number},Harbour Customer ${number},c${number}@harbour.test,30,"1,000.00"`);
  }
  lines.push(',Missing Code,no-code@harbour.test,30,0');
  lines.push('HAR-BAD,,no-name@harbour.test,30,0');
  lines.push('HAR-000,Duplicate Key,duplicate@harbour.test,30,0');
  fs.writeFileSync(CSV_PATH, lines.join('\n'), 'utf8');
  return { rows: IMPORT_ROWS, valid: IMPORT_ROWS - IMPORT_BAD };
}

async function main() {
  const page = await findPage();
  const client = connect(page.webSocketDebuggerUrl);

  try {
    // ── 0. a working company ────────────────────────────────────────────────
    const status = await invoke(client, 'onboarding.status');
    if (!status.complete) {
      await invoke(client, 'onboarding.complete', ONBOARDING);
      note('onboarding.complete', 'company, chart of accounts, 12 periods');
    } else {
      note('onboarding.status', 'already set up');
    }
    await invoke(client, 'auth.login', ADMIN);
    note('auth.login', ADMIN.username);

    const before = await invoke(client, 'entity.list', { entity: 'customers', limit: 1 });
    note('entity.list customers', `${String(before.total)} before the import`);

    // ── 1. the wizard's four stages, one call each ──────────────────────────
    const template = await invoke(client, 'data.import.template', { entity: 'customers' });
    check(template.csv.includes('Code'), 'the template must carry the headers');
    note('data.import.template', template.filename);

    const expected = writeImportFile();
    const parsed = await invoke(client, 'data.import.parse', { entity: 'customers', path: CSV_PATH });
    check(parsed.totalRows === expected.rows, `expected ${expected.rows} rows, parsed ${parsed.totalRows}`);
    check(parsed.batchId, 'parse must return a batch id');
    check(parsed.preview.length === 10, `expected a 10-row preview, got ${parsed.preview.length}`);

    const mapping = {};
    for (const column of parsed.columns) {
      if (column.field) mapping[column.header] = column.field;
    }
    check(mapping['Code'] === 'code', 'the guess must map Code to the code field');
    check(mapping['Name'] === 'name', 'the guess must map Name to the name field');
    const confident = parsed.columns.filter((column) => column.field !== null);
    note('data.import.parse', `${String(parsed.totalRows)} rows, ${String(confident.length)} columns guessed`);

    // ── 2. the report is the product: 197 of 200, before anything is written ─
    const report = await invoke(client, 'data.import.validate', { batchId: parsed.batchId, mapping });
    check(report.totalRows === expected.rows, `expected ${expected.rows} rows, saw ${report.totalRows}`);
    check(
      report.validRows === expected.valid,
      `expected ${expected.valid} valid rows, saw ${report.validRows}`,
    );
    check(report.duplicateRows === 1, `expected one duplicate, saw ${report.duplicateRows}`);
    check(report.invalidRows === IMPORT_BAD - 1, `expected two invalid rows, saw ${report.invalidRows}`);
    check(report.errors.length === IMPORT_BAD, `expected three reported errors, saw ${report.errors.length}`);
    check(report.byField.length > 0, 'the summary must say which fields went wrong');
    check(
      (await invoke(client, 'entity.list', { entity: 'customers', limit: 1 })).total === before.total,
      'validating must not write anything',
    );
    note('data.import.validate', `${String(report.validRows)} valid / ${String(report.errors.length)} rejected`);

    // ── 3. commit exactly the rows that were approved ───────────────────────
    const committed = await invoke(client, 'data.import.commit', { batchId: parsed.batchId });
    check(
      committed.inserted === expected.valid,
      `expected ${expected.valid} inserted, saw ${committed.inserted}`,
    );
    check(committed.failed === 0, `nothing should fail at insert time, saw ${committed.failed}`);
    check(committed.skipped === IMPORT_BAD, `expected ${IMPORT_BAD} skipped, saw ${committed.skipped}`);

    const after = await invoke(client, 'entity.list', { entity: 'customers', limit: 1 });
    check(
      after.total === before.total + expected.valid,
      `expected ${String(before.total + expected.valid)} customers, saw ${String(after.total)}`,
    );

    const sample = await invoke(client, 'entity.list', {
      entity: 'customers',
      q: 'HAR-042',
      limit: 1,
    });
    check(sample.rows.length === 1, 'a committed row must be findable by its code');
    check(sample.rows[0].credit_limit_cents === 100_000, 'a money column must arrive in cents, not as text');
    note('data.import.commit', `${String(committed.inserted)} inserted, ${String(after.total)} total`);

    // ── 4. a double-clicked Import must not import twice ────────────────────
    await refused(client, 'data.import.commit', { batchId: parsed.batchId }, 'CONFLICT');
    check(
      (await invoke(client, 'entity.list', { entity: 'customers', limit: 1 })).total === after.total,
      'a refused second commit must not add a single row',
    );
    note('data.import.commit (again)', 'refused, no duplicates');

    // ── 5. a backup that can prove itself ───────────────────────────────────
    const backup = await invoke(client, 'backup.run', { directory: BACKUP_DIR });
    check(fs.existsSync(backup.path), 'the backup file must exist on disk');
    check(backup.manifest.integrity === 'ok', `the copy must be readable, got ${backup.manifest.integrity}`);
    check(/^[0-9a-f]{64}$/.test(backup.manifest.sha256), 'the manifest must carry a sha256');
    check(backup.manifest.bytes === fs.statSync(backup.path).size, 'the recorded size must match the file');
    check(backup.manifest.counts.customers === after.total, 'the manifest must count what it holds');

    const verified = await invoke(client, 'backup.verify', { path: backup.path });
    check(verified.sha256 === backup.manifest.sha256, 'verify must agree with the manifest');
    const listed = await invoke(client, 'backup.list', { directory: BACKUP_DIR });
    check(listed.length >= 1, 'the backup must be listed');
    note('backup.run', `${String(backup.manifest.bytes)} bytes, integrity ${backup.manifest.integrity}`);

    // ── 6. change the database, then rewind it ──────────────────────────────
    const extra = await invoke(client, 'entity.save', {
      entity: 'customers',
      values: { code: 'HAR-AFTER', name: 'Added After The Backup', payment_terms_days: 30, is_active: 1 },
    });
    check(extra.id, 'the post-backup customer must be created');
    note('entity.save customers', 'one row added after the backup');

    const restored = await invoke(client, 'backup.restore', { path: backup.path });
    check(restored.requiresLogin === true, 'a restore must invalidate the session');
    check(restored.integrity === 'ok', 'the restored file must be readable');
    note('backup.restore', 'session dropped, as designed');

    // The session is gone by design, so sign in again before reading anything.
    await invoke(client, 'auth.login', ADMIN);

    const afterRestore = await invoke(client, 'entity.list', { entity: 'customers', limit: 1 });
    check(
      afterRestore.total === after.total,
      `the restore must return to ${String(after.total)} customers, saw ${String(afterRestore.total)}`,
    );
    const gone = await invoke(client, 'entity.list', { entity: 'customers', q: 'HAR-AFTER', limit: 1 });
    check(gone.total === 0, 'the row written after the backup must be gone');
    note('backup.restore', `${String(afterRestore.total)} customers, the extra row rewound`);

    // ── 7. the audit log explains what happened, and cannot be edited ───────
    const auditPage = await invoke(client, 'audit.list', { entity: 'import_batches', limit: 20 });
    check(auditPage.total >= 1, 'the import must be audited');
    check(
      auditPage.rows.every((row) => row.entity === 'import_batches'),
      'the entity filter must actually filter',
    );

    const restoredAudit = await invoke(client, 'audit.list', { action: 'backup_restore', limit: 5 });
    check(restoredAudit.total >= 1, 'the restore must be audited');
    const entry = restoredAudit.rows[0];
    check(entry.actorName.length > 0, 'every audit row must name who did it');

    const diff = await invoke(client, 'audit.diff', { seq: entry.seq });
    check(diff.seq === entry.seq, 'the diff must describe the entry that was asked for');
    check(
      diff.added.length + diff.changed.length + diff.removed.length > 0,
      'a restore diff with no fields would tell the operator nothing',
    );
    note('audit.list', `${String(auditPage.total)} import rows, ${String(diff.added.length)} fields on the restore`);

    const chain = await invoke(client, 'audit.verify');
    check(chain.ok === true, `the audit chain must verify, broke at ${String(chain.brokenAtSeq)}`);
    note('audit.verify', `${String(chain.checked)} entries intact`);

    console.log(`\nE2E ADMIN PASSED \u2014 ${String(steps.length)} steps`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`\nE2E ADMIN FAILED \u2014 ${error.message}`);
  process.exitCode = 1;
});
