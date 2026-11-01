/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The `sql.js` connection: one in-memory SQLite image, persisted atomically.
 *
 * Persistence contract (T02 #6, BR-15):
 *   `db.export()` → write `nexus.db.tmp` → `fsync` → `renameSync` over `nexus.db`
 * debounced by 200 ms, with a hard `flushNow()` on quit. A hard kill mid-write
 * leaves the previous file byte-identical, because `renameSync` is atomic on the
 * same volume and the tmp file is never the file we read at startup.
 *
 * The wasm path has two branches (risk R1) — see `resolveWasmPath`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import initSqlJs from 'sql.js';

import { logError, logInfo, logWarn } from '../log';

// Derived from the module's own declarations so the build does not depend on
// how the `sql.js` typings happen to export their namespaces.
type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;
type SqlDatabase = InstanceType<SqlJsStatic['Database']>;
type SqlStatement = ReturnType<SqlDatabase['prepare']>;

/** A value that can be bound to a prepared statement. Never interpolate SQL. */
export type SqlValue = number | string | Uint8Array | null;

const DEBOUNCE_MS = 200;
const DB_FILE_NAME = 'nexus.db';

/**
 * Counts `?` placeholders that are actually bindable, i.e. outside string
 * literals and `--` comments.
 *
 * sql.js silently binds `undefined` as `NULL`, so a missing parameter surfaces
 * far from the statement that dropped it — usually as a `NOT NULL constraint
 * failed` deep inside a transaction. Counting first turns that into a message
 * that names the statement.
 */
export function countPlaceholders(sql: string): number {
  let count = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote) {
      if (char === quote) {
        if (sql[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index);
      if (newline === -1) break;
      index = newline;
      continue;
    }
    if (char === '?') count += 1;
  }
  return count;
}

/** Throws when a statement's parameter list does not match its placeholders. */
function assertArity(sql: string, params: readonly SqlValue[]): void {
  const expected = countPlaceholders(sql);
  if (expected === params.length) return;
  throw new Error(
    `SQL arity mismatch: statement expects ${expected} parameter(s) but ${params.length} were bound — ${sql.slice(0, 120).replace(/\s+/g, ' ')}`,
  );
}

export interface Connection {
  /** Runs a query and returns every row. Always uses bound parameters. */
  all<T>(sql: string, params?: readonly SqlValue[]): T[];
  /** Runs a query and returns the first row, or `undefined`. */
  one<T>(sql: string, params?: readonly SqlValue[]): T | undefined;
  /** Runs a statement; returns the number of rows modified. */
  run(sql: string, params?: readonly SqlValue[]): number;
  /** Runs a multi-statement script (DDL, migrations). No parameters. */
  exec(sql: string): void;
  /** `last_insert_rowid()` for the current connection. */
  lastInsertRowid(): number;
  /** BEGIN → fn → COMMIT, ROLLBACK on throw. Never nests. */
  tx<T>(fn: () => T): T;
  isInTransaction(): boolean;
  /** Marks the image dirty and schedules the debounced atomic persist. */
  markDirty(): void;
  /** Persists immediately if dirty. Called on quit and after big writes. */
  flushNow(): void;
  /** Raw bytes of the database image. */
  exportBytes(): Uint8Array;
  /** Path of the file this image is persisted to. */
  filePath(): string;
  /** Bytes currently on disk (0 when the file does not exist yet). */
  fileSizeBytes(): number;
  /** Closes the database after flushing. */
  close(): void;
}

let connection: Connection | null = null;
let sqlModule: SqlJsStatic | null = null;

/**
 * Resolves `sql-wasm.wasm` for the current runtime.
 *
 * - packaged: `electron-builder.yml` copies `node_modules/sql.js/dist/sql-wasm.wasm`
 *   to `resources/sql-wasm.wasm`, so the file sits next to the app resources.
 * - dev: `require.resolve` finds it inside `node_modules`.
 *
 * Risk R1: a wrong path here is a white screen on a customer machine that works
 * perfectly on ours, which is why `index.ts` shows a dialog naming this path.
 */
export function resolveWasmPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'sql-wasm.wasm');
  try {
    return require.resolve('sql.js/dist/sql-wasm.wasm');
  } catch {
    return path.join(app.getAppPath(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  }
}

/** `%APPDATA%/nexus/nexus.db` */
export function resolveDatabasePath(): string {
  return path.join(app.getPath('userData'), DB_FILE_NAME);
}

function writeAtomically(target: string, bytes: Uint8Array): void {
  const temporary = `${target}.tmp`;
  const handle = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, target);
}

