/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Prints row counts for a NEXUS database file (development tool).
 *
 * Usage:
 *   node scripts/inspect-db.mjs                 # the live profile database
 *   node scripts/inspect-db.mjs path/to/nexus.db
 *
 * Read-only: opens a copy of the bytes in memory and never writes back.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

import initSqlJs from 'sql.js';

const DEFAULT_DB = path.join(process.env.APPDATA ?? path.join(os.homedir(), '.config'), 'nexus', 'nexus.db');

const TABLES = [
  'companies',
  'users',
  'roles',
  'accounts',
  'taxes',
  'currencies',
  'journals',
  'periods',
  'customers',
  'vendors',
  'products',
  'warehouses',
  'locations',
  'stock_moves',
  'stock_quants',
  'invoices',
  'invoice_lines',
  'deals',
  'deal_stages',
  'crm_accounts',
  'contacts',
  'activities',
  'number_sequences',
  'custom_fields',
  'notifications',
  'audit_log',
];

const file = process.argv[2] ?? DEFAULT_DB;
if (!fs.existsSync(file)) {
  console.error(`no database at ${file}`);
  process.exit(1);
}

const wasmPath = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
const SQL = await initSqlJs({ wasmPath });
const db = new SQL.Database(new Uint8Array(fs.readFileSync(file)));

const count = (table) => {
  try {
    const result = db.exec(`SELECT COUNT(*) FROM ${table}`);
    return result[0]?.values[0]?.[0] ?? 0;
  } catch {
    return null;
  }
};

console.log(`file: ${file}`);
console.log(`size: ${fs.statSync(file).size} bytes`);
const version = db.exec('PRAGMA user_version')[0]?.values[0]?.[0];
console.log(`user_version: ${version}`);

let populated = 0;
for (const table of TABLES) {
  const total = count(table);
  if (total === null) {
    console.log(`  ${table.padEnd(16)} (missing)`);
    continue;
  }
  if (total > 0) populated += 1;
  console.log(`  ${table.padEnd(16)} ${total}`);
}

const company = db.exec('SELECT name, base_currency, industry_preset FROM companies LIMIT 1')[0]?.values[0];
console.log(`company: ${company ? company.join(' | ') : '(none)'}`);

const audit = db.exec("SELECT COUNT(*), COALESCE(MAX(seq), 0) FROM audit_log")[0]?.values[0];
console.log(`audit rows: ${audit?.[0]} (last seq ${audit?.[1]})`);
console.log(`tables with data: ${populated}/${TABLES.length}`);
db.close();
