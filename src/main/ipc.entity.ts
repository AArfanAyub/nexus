/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

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

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import * as XLSX from 'xlsx';

import { nowIso } from '../shared/dates';
import { isPermission } from '../shared/permissions';
import { ENTITIES, isEntityName, type EntityName, type ListQuery, type Paged } from '../shared/types';
import { conn } from './db/connection';
import { conflict, notFound, validation } from './errors';
import type { RegisterFn } from './ipc';
import { logError } from './log';
import * as auditLog from './services/audit';
import { getCustomValues, setCustomValues, validateCustomValues } from './services/settings';

type Row = Record<string, unknown>;

/**
 * Columns that must never cross the IPC boundary. `users` is reachable through
 * the generic family for list/detail, so the hash material is stripped here — the
 * renderer has no business seeing it and cannot help leaking it.
 */
const REDACTED: Readonly<Record<string, readonly string[]>> = {
  users: ['password_hash', 'password_salt', 'password_algo'],
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

function columnsOf(table: string): readonly ColumnInfo[] {
  return conn().all<ColumnInfo>(`PRAGMA table_info(${quoteIdentifier(table)})`);
}

/** Double-quotes an identifier. Only ever called with registry/PRAGMA names. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function requireEntity(value: unknown): EntityName {
  if (typeof value !== 'string' || !isEntityName(value)) {
    throw validation('entity', 'That is not a record type this build knows about.');
  }
  return value;
}

/** Drops redacted columns from a row. */
function redact(entity: EntityName, row: Row): Row {
  const hidden = REDACTED[entity];
  if (!hidden) return row;
  const out: Row = { ...row };
  for (const column of hidden) delete out[column];
  return out;
}

function tableOf(entity: EntityName): string {
  return ENTITIES[entity].table;
}

function assertColumn(columns: readonly ColumnInfo[], key: string): string {
  const match = columns.find((column) => column.name === key);
  if (!match) throw validation(key, `"${key}" is not a field of this record.`);
  return match.name;
}

function hasColumn(columns: readonly ColumnInfo[], key: string): boolean {
  return columns.some((column) => column.name === key);
}

// ── list ─────────────────────────────────────────────────────────────────────

export function listEntity(entity: EntityName, query: ListQuery): Paged<Row> {
  const table = tableOf(entity);
  const columns = columnsOf(table);
  const where: string[] = [];
  const params: (string | number | null)[] = [];

  if (hasColumn(columns, 'deleted_at')) where.push('deleted_at IS NULL');

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
      for (let index = 0; index < textColumns.length; index += 1) params.push(term);
    }
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = conn().one<{ total: number }>(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)} ${clause}`, params);

  const sortColumn = query.sort ? assertColumn(columns, query.sort.key) : 'rowid';
  const direction = query.sort?.dir === 'asc' ? 'ASC' : 'DESC';
  const orderBy = sortColumn === 'rowid' ? 'rowid DESC' : `${quoteIdentifier(sortColumn)} ${direction}`;

  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);

  const rows = conn().all<Row>(
    `SELECT * FROM ${quoteIdentifier(table)} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return { rows: rows.map((row) => redact(entity, row)), total: Number(totalRow?.total ?? 0) };
}

// ── get ──────────────────────────────────────────────────────────────────────

