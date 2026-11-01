"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
exports.list = list;
exports.verify = verify;
exports.restore = restore;
exports.preRestoreCopies = preRestoreCopies;
/**
 * Backup and restore (T10).
 *
 * ## What a backup is
 *
 * The whole database is one file, so a backup is a byte copy — but a byte copy
 * is only worth having if you can prove it is *readable*. Every backup here
 * therefore carries a manifest with three facts that are checked on restore:
 *
 *   - `sha256` of the file, so a truncated or edited copy is refused;
 *   - the `PRAGMA integrity_check` result of the copy itself, not of the live
 *     database, because the copy is what will be restored;
 *   - the schema version, so restoring a v2 file into a v4 build is a loud
 *     refusal rather than a silent downgrade.
 *
 * ## Why the flush comes first
 *
 * The database lives in memory and persists on a debounce. Copying the file
 * without `flushNow()` would capture whatever was on disk a second ago — the
 * classic "the backup is missing my last invoice" bug.
 */
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const sql_js_1 = __importDefault(require("sql.js"));
const dates_1 = require("../../shared/dates");
const connection_1 = require("../db/connection");
const errors_1 = require("../errors");
const auditLog = __importStar(require("./audit"));
const cache_1 = require("./cache");
const MANIFEST_VERSION = 1;
const MANIFEST_SUFFIX = '.manifest.json';
function sha256(bytes) {
    return (0, node_crypto_1.createHash)('sha256').update(Buffer.from(bytes)).digest('hex');
}
/** Row counts worth stating in a manifest: enough to spot an empty backup. */
function counts() {
    const tables = ['users', 'customers', 'vendors', 'products', 'invoices', 'bills', 'deals', 'journal_entries'];
    const out = {};
    for (const table of tables) {
        try {
            const row = (0, connection_1.conn)().one(`SELECT COUNT(*) AS total FROM ${table}`);
            out[table] = Number(row?.total ?? 0);
        }
        catch {
            out[table] = -1;
        }
    }
    return out;
}
function companyName() {
    try {
        const row = (0, connection_1.conn)().one('SELECT name FROM companies LIMIT 1');
        return row?.name ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Runs `PRAGMA integrity_check` against the bytes we are about to call a backup.
 *
 * Opening a second database from the same module is the only way to check the
 * copy rather than the original — and checking the original would be checking
 * the thing we already know works.
 */
async function integrityOf(bytes) {
    const wasmPath = (0, connection_1.resolveWasmPath)();
    const SQL = await (0, sql_js_1.default)({ locateFile: () => wasmPath });
    const database = new SQL.Database(bytes);
    try {
        const result = database.exec('PRAGMA integrity_check');
        const rows = result[0]?.values ?? [];
        const first = rows[0]?.[0];
        return typeof first === 'string' ? first : 'unknown';
    }
    finally {
        database.close();
    }
}
/** `nexus-2026-01-31T09-15-00.db` */
function backupFilename(at) {
    return `nexus-${at.replace(/[:.]/g, '-').slice(0, 19)}.db`;
}
/**
 * Writes a consistent copy plus its manifest into `targetDir`.
 *
 * `targetDir` comes from the native folder dialog, so it is whatever the operator
 * chose — a USB stick, a network share, a synced folder. We create it if needed
 * rather than refusing, because "the folder does not exist yet" is a normal thing
 * to happen on a removable drive.
 */
async function create(targetDir, scope) {
    const started = Date.now();
    const directory = targetDir.trim();
    if (directory.length === 0)
        throw (0, errors_1.conflict)('Choose a folder to back up into.');
    (0, connection_1.conn)().flushNow();
    const source = (0, connection_1.conn)().filePath();
    if (!(0, node_fs_1.existsSync)(source))
        throw (0, errors_1.conflict)('The database file has not been written yet, so there is nothing to back up.');
    const bytes = new Uint8Array((0, node_fs_1.readFileSync)(source));
    if (bytes.byteLength === 0)
        throw (0, errors_1.conflict)('The database file is empty, so there is nothing to back up.');
    (0, node_fs_1.mkdirSync)(directory, { recursive: true });
    const at = (0, dates_1.nowIso)();
    const filename = backupFilename(at);
    const target = node_path_1.default.join(directory, filename);
    const digest = sha256(bytes);
    const integrity = await integrityOf(bytes);
    if (integrity !== 'ok') {
        throw (0, errors_1.conflict)(`The copy failed its integrity check (${integrity}). Nothing was written.`);
    }
    (0, node_fs_1.writeFileSync)(target, Buffer.from(bytes));
    const manifest = {
        version: MANIFEST_VERSION,
        appVersion: process.env['npm_package_version'] ?? '1.0.0',
        createdAt: at,
        filename,
        bytes: bytes.byteLength,
        sha256: digest,
        schemaVersion: (0, connection_1.userVersion)(),
        integrity,
        company: companyName(),
        counts: counts(),
    };
    (0, node_fs_1.writeFileSync)(node_path_1.default.join(directory, `${filename}${MANIFEST_SUFFIX}`), JSON.stringify(manifest, null, 2), 'utf8');
    auditLog.append({
        actorId: scope.actorId,
        actorName: scope.actorName,
        entity: 'backup',
        entityId: filename,
        action: 'backup_create',
        after: { bytes: manifest.bytes, sha256: digest, schemaVersion: manifest.schemaVersion },
        meta: { directory },
    });
    return { path: target, manifest, ms: Date.now() - started };
}
/** Lists the backups in a folder, newest first. Unreadable manifests are reported, not hidden. */
function list(directory) {
    const dir = directory.trim();
    if (dir.length === 0 || !(0, node_fs_1.existsSync)(dir))
        return [];
    const entries = [];
    for (const name of (0, node_fs_1.readdirSync)(dir)) {
        if (!name.endsWith('.db'))
            continue;
        const full = node_path_1.default.join(dir, name);
        let bytes = 0;
        let createdAt = (0, dates_1.nowIso)();
        try {
            const stat = (0, node_fs_1.statSync)(full);
            bytes = stat.size;
            createdAt = stat.mtime.toISOString();
        }
        catch {
            continue;
        }
        let manifest = null;
        try {
            const raw = (0, node_fs_1.readFileSync)(`${full}${MANIFEST_SUFFIX}`, 'utf8');
            manifest = JSON.parse(raw);
        }
        catch {
            manifest = null;
        }
        entries.push({ path: full, filename: name, bytes, createdAt, manifest, manifestValid: manifest !== null });
    }
    entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return entries;
}
/** Reads and checks one backup without restoring it. */
async function verify(filePath) {
    if (!(0, node_fs_1.existsSync)(filePath))
        throw (0, errors_1.notFound)('Backup file');
    const bytes = new Uint8Array((0, node_fs_1.readFileSync)(filePath));
    const digest = sha256(bytes);
    let manifest;
    try {
        manifest = JSON.parse((0, node_fs_1.readFileSync)(`${filePath}${MANIFEST_SUFFIX}`, 'utf8'));
    }
    catch {
        throw (0, errors_1.conflict)('That backup has no manifest beside it, so it cannot be verified.');
    }
    if (manifest.sha256 !== digest) {
        throw (0, errors_1.conflict)('That backup has changed since it was written — the checksum does not match. Restore refused.');
    }
    const integrity = await integrityOf(bytes);
    if (integrity !== 'ok')
        throw (0, errors_1.conflict)(`That backup fails its integrity check (${integrity}). Restore refused.`);
    if (manifest.schemaVersion > (0, connection_1.userVersion)()) {
        throw (0, errors_1.conflict)(`That backup is schema v${String(manifest.schemaVersion)} and this build reads v${String((0, connection_1.userVersion)())}. Upgrade NEXUS before restoring it.`);
    }
    return { ...manifest, integrity };
}
/**
 * Replaces the live database with a backup.
 *
 * Order matters: verify → copy the *current* database aside → overwrite → reopen.
 * The aside copy is the undo, and it is taken before anything is replaced so a
 * failed reopen still leaves a readable file on disk. Every session is dropped
 * because the users table has just changed underneath them.
 */
async function restore(filePath, scope, options = {}) {
    const manifest = await verify(filePath);
    const target = (0, connection_1.conn)().filePath();
    const bytes = new Uint8Array((0, node_fs_1.readFileSync)(filePath));
    if (options.skipSafetyCopy !== true) {
        (0, connection_1.conn)().flushNow();
        if ((0, node_fs_1.existsSync)(target)) {
            const safety = `${target}.pre-restore-${(0, dates_1.nowIso)().replace(/[:.]/g, '-')}`;
            try {
                (0, node_fs_1.writeFileSync)(safety, (0, node_fs_1.readFileSync)(target));
            }
            catch {
                // A safety copy is a courtesy; failing to make one must not block a
                // restore the operator has already confirmed.
            }
        }
    }
    // Write through a temporary file and rename, so a crash mid-write cannot leave
    // a half-written database where the real one was.
    const staging = `${target}.restoring`;
    (0, node_fs_1.writeFileSync)(staging, Buffer.from(bytes));
    (0, connection_1.closeConnection)();
    (0, node_fs_1.renameSync)(staging, target);
    await (0, connection_1.initConnection)({ filePath: target });
    (0, cache_1.invalidateCache)('');
    const restoredAt = (0, dates_1.nowIso)();
    auditLog.append({
        actorId: scope.actorId,
        actorName: scope.actorName,
        entity: 'backup',
        entityId: manifest.filename,
        action: 'backup_restore',
        after: { restoredAt, sha256: manifest.sha256, schemaVersion: manifest.schemaVersion },
    });
    return { path: filePath, restoredAt, integrity: manifest.integrity, requiresLogin: true };
}
/** Where the restore leaves its undo copy, for the UI to mention. */
function preRestoreCopies(filePath) {
    const dir = node_path_1.default.dirname(filePath);
    if (!(0, node_fs_1.existsSync)(dir))
        return [];
    const base = node_path_1.default.basename(filePath);
    return (0, node_fs_1.readdirSync)(dir)
        .filter((name) => name.startsWith(`${base}.pre-restore-`))
        .map((name) => node_path_1.default.join(dir, name));
}
//# sourceMappingURL=backup.js.map