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
exports.listEntity = listEntity;
exports.getEntity = getEntity;
exports.saveEntity = saveEntity;
exports.archiveEntity = archiveEntity;
exports.restoreEntity = restoreEntity;
exports.deleteEntity = deleteEntity;
exports.exportEntity = exportEntity;
exports.entityCustomValues = entityCustomValues;
exports.registerEntityChannels = registerEntityChannels;
/**
 * The generic entity family (§C.2): one metadata-driven implementation for 22
 * record types, so no list screen needs bespoke SQL.
 *
 * Safety comes from three rules:
 *   - the table name comes from the `ENTITIES` registry, never from the caller;
 *   - every column name is checked against `PRAGMA table_info` before it is
 *     interpolated, and every *value* is a bound parameter;
 *   - a hard delete is refused once the record has audit history (BR-22), and
 *     the caller is told to disable/archive it instead.
 */
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
const XLSX = __importStar(require("xlsx"));
const dates_1 = require("../shared/dates");
const permissions_1 = require("../shared/permissions");
const types_1 = require("../shared/types");
const connection_1 = require("./db/connection");
const errors_1 = require("./errors");
const log_1 = require("./log");
const auditLog = __importStar(require("./services/audit"));
const settings_1 = require("./services/settings");
/**
 * Columns that must never cross the IPC boundary. `users` is reachable through
 * the generic family for list/detail, so the hash material is stripped here — the
 * renderer has no business seeing it and cannot help leaking it.
 */