function createConnection(database: SqlDatabase, filePath: string): Connection {
  let dirty = false;
  let timer: NodeJS.Timeout | null = null;
  let inTransaction = false;
  const statementCache = new Map<string, SqlStatement>();

  /**
   * Drops every cached statement. MUST be called after `database.export()` and
   * after DDL: `export()` closes and re-opens the underlying SQLite handle, so
   * every prepared statement becomes invalid ("Statement closed") even though
   * the JavaScript object still exists.
   */
  const clearStatements = (): void => {
    for (const prepared of statementCache.values()) {
      try {
        prepared.free();
      } catch {
        // Already closed by export(); nothing to release.
      }
    }
    statementCache.clear();
  };

  const persist = (): void => {
    if (!dirty) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeAtomically(filePath, database.export());
      clearStatements();
      dirty = false;
    } catch (error) {
      logError('db.persist', error, { filePath });
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      persist();
    }, DEBOUNCE_MS);
    timer.unref();
  };

  const statement = (sql: string): SqlStatement => {
    const cached = statementCache.get(sql);
    if (cached) return cached;
    const prepared = database.prepare(sql);
    statementCache.set(sql, prepared);
    return prepared;
  };

  const all = <T>(sql: string, params: readonly SqlValue[] = []): T[] => {
    assertArity(sql, params);
    const prepared = statement(sql);
    prepared.reset();
    if (params.length > 0) prepared.bind(params as SqlValue[]);
    const rows: T[] = [];
    while (prepared.step()) rows.push(prepared.getAsObject() as T);
    prepared.reset();
    return rows;
  };

  const one = <T>(sql: string, params: readonly SqlValue[] = []): T | undefined => {
    const rows = all<T>(sql, params);
    return rows[0];
  };

  const run = (sql: string, params: readonly SqlValue[] = []): number => {
    assertArity(sql, params);
    database.run(sql, params as SqlValue[]);
    return database.getRowsModified();
  };

  const exec = (sql: string): void => {
    database.run(sql);
    // DDL invalidates prepared statements; drop the cache so the next query
    // re-prepares against the new schema.
    clearStatements();
  };

  const tx = <T>(fn: () => T): T => {
    if (inTransaction) return fn();
    database.run('BEGIN');
    inTransaction = true;
    try {
      const result = fn();
      database.run('COMMIT');
      inTransaction = false;
      return result;
    } catch (error) {
      try {
        database.run('ROLLBACK');
      } catch (rollbackError) {
        logError('db.rollback', rollbackError);
      }
      inTransaction = false;
      throw error;
    }
  };

  return {
    all,
    one,
    run,
    exec,
    lastInsertRowid: () => {
      const row = one<{ id: number }>('SELECT last_insert_rowid() AS id');
      return row ? Number(row.id) : 0;
    },
    tx,
    isInTransaction: () => inTransaction,
    markDirty: () => {
      dirty = true;
      schedule();
    },
    flushNow: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      persist();
    },
    exportBytes: () => database.export(),
    filePath: () => filePath,
    fileSizeBytes: () => {
      try {
        return fs.statSync(filePath).size;
      } catch {
        return 0;
      }
    },
    close: () => {
      clearStatements();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      persist();
      database.close();
      connection = null;
    },
  };
}

/**
 * Opens the database file if it exists, otherwise creates an empty image.
 * Throws a descriptive error when the wasm module cannot be loaded — the caller
 * turns that into a `dialog.showErrorBox` with the resolved path.
 */
export async function initConnection(options: {
  readonly wasmPath?: string;
  readonly filePath?: string;
} = {}): Promise<Connection> {
  if (connection) return connection;

  const wasmPath = options.wasmPath ?? resolveWasmPath();
  const filePath = options.filePath ?? resolveDatabasePath();

  if (!fs.existsSync(wasmPath)) {
    throw new Error(
      `The SQLite engine is missing.\nExpected: ${wasmPath}\n` +
        'Reinstall NEXUS, or in a packaged build confirm resources/sql-wasm.wasm exists.',
    );
  }

  sqlModule = await initSqlJs({ locateFile: () => wasmPath });

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  const database =
    existing && existing.byteLength > 0
      ? new sqlModule.Database(new Uint8Array(existing))
      : new sqlModule.Database();

  database.run('PRAGMA foreign_keys = ON;');
  try {
    // sql.js keeps the whole database in memory; MEMORY is the only meaningful
    // journal mode. It is set explicitly so behaviour cannot drift.
    database.run('PRAGMA journal_mode = MEMORY;');
  } catch (error) {
    logWarn('db.init', `journal_mode not applied: ${String(error)}`);
  }

  connection = createConnection(database, filePath);
  logInfo('db.init', `opened ${filePath} (wasm: ${wasmPath})`);
  return connection;
}

/** The live connection. Throws if `initConnection` has not completed. */
export function conn(): Connection {
  if (!connection) throw new Error('Database is not initialised');
  return connection;
}

/** True once the database is open. */
export function isConnected(): boolean {
  return connection !== null;
}

/**
 * Flushes, closes and forgets the live connection, so the next `initConnection`
 * reopens from disk.
 *
 * Only the restore path needs this: replacing the database file under a running
 * in-memory image would leave every reader looking at the old bytes. There is no
 * other legitimate caller — a plain close on quit goes through `conn().close()`.
 */
export function closeConnection(): void {
  if (!connection) return;
  connection.close();
  connection = null;
}

/** Reads `PRAGMA user_version`. */
export function userVersion(): number {
  const row = conn().one<{ user_version: number }>('PRAGMA user_version');
  return row ? Number(row.user_version) : 0;
}

/**
 * Runs `fn` inside a transaction, or inline when one is already open.
 *
 * `Connection.tx` deliberately never nests, so a service that must be atomic on
 * its own (lead conversion, import commit, backup restore) cannot simply call
 * `tx`: when the dispatcher has already opened one, a second `BEGIN` would
 * throw, and when a test calls the service directly there is no transaction at
 * all and a mid-way failure would leave half a record behind. This is the one
 * place that decides, so every caller gets the same answer.
 */
export function atomically<T>(fn: () => T): T {
  const database = conn();
  if (database.isInTransaction()) return fn();
  return database.tx(fn);
}
