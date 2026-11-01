/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The scale proof (T11 §2). Development only.
 *
 * Builds a 10 000-customer / 10 000-product / 100 000-invoice company in a
 * throwaway database, measures the queries that decide whether the product feels
 * fast, then archives two years of invoices and measures the same queries again
 * to show that archiving actually shrinks the hot path rather than merely
 * moving rows somewhere else.
 *
 * It drives the services directly — no Electron — because that is where the time
 * goes and it makes the numbers reproducible on any machine with Node.
 *
 * Usage:  node scripts/perf.mjs [--json]
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-perf-'));
/**
 * `NEXUS_PERF_DB` pins the database so a run can be repeated without rebuilding
 * the dataset. Building 300 000 journal lines takes over a minute; an index
 * decision that takes five iterations should not cost five rebuilds.
 */
const DB_FILE = process.env.NEXUS_PERF_DB ?? path.join(WORK_DIR, 'nexus.db');
const REUSE = process.env.NEXUS_PERF_DB !== undefined && fs.existsSync(DB_FILE);

// `resolveWasmPath()` reads Electron's `app`; there is no Electron here.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => WORK_DIR, getAppPath: () => process.cwd() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { initConnection, conn } = require('../dist/main/main/db/connection.js');
const { migrate } = require('../dist/main/main/db/migrate.js');
const seed = require('../dist/main/main/db/seed.js');
const settings = require('../dist/main/main/services/settings.js');
const perf = require('../dist/main/main/services/perf.js');
const archive = require('../dist/main/main/services/archive.js');
const cache = require('../dist/main/main/services/cache.js');
const { trialBalance } = require('../dist/main/main/services/finance.reports.js');
const { searchGlobal } = require('../dist/main/main/services/search.js');
const { addDays, todayIso } = require('../dist/main/shared/dates.js');

const TARGET = { customers: 10_000, products: 10_000, invoices: 100_000, journals: 50_000 };

/** Budgets from the customer requirement, in milliseconds. */
const BUDGET = {
  'customers page 1': 120,
  'customers page 900': 120,
  'invoice KPI': 150,
  'trial balance': 600,
  'global search': 80,
};

function ms(started) {
  return Math.round(Number(process.hrtime.bigint() - started) / 10_000) / 100;
}

function measure(name, run) {
  const started = process.hrtime.bigint();
  const detail = run();
  return { name, ms: ms(started), detail };
}

/**
 * Progress on stderr, flushed immediately.
 *
 * A phase that takes minutes is indistinguishable from a hang unless it says
 * when it started. `--json` keeps stdout machine-readable, so the log has to go
 * to the other stream.
 */
function phase(label) {
  process.stderr.write(`[perf] ${label} @ ${new Date().toISOString().slice(11, 19)}\n`);
}