export function getEntity(entity: EntityName, id: string): Row {
  const table = tableOf(entity);
  const pk = primaryKeyOf(tableOf(entity));
  const row = conn().one<Row>(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(pk)} = ?`, [id]);
  if (!row) throw notFound(ENTITIES[entity].label);
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
function primaryKeyOf(table: string): string {
  const columns = columnsOf(table);
  return columns.find((column) => Number(column.pk) === 1)?.name ?? 'id';
}

// ── save ─────────────────────────────────────────────────────────────────────

export interface SaveEntityInput {
  readonly entity: EntityName;
  readonly id?: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly custom?: Readonly<Record<string, unknown>>;
}

/**
 * Creates or updates one row. `values` keys are **column names** (`base_price_cents`,
 * `is_active`), which keeps the mapping obvious and auditable.
 */
export function saveEntity(input: SaveEntityInput): Row {
  const table = tableOf(input.entity);
  const columns = columnsOf(table);
  const at = nowIso();
  const pk = primaryKeyOf(table);
  // The key comes from `input.id` for the `id`-keyed family, and from the values
  // themselves for a natural key such as `currencies.code`.
  const suppliedKey = input.values[pk];
  const key =
    input.id ??
    (pk !== 'id' && (typeof suppliedKey === 'string' || typeof suppliedKey === 'number')
      ? String(suppliedKey)
      : randomUUID());

  if (input.custom) validateCustomValues(input.entity, input.custom, { partial: Boolean(input.id) });

  // A role's permission list is the one column that must be checked by name:
  // storing an unknown key would silently grant nothing and confuse the editor.
  const permissionsJson = input.values['permissions_json'];
  if (input.entity === 'roles' && typeof permissionsJson === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(permissionsJson);
    } catch {
      throw validation('permissions', 'That permission list is not valid JSON.');
    }
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string' || !isPermission(entry))) {
      throw validation('permissions', 'One of those permissions does not exist in this build.');
    }
  }

  // The generic family must not be a back door into credential columns.
  for (const column of REDACTED[input.entity] ?? []) {
    if (Object.prototype.hasOwnProperty.call(input.values, column)) {
      throw validation(column, 'That field cannot be set here.');
    }
  }

  const assignments: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [columnName, raw] of Object.entries(input.values)) {
    if (columnName === pk) continue;
    const column = assertColumn(columns, columnName);
    assignments.push(`${quoteIdentifier(column)} = ?`);
    values.push(coerce(raw, columnName));
  }

  // `input.id` is the usual "update this row" signal. A natural key carries its
  // identity in the values instead (`currencies.code`), so the same save is an
  // update when that row already exists and an insert when it does not.
  const updating = Boolean(input.id) || (pk !== 'id' && suppliedKey !== undefined && suppliedKey !== null);

  if (updating) {
    const existing = conn().one<Row>(
      `SELECT ${quoteIdentifier(pk)} FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(pk)} = ?`,
      [key],
    );
    if (!existing && input.id) throw notFound(ENTITIES[input.entity].label);
    if (!existing) {
      // Fall through to the insert below.
    } else {
      if (assignments.length === 0) return getEntity(input.entity, key);

      if (hasColumn(columns, 'updated_at')) {
        assignments.push(`${quoteIdentifier('updated_at')} = ?`);
        values.push(at);
      }
      conn().run(
        `UPDATE ${quoteIdentifier(table)} SET ${assignments.join(', ')} WHERE ${quoteIdentifier(pk)} = ?`,
        [...values, key],
      );
      if (input.custom) setCustomValues(input.entity, key, input.custom);
      return getEntity(input.entity, key);
    }
  }

  // Insert: every NOT NULL column without a default must be supplied.
  const missing = columns
    .filter((column) => Number(column.notnull) === 1 && column.dflt_value === null && Number(column.pk) === 0)
    .map((column) => column.name)
    .filter((name) => name !== 'created_at' && name !== 'updated_at' && !assignments.some((entry) => entry.startsWith(quoteIdentifier(name))));
  if (missing.length > 0) {
    throw validation(missing[0] ?? 'values', `"${missing[0] ?? 'value'}" is required.`);
  }

  const insertColumns = [pk, ...Object.keys(input.values).filter((name) => name !== pk)];
  const insertValues: (string | number | null)[] = [key, ...values];
  if (hasColumn(columns, 'created_at')) {
    insertColumns.push('created_at');
    insertValues.push(at);
  }
  if (hasColumn(columns, 'updated_at')) {
    insertColumns.push('updated_at');
    insertValues.push(at);
  }

  conn().run(
    `INSERT INTO ${quoteIdentifier(table)} (${insertColumns.map(quoteIdentifier).join(', ')})
     VALUES (${insertColumns.map(() => '?').join(', ')})`,
    insertValues,
  );
  if (input.custom) setCustomValues(input.entity, key, input.custom);
  return getEntity(input.entity, key);
}

/** Booleans become 0/1; everything else passes through to the driver. */
function coerce(raw: unknown, key: string): string | number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw validation(key, 'That number is not valid.');
    return raw;
  }
  if (typeof raw === 'string') return raw;
  throw validation(key, 'That value cannot be stored.');
}

// ── archive / delete ─────────────────────────────────────────────────────────

/** Soft-deletes when the table supports it, otherwise deactivates. */
export function archiveEntity(entity: EntityName, id: string, reason?: string): { readonly id: string } {
  const table = tableOf(entity);
  const columns = columnsOf(table);
  const existing = conn().one<Row>(`SELECT id FROM ${quoteIdentifier(table)} WHERE id = ?`, [id]);
  if (!existing) throw notFound(ENTITIES[entity].label);

  const at = nowIso();
  if (hasColumn(columns, 'deleted_at')) {
    if (hasColumn(columns, 'updated_at')) {
      conn().run(`UPDATE ${quoteIdentifier(table)} SET deleted_at = ?, updated_at = ? WHERE id = ?`, [at, at, id]);
    } else {
      conn().run(`UPDATE ${quoteIdentifier(table)} SET deleted_at = ? WHERE id = ?`, [at, id]);
    }
  } else if (hasColumn(columns, 'is_active')) {
    conn().run(`UPDATE ${quoteIdentifier(table)} SET is_active = 0 WHERE id = ?`, [id]);
  } else if (hasColumn(columns, 'is_archived')) {
    conn().run(`UPDATE ${quoteIdentifier(table)} SET is_archived = 1 WHERE id = ?`, [id]);
  } else {
    throw conflict('This record type cannot be archived — delete it instead.');
  }
  void reason;
  return { id };
}

/**
 * The inverse of `archiveEntity`, and the only reason an "Undo" button on a
 * toast is honest: archiving is a flag, so clearing the flag is a real restore
 * rather than a lie that hides the row until the next refresh.
 */
export function restoreEntity(entity: EntityName, id: string): { readonly id: string } {
  const table = tableOf(entity);
  const columns = columnsOf(table);
  const existing = conn().one<Row>(`SELECT id FROM ${quoteIdentifier(table)} WHERE id = ?`, [id]);
  if (!existing) throw notFound(ENTITIES[entity].label);

  if (hasColumn(columns, 'deleted_at')) {
    const at = nowIso();
    if (hasColumn(columns, 'updated_at')) {
      conn().run(`UPDATE ${quoteIdentifier(table)} SET deleted_at = NULL, updated_at = ? WHERE id = ?`, [at, id]);
    } else {
      conn().run(`UPDATE ${quoteIdentifier(table)} SET deleted_at = NULL WHERE id = ?`, [id]);
    }
  } else if (hasColumn(columns, 'is_active')) {
    conn().run(`UPDATE ${quoteIdentifier(table)} SET is_active = 1 WHERE id = ?`, [id]);
  } else if (hasColumn(columns, 'is_archived')) {
    conn().run(`UPDATE ${quoteIdentifier(table)} SET is_archived = 0 WHERE id = ?`, [id]);
  } else {
    throw conflict('This record type cannot be archived, so there is nothing to restore.');
  }
  return { id };
}

/**
 * Hard delete, only for records with no audit history. Anything with history is
 * refused with a pointer to archive/disable (BR-22, US-08).
 */
export function deleteEntity(entity: EntityName, id: string): { readonly id: string } {
  const table = tableOf(entity);
  const existing = conn().one<Row>(`SELECT id FROM ${quoteIdentifier(table)} WHERE id = ?`, [id]);
  if (!existing) throw notFound(ENTITIES[entity].label);

  const history = auditLog.countForEntity(entity, id);
  if (history > 0) {
    throw conflict(
      `This record has ${String(history)} history entr${history === 1 ? 'y' : 'ies'} and cannot be deleted. Archive it instead.`,
    );
  }
  conn().run(`DELETE FROM ${quoteIdentifier(table)} WHERE id = ?`, [id]);
  return { id };
}

// ── export ───────────────────────────────────────────────────────────────────

export interface ExportInput extends ListQuery {
  readonly entity: EntityName;
  readonly format: 'csv' | 'xlsx';
  readonly columns?: readonly string[];
}

/**
 * Writes the filtered rows to `%APPDATA%/nexus/exports` and returns the path.
 * Export is a main-process job: the renderer never receives a file handle.
 */
export function exportEntity(input: ExportInput): { readonly path: string; readonly bytes: number } {
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

  const directory = path.join(app.getPath('userData'), 'exports');
  mkdirSync(directory, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, '-');
  const file = path.join(directory, `${input.entity}-${stamp}.${input.format}`);

  let bytes = 0;
  try {
    if (input.format === 'csv') {
      const csv = XLSX.utils.sheet_to_csv(sheet);
      writeFileSync(file, csv, 'utf8');
      bytes = Buffer.byteLength(csv, 'utf8');
    } else {
      const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      writeFileSync(file, buffer);
      bytes = buffer.byteLength;
    }
  } catch (error) {
    logError('entity.export', error, { entity: input.entity });
    throw conflict('The export could not be written. Check that the folder is writable and try again.');
  }

  return { path: file, bytes };
}

/** Custom values for one record, so a detail form can render them. */
export function entityCustomValues(entity: EntityName, id: string): Record<string, unknown> {
  return getCustomValues(entity, id);
}

// ── registration ─────────────────────────────────────────────────────────────

interface EntityListPayload extends ListQuery {
  readonly entity: string;
}
interface EntityGetPayload {
  readonly entity: string;
  readonly id: string;
}

/** Registers `entity.list|get|save|archive|delete|export`. */
export function registerEntityChannels(register: RegisterFn): void {
  register<EntityListPayload, Paged<Row>>({
    channel: 'entity.list',
    handler: (payload) => listEntity(requireEntity(payload.entity), payload),
  });

  register<EntityGetPayload, Row>({
    channel: 'entity.get',
    handler: (payload) => ({
      ...getEntity(requireEntity(payload.entity), payload.id),
      custom: entityCustomValues(requireEntity(payload.entity), payload.id),
    }),
  });

  register<{ entity: string; id?: string; values: Row; custom?: Row }, Row>({
    channel: 'entity.save',
    handler: (payload) =>
      saveEntity({
        entity: requireEntity(payload.entity),
        id: payload.id,
        values: payload.values,
        custom: payload.custom,
      }),
  });

  register<{ entity: string; id: string; reason?: string }, { id: string }>({
    channel: 'entity.archive',
    handler: (payload) => archiveEntity(requireEntity(payload.entity), payload.id, payload.reason),
  });

  register<{ entity: string; id: string }, { id: string }>({
    channel: 'entity.delete',
    handler: (payload) => deleteEntity(requireEntity(payload.entity), payload.id),
  });

  register<{ entity: string; id: string }, { id: string }>({
    channel: 'entity.restore',
    handler: (payload) => restoreEntity(requireEntity(payload.entity), payload.id),
  });

  register<ExportInput, { path: string; bytes: number }>({
    channel: 'entity.export',
    handler: (payload) => exportEntity({ ...payload, entity: requireEntity(payload.entity) }),
  });
}
