/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Which search source costs what. Development only.
 *
 * Wraps `conn().all` so every statement `searchGlobal` runs is timed, then prints
 * them in order. The palette has thirteen sources and one budget; without this
 * the only fact available is "search took 357 ms", which is not actionable.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-search-'));
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => WORK_DIR, getAppPath: () => process.cwd() } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { initConnection, conn } = require('../dist/main/main/db/connection.js');
const { searchGlobal } = require('../dist/main/main/services/search.js');

await initConnection({ wasmPath: require.resolve('sql.js/dist/sql-wasm.wasm'), filePath: process.argv[2] });

const database = conn();
const realAll = database.all.bind(database);
const timings = [];
database.all = (sql, params) => {
  const started = process.hrtime.bigint();
  const rows = realAll(sql, params);
  timings.push({
    ms: Number(process.hrtime.bigint() - started) / 1_000_000,
    rows: rows.length,
    table: /FROM\s+(\w+)/i.exec(sql)?.[1] ?? '?',
    pattern: params?.[0],
  });
  return rows;
};

const term = process.argv[3] ?? 'Perf';
// Twice: the first call pays for page-cache misses a real user never sees,
// because they have been clicking around for a while before they hit ⌘K.
searchGlobal(term, { limit: 8 });
timings.length = 0;
const result = searchGlobal(term, { limit: 8 });
console.log(`\nsearchGlobal("${term}") → ${String(result.ms)} ms (warm), ${String(result.groups.length)} groups\n`);

const byTable = new Map();
for (const entry of timings) {
  const current = byTable.get(entry.table) ?? { ms: 0, calls: 0 };
  current.ms += entry.ms;
  current.calls += 1;
  byTable.set(entry.table, current);
}
const rows = [...byTable.entries()].sort((a, b) => b[1].ms - a[1].ms);
for (const [table, stat] of rows) {
  console.log(`  ${table.padEnd(18)} ${stat.ms.toFixed(1).padStart(8)} ms  (${String(stat.calls)} statement(s))`);
}
console.log(`\n  ${'TOTAL'.padEnd(18)} ${timings.reduce((total, e) => total + e.ms, 0).toFixed(1).padStart(8)} ms`);
