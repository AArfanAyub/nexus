/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/** Where the archive spends its time. Development only. */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-arch-'));
const Module = require('node:module');
const orig = Module._load;
Module._load = function (r, p, i) {
  if (r === 'electron') return { app: { isPackaged: false, getPath: () => WORK, getAppPath: () => process.cwd() } };
  return orig.call(this, r, p, i);
};

const { initConnection, conn } = require('../dist/main/main/db/connection.js');
const { migrate } = require('../dist/main/main/db/migrate.js');
const archive = require('../dist/main/main/services/archive.js');

await initConnection({ wasmPath: require.resolve('sql.js/dist/sql-wasm.wasm'), filePath: process.argv[2] });
migrate();

const count = (table) => Number(conn().one(`SELECT COUNT(*) AS n FROM ${table}`).n);
console.log('before:', { invoices: count('invoices'), entries: count('journal_entries'), lines: count('journal_lines') });

for (const table of ['invoices', 'bills', 'payments', 'stock_moves', 'journal_entries']) {
  const started = process.hrtime.bigint();
  const result = archive.archiveOldRecords({ before: process.argv[3] ?? '2024-10-31', tables: [table], limit: 50_000 });
  const ms = Math.round(Number(process.hrtime.bigint() - started) / 10_000) / 100;
  console.log(`${table.padEnd(16)} ${String(result.rows).padStart(7)} rows  ${String(ms).padStart(9)} ms`);
}
console.log('after:', { invoices: count('invoices'), entries: count('journal_entries'), lines: count('journal_lines') });
