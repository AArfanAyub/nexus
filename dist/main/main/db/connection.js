"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.countPlaceholders = countPlaceholders;
exports.resolveWasmPath = resolveWasmPath;
exports.resolveDatabasePath = resolveDatabasePath;
exports.initConnection = initConnection;
exports.conn = conn;
exports.isConnected = isConnected;
exports.closeConnection = closeConnection;
exports.userVersion = userVersion;
exports.atomically = atomically;
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
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
const sql_js_1 = __importDefault(require("sql.js"));
const log_1 = require("../log");
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
function countPlaceholders(sql) {
    let count = 0;
    let quote = null;
    for (let index = 0; index < sql.length; index += 1) {
        const char = sql[index];
        if (quote) {
            if (char === quote) {
                if (sql[index + 1] === quote)
                    index += 1;
                else
                    quote = null;
            }
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if (char === '-' && sql[index + 1] === '-') {
            const newline = sql.indexOf('\n', index);
            if (newline === -1)
                break;
            index = newline;
            continue;
        }
        if (char === '?')
            count += 1;
    }
    return count;
}
/** Throws when a statement's parameter list does not match its placeholders. */
function assertArity(sql, params) {
    const expected = countPlaceholders(sql);
    if (expected === params.length)
        return;
    throw new Error(`SQL arity mismatch: statement expects ${expected} parameter(s) but ${params.length} were bound — ${sql.slice(0, 120).replace(/\s+/g, ' ')}`);
}
let connection = null;
let sqlModule = null;
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
function resolveWasmPath() {
    if (electron_1.app.isPackaged)
        return node_path_1.default.join(process.resourcesPath, 'sql-wasm.wasm');
    try {
        return require.resolve('sql.js/dist/sql-wasm.wasm');
    }
    catch {
        return node_path_1.default.join(electron_1.app.getAppPath(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    }
}
/** `%APPDATA%/nexus/nexus.db` */
function resolveDatabasePath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), DB_FILE_NAME);
}
function writeAtomically(target, bytes) {
    const temporary = `${target}.tmp`;
    const handle = node_fs_1.default.openSync(temporary, 'w');
    try {
        node_fs_1.default.writeFileSync(handle, bytes);
        node_fs_1.default.fsyncSync(handle);
    }
    finally {
        node_fs_1.default.closeSync(handle);
    }
    node_fs_1.default.renameSync(temporary, target);
}
function createConnection(database, filePath) {
    let dirty = false;
    let timer = null;
    let inTransaction = false;
    const statementCache = new Map();
    /**
     * Drops every cached statement. MUST be called after `database.export()` and
     * after DDL: `export()` closes and re-opens the underlying SQLite handle, so
     * every prepared statement becomes invalid ("Statement closed") even though
     * the JavaScript object still exists.
     */
    const clearStatements = () => {
        for (const prepared of statementCache.values()) {
            try {
                prepared.free();
            }
            catch {
                // Already closed by export(); nothing to release.
            }
        }
        statementCache.clear();
    };
    const persist = () => {
        if (!dirty)
            return;
        try {
            node_fs_1.default.mkdirSync(node_path_1.default.dirname(filePath), { recursive: true });
            writeAtomically(filePath, database.export());
            clearStatements();
            dirty = false;
        }
        catch (error) {
            (0, log_1.logError)('db.persist', error, { filePath });
        }
    };
    const schedule = () => {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            persist();
        }, DEBOUNCE_MS);
        timer.unref();
    };
    const statement = (sql) => {
        const cached = statementCache.get(sql);
        if (cached)
            return cached;
        const prepared = database.prepare(sql);
        statementCache.set(sql, prepared);
        return prepared;
    };
    const all = (sql, params = []) => {
        assertArity(sql, params);
        const prepared = statement(sql);
        prepared.reset();
        if (params.length > 0)
            prepared.bind(params);
        const rows = [];
        while (prepared.step())
            rows.push(prepared.getAsObject());
        prepared.reset();
        return rows;
    };
    const one = (sql, params = []) => {
        const rows = all(sql, params);
        return rows[0];
    };
    const run = (sql, params = []) => {
        assertArity(sql, params);
        database.run(sql, params);
        return database.getRowsModified();
    };
    const exec = (sql) => {
        database.run(sql);
        // DDL invalidates prepared statements; drop the cache so the next query
        // re-prepares against the new schema.
        clearStatements();
    };
    const tx = (fn) => {
        if (inTransaction)
            return fn();
        database.run('BEGIN');
        inTransaction = true;
        try {
            const result = fn();
            database.run('COMMIT');
            inTransaction = false;
            return result;
        }
        catch (error) {
            try {
                database.run('ROLLBACK');
            }
            catch (rollbackError) {
                (0, log_1.logError)('db.rollback', rollbackError);
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
            const row = one('SELECT last_insert_rowid() AS id');
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
                return node_fs_1.default.statSync(filePath).size;
            }
            catch {
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
async function initConnection(options = {}) {
    if (connection)
        return connection;
    const wasmPath = options.wasmPath ?? resolveWasmPath();
    const filePath = options.filePath ?? resolveDatabasePath();
    if (!node_fs_1.default.existsSync(wasmPath)) {
        throw new Error(`The SQLite engine is missing.\nExpected: ${wasmPath}\n` +
            'Reinstall NEXUS, or in a packaged build confirm resources/sql-wasm.wasm exists.');
    }
    sqlModule = await (0, sql_js_1.default)({ locateFile: () => wasmPath });
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(filePath), { recursive: true });
    const existing = node_fs_1.default.existsSync(filePath) ? node_fs_1.default.readFileSync(filePath) : null;
    const database = existing && existing.byteLength > 0
        ? new sqlModule.Database(new Uint8Array(existing))
        : new sqlModule.Database();
    database.run('PRAGMA foreign_keys = ON;');
    try {
        // sql.js keeps the whole database in memory; MEMORY is the only meaningful
        // journal mode. It is set explicitly so behaviour cannot drift.
        database.run('PRAGMA journal_mode = MEMORY;');
    }
    catch (error) {
        (0, log_1.logWarn)('db.init', `journal_mode not applied: ${String(error)}`);
    }
    connection = createConnection(database, filePath);
    (0, log_1.logInfo)('db.init', `opened ${filePath} (wasm: ${wasmPath})`);
    return connection;
}
/** The live connection. Throws if `initConnection` has not completed. */
function conn() {
    if (!connection)
        throw new Error('Database is not initialised');
    return connection;
}
/** True once the database is open. */
function isConnected() {
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
function closeConnection() {
    if (!connection)
        return;
    connection.close();
    connection = null;
}
/** Reads `PRAGMA user_version`. */
function userVersion() {
    const row = conn().one('PRAGMA user_version');
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
function atomically(fn) {
    const database = conn();
    if (database.isInTransaction())
        return fn();
    return database.tx(fn);
}
//# sourceMappingURL=connection.js.map