const REDACTED = {
    users: ['password_hash', 'password_salt', 'password_algo'],
};
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
function columnsOf(table) {
    return (0, connection_1.conn)().all(`PRAGMA table_info(${quoteIdentifier(table)})`);
}
/** Double-quotes an identifier. Only ever called with registry/PRAGMA names. */
function quoteIdentifier(name) {
    return `"${name.replace(/"/g, '""')}"`;
}
function requireEntity(value) {
    if (typeof value !== 'string' || !(0, types_1.isEntityName)(value)) {
        throw (0, errors_1.validation)('entity', 'That is not a record type this build knows about.');
    }
    return value;
}
/** Drops redacted columns from a row. */
function redact(entity, row) {
    const hidden = REDACTED[entity];
    if (!hidden)
        return row;
    const out = { ...row };
    for (const column of hidden)
        delete out[column];
    return out;
}
function tableOf(entity) {
    return types_1.ENTITIES[entity].table;
}
function assertColumn(columns, key) {
    const match = columns.find((column) => column.name === key);
    if (!match)
        throw (0, errors_1.validation)(key, `"${key}" is not a field of this record.`);
    return match.name;
}
function hasColumn(columns, key) {
    return columns.some((column) => column.name === key);
}
// ── list ─────────────────────────────────────────────────────────────────────
function listEntity(entity, query) {
    const table = tableOf(entity);
    const columns = columnsOf(table);
    const where = [];
    const params = [];
    if (hasColumn(columns, 'deleted_at'))
        where.push('deleted_at IS NULL');
    for (const [key, value] of Object.entries(query.filters ?? {})) {
        const column = assertColumn(columns, key);
        if (value === null) {
            where.push(`${quoteIdentifier(column)} IS NULL`);
            continue;
        }
        where.push(`${quoteIdentifier(column)} = ?`);
        params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (query.q && query.q.trim().length > 0) {
        const term = `%${query.q.trim().toLowerCase()}%`;
        const textColumns = columns
            .filter((column) => /TEXT/i.test(column.type) && column.name !== 'id')
            .map((column) => column.name);
        if (textColumns.length > 0) {
            where.push(`(${textColumns.map((column) => `LOWER(${quoteIdentifier(column)}) LIKE ?`).join(' OR ')})`);
            for (let index = 0; index < textColumns.length; index += 1)
                params.push(term);
        }
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = (0, connection_1.conn)().one(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)} ${clause}`, params);
    const sortColumn = query.sort ? assertColumn(columns, query.sort.key) : 'rowid';
    const direction = query.sort?.dir === 'asc' ? 'ASC' : 'DESC';
    const orderBy = sortColumn === 'rowid' ? 'rowid DESC' : `${quoteIdentifier(sortColumn)} ${direction}`;
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
    const rows = (0, connection_1.conn)().all(`SELECT * FROM ${quoteIdentifier(table)} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { rows: rows.map((row) => redact(entity, row)), total: Number(totalRow?.total ?? 0) };
}
// ── get ──────────────────────────────────────────────────────────────────────
function getEntity(entity, id) {
    const table = tableOf(entity);
    const pk = primaryKeyOf(tableOf(entity));
    const row = (0, connection_1.conn)().one(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(pk)} = ?`, [id]);
    if (!row)
        throw (0, errors_1.notFound)(types_1.ENTITIES[entity].label);
    return redact(entity, row);
}
/**
 * The table's real primary key.
 *
 * Almost every table is keyed by `id`, but `currencies` is keyed by `code` — it is
 * a natural key, because a currency *is* its ISO code and there is nothing to
 * invent. Hardcoding `id` here made `entity.save {entity:'currencies'}` fail with
 * "table currencies has no column named id", so adding a currency was impossible
 * even though the entity is registered writable under `settings.currency.manage`.
 */
function primaryKeyOf(table) {
    const columns = columnsOf(table);
    return columns.find((column) => Number(column.pk) === 1)?.name ?? 'id';
}
/**
 * Creates or updates one row. `values` keys are **column names** (`base_price_cents`,
 * `is_active`), which keeps the mapping obvious and auditable.
 */
function saveEntity(input) {
    const table = tableOf(input.entity);
    const columns = columnsOf(table);
    const at = (0, dates_1.nowIso)();
    const pk = primaryKeyOf(table);
    // The key comes from `input.id` for the `id`-keyed family, and from the values
    // themselves for a natural key such as `currencies.code`.
    const suppliedKey = input.values[pk];
    const key = input.id ??
        (pk !== 'id' && (typeof suppliedKey === 'string' || typeof suppliedKey === 'number')
            ? String(suppliedKey)
            : (0, node_crypto_1.randomUUID)());
    if (input.custom)
        (0, settings_1.validateCustomValues)(input.entity, input.custom, { partial: Boolean(input.id) });
    // A role's permission list is the one column that must be checked by name:
    // storing an unknown key would silently grant nothing and confuse the editor.
    const permissionsJson = input.values['permissions_json'];
    if (input.entity === 'roles' && typeof permissionsJson === 'string') {
        let parsed;
        try {
            parsed = JSON.parse(permissionsJson);
        }
        catch {
            throw (0, errors_1.validation)('permissions', 'That permission list is not valid JSON.');
        }
        if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string' || !(0, permissions_1.isPermission)(entry))) {
            throw (0, errors_1.validation)('permissions', 'One of those permissions does not exist in this build.');
        }
    }
    // The generic family must not be a back door into credential columns.
    for (const column of REDACTED[input.entity] ?? []) {
        if (Object.prototype.hasOwnProperty.call(input.values, column)) {
            throw (0, errors_1.validation)(column, 'That field cannot be set here.');
        }
    }
    const assignments = [];
    const values = [];
    for (const [columnName, raw] of Object.entries(input.values)) {
        if (columnName === pk)
            continue;
        const column = assertColumn(columns, columnName);
        assignments.push(`${quoteIdentifier(column)} = ?`);
        values.push(coerce(raw, columnName));
    }
    // `input.id` is the usual "update this row" signal. A natural key carries its
    // identity in the values instead (`currencies.code`), so the same save is an
    // update when that row already exists and an insert when it does not.
    const updating = Boolean(input.id) || (pk !== 'id' && suppliedKey !== undefined && suppliedKey !== null);
    if (updating) {
        const existing = (0, connection_1.conn)().one(`SELECT ${quoteIdentifier(pk)} FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(pk)} = ?`, [key]);
        if (!existing && input.id)
            throw (0, errors_1.notFound)(types_1.ENTITIES[input.entity].label);
        if (!existing) {
            // Fall through to the insert below.
        }
        else {
            if (assignments.length === 0)
                return getEntity(input.entity, key);
            if (hasColumn(columns, 'updated_at')) {
                assignments.push(`${quoteIdentifier('updated_at')} = ?`);
                values.push(at);
            }
            (0, connection_1.conn)().run(`UPDATE ${quoteIdentifier(table)} SET ${assignments.join(', ')} WHERE ${quoteIdentifier(pk)} = ?`, [...values, key]);
            if (input.custom)
                (0, settings_1.setCustomValues)(input.entity, key, input.custom);
            return getEntity(input.entity, key);
        }
    }
    // Insert: every NOT NULL column without a default must be supplied.
    const missing = columns
        .filter((column) => Number(column.notnull) === 1 && column.dflt_value === null && Number(column.pk) === 0)
        .map((column) => column.name)
        .filter((name) => name !== 'created_at' && name !== 'updated_at' && !assignments.some((entry) => entry.startsWith(quoteIdentifier(name))));
    if (missing.length > 0) {
        throw (0, errors_1.validation)(missing[0] ?? 'values', `"${missing[0] ?? 'value'}" is required.`);
    }
    const insertColumns = [pk, ...Object.keys(input.values).filter((name) => name !== pk)];
    const insertValues = [key, ...values];
    if (hasColumn(columns, 'created_at')) {
        insertColumns.push('created_at');
        insertValues.push(at);
    }
    if (hasColumn(columns, 'updated_at')) {
        insertColumns.push('updated_at');
        insertValues.push(at);
    }
    (0, connection_1.conn)().run(`INSERT INTO ${quoteIdentifier(table)} (${insertColumns.map(quoteIdentifier).join(', ')})
     VALUES (${insertColumns.map(() => '?').join(', ')})`, insertValues);
    if (input.custom)
        (0, settings_1.setCustomValues)(input.entity, key, input.custom);
    return getEntity(input.entity, key);
}
/** Booleans become 0/1; everything else passes through to the driver. */
function coerce(raw, key) {
    if (raw === null || raw === undefined)
        return null;
    if (typeof raw === 'boolean')
        return raw ? 1 : 0;
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw))
            throw (0, errors_1.validation)(key, 'That number is not valid.');
        return raw;
    }
    if (typeof raw === 'string')
        return raw;
    throw (0, errors_1.validation)(key, 'That value cannot be stored.');
}
// ── archive / delete ─────────────────────────────────────────────────────────
/** Soft-deletes when the table supports it, otherwise deactivates. */
function archiveEntity(entity, id, reason) {
    const table = tableOf(entity);
    const columns = columnsOf(table);
    const existing = (0, connection_1.conn)().one(`SELECT id FROM ${quoteIdentifier(table)} WHERE id = ?`, [id]);
    if (!existing)
        throw (0, errors_1.notFound)(types_1.ENTITIES[entity].label);
    const at = (0, dates_1.nowIso)();
    if (hasColumn(columns, 'deleted_at')) {
        if (hasColumn(columns, 'updated_at')) {
            (0, connection_1.conn)().run(`UPDATE ${quoteIdentifier(table)} SET deleted_at = ?, updated_at = ? WHERE id = ?`, [at, at, id]);
        }
        else {
            (0, connection_1.conn)().run(`UPDATE ${quoteIdentifier(table)} SET deleted_at = ? WHERE id = ?`, [at, id]);
        }
    }
    else if (hasColumn(columns, 'is_active')) {
        (0, connection_1.conn)().run(`UPDATE ${quoteIdentifier(table)} SET is_active = 0 WHERE id = ?`, [id]);
    }
    else if (hasColumn(columns, 'is_archived')) {
        (0, connection_1.conn)().run(`UPDATE ${quoteIdentifier(table)} SET is_archived = 1 WHERE id = ?`, [id]);
    }
    else {
        throw (0, errors_1.conflict)('This record type cannot be archived — delete it instead.');
    }
    void reason;
    return { id };
}
/**
 * The inverse of `archiveEntity`, and the only reason an "Undo" button on a
 * toast is honest: archiving is a flag, so clearing the flag is a real restore
 * rather than a lie that hides the row until the next refresh.
 */
function restoreEntity(entity, id) {
    const table = tableOf(entity);
    const columns = columnsOf(table);
    const existing = (0, connection_1.conn)().one(`SELECT id FROM ${quoteIdentifier(table)} WHERE id = ?`, [id]);
    if (!existing)
        throw (0, errors_1.notFound)(types_1.ENTITIES[entity].label);
    if (hasColumn(columns, 'deleted_at')) {
        const at = (0, dates_1.nowIso)();
        if (hasColumn(columns, 'updated_at')) {
            (0, connection_1.conn)().run(`UPDATE ${quoteIdentifier(table)} SET deleted_at = NULL, updated_at = ? WHERE id = ?`, [at, id]);
        }
        else {
            (0, connection_1.conn)().run(`UPDATE ${quoteIdentifier(table)} SET deleted_at = NULL WHERE id = ?`, [id]);
        }
    }
    else if (hasColumn(columns, 'is_active')) {
        (0, connection_1.conn)().run(`UPDATE ${quoteIdentifier(table)} SET is_active = 1 WHERE id = ?`, [id]);
    }
    else if (hasColumn(columns, 'is_archived')) {
        (0, connection_1.conn)().run(`UPDATE ${quoteIdentifier(table)} SET is_archived = 0 WHERE id = ?`, [id]);
    }
    else {
        throw (0, errors_1.conflict)('This record type cannot be archived, so there is nothing to restore.');
    }
    return { id };
}
/**
 * Hard delete, only for records with no audit history. Anything with history is
 * refused with a pointer to archive/disable (BR-22, US-08).
 */
function deleteEntity(entity, id) {
    const table = tableOf(entity);
    const existing = (0, connection_1.conn)().one(`SELECT id FROM ${quoteIdentifier(table)} WHERE id = ?`, [id]);
    if (!existing)
        throw (0, errors_1.notFound)(types_1.ENTITIES[entity].label);
    const history = auditLog.countForEntity(entity, id);
    if (history > 0) {
        throw (0, errors_1.conflict)(`This record has ${String(history)} history entr${history === 1 ? 'y' : 'ies'} and cannot be deleted. Archive it instead.`);
    }
    (0, connection_1.conn)().run(`DELETE FROM ${quoteIdentifier(table)} WHERE id = ?`, [id]);
    return { id };
}
/**
 * Writes the filtered rows to `%APPDATA%/nexus/exports` and returns the path.
 * Export is a main-process job: the renderer never receives a file handle.
 */
function exportEntity(input) {
    const { rows } = listEntity(input.entity, { ...input, limit: MAX_LIMIT, offset: 0 });
    const columns = input.columns && input.columns.length > 0
        ? [...input.columns]
        : rows.length > 0
            ? Object.keys(rows[0] ?? {})
            : [];
    const matrix = [
        columns,
        ...rows.map((row) => columns.map((column) => row[column] ?? '')),
    ];
    const sheet = XLSX.utils.aoa_to_sheet(matrix);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, input.entity.slice(0, 31));
    const directory = node_path_1.default.join(electron_1.app.getPath('userData'), 'exports');
    (0, node_fs_1.mkdirSync)(directory, { recursive: true });
    const stamp = (0, dates_1.nowIso)().replace(/[:.]/g, '-');
    const file = node_path_1.default.join(directory, `${input.entity}-${stamp}.${input.format}`);
    let bytes = 0;
    try {
        if (input.format === 'csv') {
            const csv = XLSX.utils.sheet_to_csv(sheet);
            (0, node_fs_1.writeFileSync)(file, csv, 'utf8');
            bytes = Buffer.byteLength(csv, 'utf8');
        }
        else {
            const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
            (0, node_fs_1.writeFileSync)(file, buffer);
            bytes = buffer.byteLength;
        }
    }
    catch (error) {
        (0, log_1.logError)('entity.export', error, { entity: input.entity });
        throw (0, errors_1.conflict)('The export could not be written. Check that the folder is writable and try again.');
    }
    return { path: file, bytes };
}
/** Custom values for one record, so a detail form can render them. */
function entityCustomValues(entity, id) {
    return (0, settings_1.getCustomValues)(entity, id);
}
/** Registers `entity.list|get|save|archive|delete|export`. */
function registerEntityChannels(register) {
    register({
        channel: 'entity.list',
        handler: (payload) => listEntity(requireEntity(payload.entity), payload),
    });
    register({
        channel: 'entity.get',
        handler: (payload) => ({
            ...getEntity(requireEntity(payload.entity), payload.id),
            custom: entityCustomValues(requireEntity(payload.entity), payload.id),
        }),
    });
    register({
        channel: 'entity.save',
        handler: (payload) => saveEntity({
            entity: requireEntity(payload.entity),
            id: payload.id,
            values: payload.values,
            custom: payload.custom,
        }),
    });
    register({
        channel: 'entity.archive',
        handler: (payload) => archiveEntity(requireEntity(payload.entity), payload.id, payload.reason),
    });
    register({
        channel: 'entity.delete',
        handler: (payload) => deleteEntity(requireEntity(payload.entity), payload.id),
    });
    register({
        channel: 'entity.restore',
        handler: (payload) => restoreEntity(requireEntity(payload.entity), payload.id),
    });
    register({
        channel: 'entity.export',
        handler: (payload) => exportEntity({ ...payload, entity: requireEntity(payload.entity) }),
    });
}
//# sourceMappingURL=ipc.entity.js.map