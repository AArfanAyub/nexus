"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIGRATIONS = void 0;
exports.migrate = migrate;
exports.isSchemaCurrent = isSchemaCurrent;
/**
 * Forward-only migrations keyed on `PRAGMA user_version`.
 *
 * Rules:
 *   - a migration is never edited after it ships; append a new one
 *   - the runner is idempotent: re-running on a current database does nothing
 *   - each migration runs in its own transaction, so a failure leaves the
 *     previous version intact rather than a half-built schema
 */
const log_1 = require("../log");
const connection_1 = require("./connection");
const migrate_v2_1 = require("./migrate.v2");
const migrate_v3_1 = require("./migrate.v3");
const migrate_v4_1 = require("./migrate.v4");
const migrate_v5_1 = require("./migrate.v5");
const migrate_v6_1 = require("./migrate.v6");
const migrate_v7_1 = require("./migrate.v7");
const migrate_v8_1 = require("./migrate.v8");
const migrate_v10_1 = require("./migrate.v10");
const migrate_v9_1 = require("./migrate.v9");
const schema_1 = require("./schema");
/** Ordered migrations. `version` must be 1..N with no gaps. */
exports.MIGRATIONS = [
    { version: 1, name: 'initial-schema', sql: schema_1.SCHEMA_SQL },
    { version: 2, name: 'scale-indexes-archive-cache', sql: migrate_v2_1.MIGRATION_V2_SQL },
    { version: 3, name: 'inventory-layers-uom-ops-links', sql: migrate_v3_1.MIGRATION_V3_SQL },
    { version: 4, name: 'crm-lead-status-admin-indexes', sql: migrate_v4_1.MIGRATION_V4_SQL },
    { version: 5, name: 'scale-covering-indexes', sql: migrate_v5_1.MIGRATION_V5_SQL },
    { version: 6, name: 'ledger-line-posted-date', sql: migrate_v6_1.MIGRATION_V6_SQL },
    { version: 7, name: 'archive-balance-rollup', sql: migrate_v7_1.MIGRATION_V7_SQL },
    { version: 8, name: 'search-nocase-indexes', sql: migrate_v8_1.MIGRATION_V8_SQL },
    { version: 9, name: 'foreign-key-indexes', sql: migrate_v9_1.MIGRATION_V9_SQL },
    { version: 10, name: 'currency-catalogue', sql: migrate_v10_1.MIGRATION_V10_SQL },
];
/**
 * Applies every migration whose version is greater than the database's
 * `user_version`. Returns what happened so startup can log it.
 */
function migrate() {
    const database = (0, connection_1.conn)();
    const currentRow = database.one('PRAGMA user_version');
    const from = currentRow ? Number(currentRow.user_version) : 0;
    const applied = [];
    const pending = exports.MIGRATIONS.filter((migration) => migration.version > from).sort((a, b) => a.version - b.version);
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
        (0, log_1.logInfo)('db.migrate', `applied ${applied.join(', ')} (user_version ${String(from)} → ${String(to)})`);
    }
    return { from, to, applied };
}
function userVersionOf(database) {
    const row = database.one('PRAGMA user_version');
    return row ? Number(row.user_version) : 0;
}
/** True when the schema is at the version this build expects. */
function isSchemaCurrent() {
    return userVersionOf((0, connection_1.conn)()) === schema_1.SCHEMA_VERSION;
}
//# sourceMappingURL=migrate.js.map