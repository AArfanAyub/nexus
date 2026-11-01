/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Forward-only migrations keyed on `PRAGMA user_version`.
 *
 * Rules:
 *   - a migration is never edited after it ships; append a new one
 *   - the runner is idempotent: re-running on a current database does nothing
 *   - each migration runs in its own transaction, so a failure leaves the
 *     previous version intact rather than a half-built schema
 */

import { logInfo } from '../log';

import { conn } from './connection';
import { MIGRATION_V2_SQL } from './migrate.v2';
import { MIGRATION_V3_SQL } from './migrate.v3';
import { MIGRATION_V4_SQL } from './migrate.v4';
import { MIGRATION_V5_SQL } from './migrate.v5';
import { MIGRATION_V6_SQL } from './migrate.v6';
import { MIGRATION_V7_SQL } from './migrate.v7';
import { MIGRATION_V8_SQL } from './migrate.v8';
import { MIGRATION_V10_SQL } from './migrate.v10';
import { MIGRATION_V9_SQL } from './migrate.v9';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** Ordered migrations. `version` must be 1..N with no gaps. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial-schema', sql: SCHEMA_SQL },
  { version: 2, name: 'scale-indexes-archive-cache', sql: MIGRATION_V2_SQL },
  { version: 3, name: 'inventory-layers-uom-ops-links', sql: MIGRATION_V3_SQL },
  { version: 4, name: 'crm-lead-status-admin-indexes', sql: MIGRATION_V4_SQL },
  { version: 5, name: 'scale-covering-indexes', sql: MIGRATION_V5_SQL },
  { version: 6, name: 'ledger-line-posted-date', sql: MIGRATION_V6_SQL },
  { version: 7, name: 'archive-balance-rollup', sql: MIGRATION_V7_SQL },
  { version: 8, name: 'search-nocase-indexes', sql: MIGRATION_V8_SQL },
  { version: 9, name: 'foreign-key-indexes', sql: MIGRATION_V9_SQL },
  { version: 10, name: 'currency-catalogue', sql: MIGRATION_V10_SQL },
];

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly string[];
}

/**
 * Applies every migration whose version is greater than the database's
 * `user_version`. Returns what happened so startup can log it.
 */
export function migrate(): MigrationResult {
  const database = conn();
  const currentRow = database.one<{ user_version: number }>('PRAGMA user_version');
  const from = currentRow ? Number(currentRow.user_version) : 0;
  const applied: string[] = [];

  const pending = MIGRATIONS.filter((migration) => migration.version > from).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    database.tx(() => {
      database.exec(migration.sql);
      // PRAGMA does not accept a bound parameter; the value is a literal from
      // our own MIGRATIONS array, never user input.
      database.exec(`PRAGMA user_version = ${String(migration.version)};`);
    });
    applied.push(`v${String(migration.version)} ${migration.name}`);
  }

  const to = userVersionOf(database);
  if (applied.length > 0) {
    database.markDirty();
    logInfo('db.migrate', `applied ${applied.join(', ')} (user_version ${String(from)} → ${String(to)})`);
  }

  return { from, to, applied };
}

function userVersionOf(database: ReturnType<typeof conn>): number {
  const row = database.one<{ user_version: number }>('PRAGMA user_version');
  return row ? Number(row.user_version) : 0;
}

/** True when the schema is at the version this build expects. */
export function isSchemaCurrent(): boolean {
  return userVersionOf(conn()) === SCHEMA_VERSION;
}
