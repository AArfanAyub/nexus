/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Query-plan probe (development only). `node scripts/probe-sql.mjs <db> <file.sql>`
 *
 * `scripts/perf.mjs` says *that* a query is too slow; this says *why*. Each
 * statement in the file is run three times and timed, and `EXPLAIN QUERY PLAN`
 * is printed above it, so a rewrite can be judged in seconds against a real
 * 300 000-line database instead of a guess.
 *
 * The database is opened read-only by convention: copy it first.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);

const DB_FILE = process.argv[2];
const SQL_FILE = process.argv[3];
if (!DB_FILE || !SQL_FILE) {
  console.error('usage: node scripts/probe-sql.mjs <db file> <sql file>');
  process.exit(2);
}

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-probe-'));
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

await initConnection({ wasmPath: require.resolve('sql.js/dist/sql-wasm.wasm'), filePath: DB_FILE });

// `--migrate` applies whatever this build is missing and reports how long it
// took. An upgrade on a 300 000-line database is the slowest thing the product
// ever does, so it is worth being able to time it without a full perf run.
if (process.argv.includes('--migrate')) {
  const started = process.hrtime.bigint();
  const result = migrate();
  const ms = Math.round(Number(process.hrtime.bigint() - started) / 10_000) / 100;
  console.log(
    `migrate ${String(result.from)} → ${String(result.to)} in ${String(ms)} ms` +
      `${result.applied.length === 0 ? ' (nothing to do)' : `: ${result.applied.join(', ')}`}`,
  );
  conn().markDirty();
  conn().flushNow();
}

const text = fs.readFileSync(SQL_FILE, 'utf8');
// `-- name` starts a statement; everything up to the next marker is its SQL.
const blocks = text
  .split(/^-- /m)
  .map((chunk) => chunk.trim())
  .filter((chunk) => chunk.length > 0);

for (const block of blocks) {
  const newline = block.indexOf('\n');
  const name = newline === -1 ? block : block.slice(0, newline);
  const sql = (newline === -1 ? '' : block.slice(newline + 1)).trim();
  if (sql.length === 0) continue;

  console.log(`\n### ${name}`);
  const plan = conn().all(`EXPLAIN QUERY PLAN ${sql}`);
  for (const row of plan) console.log(`    ${String(row['detail'])}`);

  // Warm, then the best of three: the first run pays for page-cache misses that
  // a real user would not, because they have been clicking around already.
  const timings = [];
  for (let index = 0; index < 4; index += 1) {
    const started = process.hrtime.bigint();
    const rows = conn().all(sql);
    const ms = Number(process.hrtime.bigint() - started) / 1_000_000;
    if (index > 0) timings.push(Math.round(ms * 100) / 100);
    if (index === 3) {
      console.log(`    rows: ${String(rows.length)}`);
      if (rows.length === 1) console.log(`    value: ${JSON.stringify(rows[0])}`);
    }
  }
  console.log(`    ms: ${timings.join(', ')}  → best ${String(Math.min(...timings))}`);
}