async function main() {
  const json = process.argv.includes('--json');

  phase(`open ${DB_FILE}${REUSE ? ' (reusing)' : ' (fresh)'}`);
  await initConnection({
    wasmPath: require.resolve('sql.js/dist/sql-wasm.wasm'),
    filePath: DB_FILE,
  });
  phase('migrate');
  migrate();

  let generated;
  if (REUSE) {
    const lines = Number(conn().one('SELECT COUNT(*) AS total FROM journal_lines')?.total ?? 0);
    generated = {
      customers: Number(conn().one('SELECT COUNT(*) AS total FROM customers')?.total ?? 0),
      products: Number(conn().one('SELECT COUNT(*) AS total FROM products')?.total ?? 0),
      invoices: Number(conn().one('SELECT COUNT(*) AS total FROM invoices')?.total ?? 0),
      journalLines: lines,
      ms: 0,
    };
  } else {
    phase('seed');
    const at = new Date().toISOString();
    conn().run(
      `INSERT INTO companies (id, name, legal_name, tax_id, address_json, logo_path, base_currency,
         fiscal_year_start_month, date_format, number_format, industry_preset, created_at, updated_at)
       VALUES ('co-1', 'Perf Co', NULL, NULL, NULL, NULL, 'USD', 1, 'yyyy-MM-dd', '1,234.56', NULL, ?, ?)`,
      [at, at],
    );
    conn().tx(() => seed.applyPreset('wholesale_retail', 'USD'));
    settings.ensureFiscalYear(1);
    phase(`generate ${String(TARGET.invoices)} invoices / ${String(TARGET.journals)} journals`);
    generated = perf.generatePerfDataset(TARGET);
    // Persist the *generated* dataset, before the archive runs, so `--reuse`
    // always starts from the full 300 000-line company and re-archives on every
    // run. `markDirty` alone is not enough: it schedules a debounced, unref'd
    // write, and a process that exits promptly leaves nothing behind.
    phase('flush generated dataset');
    conn().flushNow();
  }
  phase('benchmark (before archive)');
  const baseline = perf.benchmark();

  // ── 2. archive two years, then measure the same queries again ─────────────
  const cutoff = addDays(todayIso(), -730);
  const before = {
    invoices: Number(conn().one('SELECT COUNT(*) AS total FROM invoices').total),
    lines: Number(conn().one('SELECT COUNT(*) AS total FROM journal_lines').total),
  };

  phase(`archive (cutoff ${cutoff})`);
  const archiveStarted = process.hrtime.bigint();
  // Both halves matter: the invoice list reads `invoices`, and the trial balance
  // reads `journal_entries` + `journal_lines`. Archiving only invoices would
  // shrink one and leave the other untouched.
  // No `tables`: archive everything, which also proves the dependency order the
  // service declares — documents first, then the ledger entries they point at.
  const archived = archive.archiveOldRecords({ before: cutoff, limit: 50_000 });
  const archiveMs = ms(archiveStarted);
  cache.invalidateCache('');

  const after = {
    invoices: Number(conn().one('SELECT COUNT(*) AS total FROM invoices').total),
    lines: Number(conn().one('SELECT COUNT(*) AS total FROM journal_lines').total),
  };
  phase('benchmark (after archive)');
  const post = perf.benchmark();

  // The trial balance must still balance with two years of detail in the archive.
  phase('trial balance integrity');
  const tb = trialBalance(todayIso());
  const stats = archive.archiveStats();
  phase('done');

  const report = {
    machine: {
      platform: `${process.platform} ${process.arch}`,
      release: os.release(),
      cpu: (os.cpus()[0]?.model ?? 'unknown').trim(),
      cores: os.cpus().length,
      memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      node: process.version,
      electron: '33.4.11',
      sqlite: 'sql.js 1.11.0 (wasm, in-memory image)',
    },
    generated,
    baseline,
    archive: {
      cutoff,
      ms: archiveMs,
      archivedRows: archived.rows,
      before,
      after,
      stats,
      balanced: tb.balanced,
    },
    post,
    budgets: BUDGET,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const pad = (value, width) => String(value).padEnd(width);
  console.log(`\nNEXUS scale proof — ${report.machine.platform}, ${report.machine.cpu}`);
  console.log(`${String(report.machine.cores)} cores, ${String(report.machine.memoryGb)} GB, ${report.machine.node}\n`);

  console.log(
    `Dataset: ${String(generated.customers)} customers, ${String(generated.products)} products, ` +
      `${String(generated.invoices)} invoices, ${String(generated.journalLines)} journal lines ` +
      `— generated in ${String(generated.ms)} ms\n`,
  );

  const rows = [
    ...baseline.rows.map((row) => ({ ...row, when: 'before archive' })),
    ...post.rows.map((row) => ({ ...row, when: 'after archive' })),
  ];
  console.log(`${pad('query', 24)}${pad('before', 10)}${pad('after', 10)}${pad('budget', 9)}verdict`);
  for (const name of Object.keys(BUDGET)) {
    const beforeRow = baseline.rows.find((row) => row.name === name);
    const afterRow = post.rows.find((row) => row.name === name);
    const budget = BUDGET[name];
    // Strict: the budget has to hold on the whole dataset *and* after archiving,
    // so a regression cannot hide behind the smaller post-archive number.
    const verdict =
      Math.max(beforeRow?.ms ?? Infinity, afterRow?.ms ?? Infinity) <= budget ? 'PASS' : 'FAIL';
    console.log(
      `${pad(name, 24)}${pad(`${String(beforeRow?.ms ?? 0)} ms`, 10)}${pad(`${String(afterRow?.ms ?? 0)} ms`, 10)}` +
        `${pad(`${String(budget)} ms`, 9)}${verdict}`,
    );
  }
  for (const row of baseline.rows) {
    if (BUDGET[row.name] !== undefined) continue;
    const afterRow = post.rows.find((entry) => entry.name === row.name);
    console.log(`${pad(row.name, 24)}${pad(`${String(row.ms)} ms`, 10)}${pad(`${String(afterRow?.ms ?? 0)} ms`, 10)}`);
  }

  console.log(
    `\nArchive: ${String(report.archive.archivedRows)} rows in ${String(archiveMs)} ms ` +
      `(cutoff ${cutoff}); invoices ${String(before.invoices)} → ${String(after.invoices)}, ` +
      `lines ${String(before.lines)} → ${String(after.lines)}`,
  );
  console.log(`Trial balance still balanced: ${String(tb.balanced)}`);
  console.log(`Archive store: ${String(stats.length)} table(s), ${String(report.archive.archivedRows)} rows\n`);
  void rows;
}

main().catch((error) => {
  console.error(`PERF FAILED — ${error.message}`);
  process.exitCode = 1;
});
