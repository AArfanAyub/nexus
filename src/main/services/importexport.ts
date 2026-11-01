/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The import wizard's engine (T10).
 *
 * Four stages, four calls, one batch id:
 *
 *   parse    read the file, guess a mapping, keep the rows in `import_batches`
 *   validate coerce and check every row, persist the valid set + the errors
 *   commit   insert only the valid rows, in batches, reporting progress
 *   template a correctly-headed file so the guess is never needed
 *
 * ## Why the rows are staged in the database rather than in memory
 *
 * A 10 000-row sheet is ~2 MB of JSON. Keeping it in a module-level variable
 * would make the wizard fragile across a window reload and would leak between
 * two operators importing at once. `import_batches.staged_json` survives both.
 *
 * ## Why `validate` and `commit` are separate
 *
 * Because the operator must see the rejection report **before** anything is
 * written. The summary is the product: "197 of 200 will be created, 3 rows have
 * no code" is what makes an import trustworthy. `commit` therefore consumes the
 * set `validate` persisted — it never re-reads the file, so what you approved is
 * exactly what is inserted.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as XLSX from 'xlsx';

import type {
  ImportColumn,
  ImportCommitResult,
  ImportEntity,
  ImportParseResult,
  ImportProgress,
  ImportRowError,
  ImportValidationReport,
} from '../../shared/admin';
import { nowIso } from '../../shared/dates';
import { atomically, conn } from '../db/connection';
import { conflict, notFound, validation } from '../errors';
import * as auditLog from './audit';

// ── field specifications ────────────────────────────────────────────────────

type FieldType = 'text' | 'money' | 'int' | 'bool' | 'date' | 'enum';

interface FieldSpec {
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required?: boolean;
  readonly values?: readonly string[];
  /** Column on the table that must be unique, and the message when it is not. */
  readonly unique?: string;
  /** For fields that name another record instead of holding an id. */
  readonly resolvesTo?: { readonly table: string; readonly column: string; readonly fk: string };
}

/**
 * The fields the wizard offers, per entity.
 *
 * Deliberately narrower than the table: an import should create the record, not
 * configure it. Anything exotic (custom fields, credit terms) is easier to set
 * on the record afterwards than to get right in a spreadsheet.
 */
const FIELDS: Readonly<Record<ImportEntity, readonly FieldSpec[]>> = {
  customers: [
    { key: 'code', label: 'Code', type: 'text', required: true, unique: 'code' },
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'text' },
    { key: 'phone', label: 'Phone', type: 'text' },
    { key: 'payment_terms_days', label: 'Payment terms (days)', type: 'int' },
    { key: 'credit_limit_cents', label: 'Credit limit', type: 'money' },
    { key: 'currency', label: 'Currency', type: 'text' },
  ],
  vendors: [
    { key: 'code', label: 'Code', type: 'text', required: true, unique: 'code' },
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'text' },
    { key: 'phone', label: 'Phone', type: 'text' },
    { key: 'payment_terms_days', label: 'Payment terms (days)', type: 'int' },
    { key: 'currency', label: 'Currency', type: 'text' },
  ],
  products: [
    { key: 'sku', label: 'SKU', type: 'text', required: true, unique: 'sku' },
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'uom', label: 'Unit', type: 'text' },
    { key: 'cost_method', label: 'Cost method', type: 'enum', values: ['fifo', 'avco', 'standard'] },
    { key: 'base_price_cents', label: 'Sale price', type: 'money' },
    { key: 'standard_cost_cents', label: 'Cost', type: 'money' },
    { key: 'reorder_point_milli', label: 'Reorder point (units)', type: 'int' },
  ],
  crmAccounts: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'industry', label: 'Industry', type: 'text' },
    { key: 'domain', label: 'Domain', type: 'text' },
    { key: 'phone', label: 'Phone', type: 'text' },
    { key: 'email', label: 'Email', type: 'text' },
    { key: 'health', label: 'Health', type: 'enum', values: ['green', 'amber', 'red'] },
  ],
  contacts: [
    { key: 'first_name', label: 'First name', type: 'text', required: true },
    { key: 'last_name', label: 'Last name', type: 'text' },
    { key: 'email', label: 'Email', type: 'text' },
    { key: 'phone', label: 'Phone', type: 'text' },
    { key: 'title', label: 'Job title', type: 'text' },
    {
      key: 'account_name',
      label: 'Account',
      type: 'text',
      required: true,
      resolvesTo: { table: 'crm_accounts', column: 'name', fk: 'account_id' },
    },
  ],
  leads: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'company', label: 'Company', type: 'text' },
    { key: 'email', label: 'Email', type: 'text' },
    { key: 'phone', label: 'Phone', type: 'text' },
    { key: 'source', label: 'Source', type: 'text' },
    { key: 'status', label: 'Status', type: 'enum', values: ['new', 'contacted', 'qualified', 'converted', 'lost'] },
    { key: 'score', label: 'Score', type: 'int' },
    { key: 'estimated_value_cents', label: 'Estimated value', type: 'money' },
  ],
  deals: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'value_cents', label: 'Value', type: 'money' },
    { key: 'expected_close_date', label: 'Expected close', type: 'date' },
    {
      key: 'account_name',
      label: 'Account',
      type: 'text',
      resolvesTo: { table: 'crm_accounts', column: 'name', fk: 'account_id' },
    },
    {
      key: 'stage_name',
      label: 'Stage',
      type: 'text',
      resolvesTo: { table: 'deal_stages', column: 'name', fk: 'stage_id' },
    },
  ],
};

/** The table each entity writes to, and its natural key. */
const TABLES: Readonly<Record<ImportEntity, { readonly table: string; readonly naturalKey: string }>> = {
  customers: { table: 'customers', naturalKey: 'code' },
  vendors: { table: 'vendors', naturalKey: 'code' },
  products: { table: 'products', naturalKey: 'sku' },
  crmAccounts: { table: 'crm_accounts', naturalKey: 'name' },
  contacts: { table: 'contacts', naturalKey: 'email' },
  leads: { table: 'leads', naturalKey: 'email' },
  deals: { table: 'deals', naturalKey: 'name' },
};

export function isImportEntity(value: string): value is ImportEntity {
  return Object.prototype.hasOwnProperty.call(FIELDS, value);
}

export function importFields(entity: ImportEntity): readonly FieldSpec[] {
  return FIELDS[entity];
}

// ── coercion ────────────────────────────────────────────────────────────────

/** `"1,234.56"`, `"$1234.56"`, `"1234"` → cents. Returns `null` when unparseable. */
export function parseMoneyToCents(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function parseBool(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'n', 'off', ''].includes(value)) return false;
  return null;
}

/** Accepts `YYYY-MM-DD`, `DD/MM/YYYY` and anything `Date` can read unambiguously. */
function parseDateOnly(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const dmy = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(value);
  if (dmy) {
    const day = String(dmy[1]).padStart(2, '0');
    const month = String(dmy[2]).padStart(2, '0');
    return `${dmy[3]}-${month}-${day}`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

interface Coerced {
  readonly value: string | number | null;
  readonly error: string | null;
}

function coerce(spec: FieldSpec, raw: string): Coerced {
  const value = raw.trim();
  if (value === '') {
    return spec.required === true ? { value: null, error: `${spec.label} is required.` } : { value: null, error: null };
  }
  switch (spec.type) {
    case 'money': {
      const cents = parseMoneyToCents(value);
      return cents === null
        ? { value: null, error: `${spec.label} is not an amount ("${value}").` }
        : { value: cents, error: null };
    }
    case 'int': {
      const number = Number(value.replace(/,/g, ''));
      return Number.isFinite(number) && Number.isInteger(number)
        ? { value: number, error: null }
        : { value: null, error: `${spec.label} is not a whole number ("${value}").` };
    }
    case 'bool': {
      const bool = parseBool(value);
      return bool === null
        ? { value: null, error: `${spec.label} is not yes/no ("${value}").` }
        : { value: bool ? 1 : 0, error: null };
    }
    case 'date': {
      const date = parseDateOnly(value);
      return date === null ? { value: null, error: `${spec.label} is not a date ("${value}").` } : { value: date, error: null };
    }
    case 'enum': {
      const allowed = spec.values ?? [];
      if (!allowed.includes(value)) {
        return { value: null, error: `${spec.label} must be one of ${allowed.join(', ')} ("${value}").` };
      }
      return { value, error: null };
    }
    default:
      return { value, error: null };
  }
}

// ── header guessing ─────────────────────────────────────────────────────────

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/** Scores a header against a field: exact label, exact key, then prefix/contains. */
function confidenceOf(header: string, spec: FieldSpec): number {
  const h = normalise(header);
  const label = normalise(spec.label);
  const key = normalise(spec.key);
  if (h === label || h === key) return 100;
  if (h.length === 0) return 0;
  if (label.startsWith(h) || key.startsWith(h)) return 70;
  if (label.includes(h) || h.includes(label)) return 60;
  if (h.includes(key) || key.includes(h)) return 55;
  return 0;
}

/** Header → field, one field per header, best score first. */
export function guessMapping(entity: ImportEntity, headers: readonly string[]): Record<string, string> {
  const specs = FIELDS[entity];
  const taken = new Set<string>();
  const mapping: Record<string, string> = {};
  const scored: { header: string; key: string; score: number }[] = [];
  for (const header of headers) {
    for (const spec of specs) {
      const score = confidenceOf(header, spec);
      if (score > 0) scored.push({ header, key: spec.key, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  for (const candidate of scored) {
    if (taken.has(candidate.key) || mapping[candidate.header] !== undefined) continue;
    if (candidate.score < 55) continue;
    mapping[candidate.header] = candidate.key;
    taken.add(candidate.key);
  }
  return mapping;
}

// ── staged batch ────────────────────────────────────────────────────────────

interface StagedRow {
  readonly row: number;
  readonly values: Readonly<Record<string, string>>;
}

interface Staged {
  readonly rows: readonly StagedRow[];
  readonly headers: readonly string[];
  readonly filename: string;
  readonly mapping: Record<string, string>;
  /** Filled by `validate`. */
  validated?: {
    readonly valid: readonly { readonly row: number; readonly values: Record<string, string | number | null> }[];
    readonly errors: readonly ImportRowError[];
    readonly duplicates: number;
    readonly updateExisting: boolean;
  };
}

function readStaged(batchId: string): Staged {
  const row = conn().one<{ staged_json: string | null; entity: string }>(
    'SELECT staged_json, entity FROM import_batches WHERE id = ?',
    [batchId],
  );
  if (!row) throw notFound('Import batch');
  if (!row.staged_json) throw conflict('That import has no staged rows. Upload the file again.');
  return JSON.parse(row.staged_json) as Staged;
}

function writeStaged(batchId: string, staged: Staged): void {
  conn().run('UPDATE import_batches SET staged_json = ? WHERE id = ?', [JSON.stringify(staged), batchId]);
}

// ── parse ───────────────────────────────────────────────────────────────────

/**
 * Reads the file and stages it.
 *
 * `sheet_to_json` with `header: 1` gives arrays, which keeps a duplicate or blank
 * header from silently overwriting a column — the reader is given the raw matrix
 * and decides what a header is.
 */
export function parse(entity: ImportEntity, filePath: string): ImportParseResult {
  if (!isImportEntity(entity)) throw validation('entity', 'That is not something you can import.');

  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    throw conflict('That file could not be opened. Check that it still exists and is not open elsewhere.');
  }

  let matrix: unknown[][];
  try {
    const book = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: true });
    const sheetName = book.SheetNames[0];
    if (!sheetName) throw new Error('no sheets');
    const sheet = book.Sheets[sheetName];
    if (!sheet) throw new Error('no sheet');
    matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: '' });
  } catch {
    throw conflict('That file is not a readable CSV or XLSX.');
  }

  const headerRow = matrix[0];
  if (!headerRow || headerRow.length === 0) throw conflict('That file has no header row.');
  const headers = headerRow.map((cell) => String(cell ?? '').trim());

  const rows: StagedRow[] = [];
  const parseErrors: ImportRowError[] = [];
  for (let index = 1; index < matrix.length; index += 1) {
    const cells = matrix[index] ?? [];
    const values: Record<string, string> = {};
    let empty = true;
    headers.forEach((header, column) => {
      const cell = cells[column];
      const text = cell === null || cell === undefined ? '' : String(cell).trim();
      if (text !== '') empty = false;
      values[header] = text;
    });
    // Row numbers are 1-based and count the header, so they match the spreadsheet.
    if (empty) {
      parseErrors.push({ row: index + 1, column: null, reason: 'The row is empty.', value: null, kind: 'invalid' });
      continue;
    }
    rows.push({ row: index + 1, values });
  }

  const mapping = guessMapping(entity, headers);
  const columns: ImportColumn[] = headers.map((header) => ({
    header,
    field: mapping[header] ?? null,
    confidence: mapping[header] ? confidenceOf(header, FIELDS[entity].find((spec) => spec.key === mapping[header]) ?? FIELDS[entity][0]!) : 0,
    sample: rows.slice(0, 3).map((row) => row.values[header] ?? ''),
  }));

  const batchId = randomUUID();
  const staged: Staged = { rows, headers, filename: path.basename(filePath), mapping };
  conn().run(
    `INSERT INTO import_batches (id, entity, filename, mapping_json, total_rows, valid_rows, error_rows,
       status, staged_json, committed_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 'staged', ?, NULL, ?)`,
    [batchId, entity, path.basename(filePath), JSON.stringify(mapping), rows.length, JSON.stringify(staged), nowIso()],
  );

  return {
    batchId,
    entity,
    filename: path.basename(filePath),
    headers,
    columns,
    totalRows: rows.length,
    preview: rows.slice(0, 10).map((row) => row.values),
    parseErrors,
  };
}

// ── validate ────────────────────────────────────────────────────────────────

/**
 * Coerces and checks every staged row.
 *
 * Three kinds of rejection, reported separately because they need different
 * fixes: a missing required value, a value of the wrong type, and a row that is
 * already in the database. The third is only a rejection when `updateExisting`
 * is off — otherwise it is an update.
 */
export function validate(
  batchId: string,
  mapping: Readonly<Record<string, string>>,
  updateExisting = false,
): ImportValidationReport {
  const batchRow = conn().one<{ entity: string }>('SELECT entity FROM import_batches WHERE id = ?', [batchId]);
  if (!batchRow) throw notFound('Import batch');
  const entity = batchRow.entity as ImportEntity;
  const specs = FIELDS[entity];
  const table = TABLES[entity];

  const byField = new Map<string, string>();
  for (const [header, field] of Object.entries(mapping)) {
    if (field === '') continue;
    if (!specs.some((spec) => spec.key === field)) continue;
    byField.set(header, field);
  }
  const mapped = new Set(byField.values());
  const missingRequired = specs.filter((spec) => spec.required === true && !mapped.has(spec.key));
  if (missingRequired.length > 0) {
    throw validation(
      'mapping',
      `Map a column to ${missingRequired.map((spec) => spec.label).join(', ')} before validating.`,
    );
  }

  const staged = readStaged(batchId);
  const errors: ImportRowError[] = [];
  const valid: { row: number; values: Record<string, string | number | null> }[] = [];
  const seenKeys = new Set<string>();
  let duplicates = 0;

  const naturalSpec = specs.find((spec) => spec.key === table.naturalKey);

  for (const row of staged.rows) {
    const values: Record<string, string | number | null> = {};
    let rowFailed = false;

    for (const [header, field] of byField) {
      const spec = specs.find((entry) => entry.key === field);
      if (!spec) continue;
      const raw = row.values[header] ?? '';
      const result = coerce(spec, raw);
      if (result.error !== null) {
        errors.push({
          row: row.row,
          column: header,
          reason: result.error,
          value: raw,
          kind: spec.required === true && raw.trim() === '' ? 'required' : 'invalid',
        });
        rowFailed = true;
        continue;
      }
      values[spec.key] = result.value;

      if (spec.resolvesTo) {
        const name = String(result.value ?? '').trim();
        if (name !== '') {
          const target = conn().one<{ id: string }>(
            `SELECT id FROM ${spec.resolvesTo.table} WHERE ${spec.resolvesTo.column} = ? COLLATE NOCASE LIMIT 1`,
            [name],
          );
          if (!target) {
            errors.push({
              row: row.row,
              column: header,
              reason: `No ${spec.label.toLowerCase()} called "${name}".`,
              value: name,
              kind: 'invalid',
            });
            rowFailed = true;
          } else {
            values[spec.resolvesTo.fk] = target.id;
          }
        }
      }
    }

    if (rowFailed) continue;

    // Uniqueness, both inside the file and against the database.
    if (naturalSpec) {
      const key = String(values[naturalSpec.key] ?? '').trim().toLowerCase();
      if (key !== '') {
        if (seenKeys.has(key)) {
          duplicates += 1;
          errors.push({
            row: row.row,
            column: naturalSpec.label,
            reason: `"${String(values[naturalSpec.key])}" appears twice in this file.`,
            value: String(values[naturalSpec.key]),
            kind: 'duplicate',
          });
          continue;
        }
        seenKeys.add(key);
        const existing = conn().one<{ id: string }>(
          `SELECT id FROM ${table.table} WHERE ${table.naturalKey} = ? COLLATE NOCASE LIMIT 1`,
          [String(values[naturalSpec.key])],
        );
        if (existing) {
          duplicates += 1;
          if (!updateExisting) {
            errors.push({
              row: row.row,
              column: naturalSpec.label,
              reason: `"${String(values[naturalSpec.key])}" already exists.`,
              value: String(values[naturalSpec.key]),
              kind: 'duplicate',
            });
            continue;
          }
          values['__existing_id'] = existing.id;
        }
      }
    }

    valid.push({ row: row.row, values });
  }

  const fieldCounts = new Map<string, number>();
  for (const error of errors) {
    const key = error.column ?? 'row';
    fieldCounts.set(key, (fieldCounts.get(key) ?? 0) + 1);
  }

  const nextStaged: Staged = {
    ...staged,
    mapping: { ...mapping },
    validated: { valid, errors, duplicates, updateExisting },
  };
  writeStaged(batchId, nextStaged);
  conn().run(
    `UPDATE import_batches SET mapping_json = ?, valid_rows = ?, error_rows = ?, status = 'validated' WHERE id = ?`,
    [JSON.stringify(mapping), valid.length, errors.length, batchId],
  );

  return {
    batchId,
    totalRows: staged.rows.length,
    validRows: valid.length,
    invalidRows: errors.length - errors.filter((error) => error.kind === 'duplicate').length,
    duplicateRows: duplicates,
    errors,
    byField: [...fieldCounts.entries()]
      .map(([field, count]) => ({ field, count }))
      .sort((a, b) => b.count - a.count),
    preview: valid.slice(0, 10).map((row) => {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(row.values)) {
        if (key.startsWith('__')) continue;
        out[key] = value === null ? '' : String(value);
      }
      return out;
    }),
  };
}

// ── commit ──────────────────────────────────────────────────────────────────

/** Columns a caller may never set through an import, whatever the file says. */
const PROTECTED = new Set(['id', 'created_at', 'updated_at', 'deleted_at', '__existing_id']);

function insertRow(
  table: string,
  values: Readonly<Record<string, string | number | null>>,
  existingId: string | null,
): void {
  const at = nowIso();
  const columns = Object.keys(values).filter((key) => !PROTECTED.has(key));
  const params: (string | number | null)[] = columns.map((column) => values[column] ?? null);
  // A row of nothing but blanks would produce `INSERT INTO t (id, created_at,
  // updated_at)`, which is legal but creates an empty record. Refuse it.
  if (columns.length === 0) throw new Error('The row has no values to import.');

  if (existingId) {
    const assignments = columns.map((column) => `${column} = ?`).join(', ');
    conn().run(`UPDATE ${table} SET ${assignments}, updated_at = ? WHERE id = ?`, [...params, at, existingId]);
    return;
  }

  const allColumns = ['id', ...columns, 'created_at', 'updated_at'];
  const placeholders = allColumns.map(() => '?').join(', ');
  conn().run(`INSERT INTO ${table} (${allColumns.join(', ')}) VALUES (${placeholders})`, [
    randomUUID(),
    ...params,
    at,
    at,
  ]);
}

/**
 * Inserts the rows `validate` approved.
 *
 * Batches of 500 with a progress callback between them: the window must stay
 * responsive on a 10 000-row file, and the only way to guarantee that is to
 * yield. A row that fails at insert time (a constraint the validator could not
 * see) is counted and reported rather than aborting the whole import — losing
 * 9 997 good rows to one bad one is not acceptable.
 */
export function commit(
  batchId: string,
  scope: { readonly actorId: string | null; readonly actorName: string },
  onProgress?: (progress: ImportProgress) => void,
): ImportCommitResult {
  const started = Date.now();
  const batchRow = conn().one<{ entity: string; filename: string; status: string }>(
    'SELECT entity, filename, status FROM import_batches WHERE id = ?',
    [batchId],
  );
  if (!batchRow) throw notFound('Import batch');
  // Committing twice is a double-clicked button, not an intention. Without this
  // guard the second pass re-inserts every row with a fresh id — 10 000 silent
  // duplicates, and an error report that blames the file.
  if (batchRow.status === 'committed') {
    throw conflict('That file has already been imported. Start a new import to bring in more rows.');
  }
  const entity = batchRow.entity as ImportEntity;
  const staged = readStaged(batchId);
  if (!staged.validated) throw conflict('Validate the file before importing it.');
  const table = TABLES[entity].table;

  const valid = staged.validated.valid;
  const failures: ImportRowError[] = [];
  let inserted = 0;
  let updated = 0;

  const BATCH = 500;
  for (let start = 0; start < valid.length; start += BATCH) {
    const slice = valid.slice(start, start + BATCH);
    atomically(() => {
      for (const row of slice) {
        const existingId = typeof row.values['__existing_id'] === 'string' ? row.values['__existing_id'] : null;
        try {
          insertRow(table, row.values, existingId);
          if (existingId) updated += 1;
          else inserted += 1;
        } catch (error) {
          failures.push({
            row: row.row,
            column: null,
            reason: error instanceof Error ? error.message : 'The row could not be saved.',
            value: null,
            kind: 'invalid',
          });
        }
      }
    });
    onProgress?.({
      batchId,
      done: Math.min(start + BATCH, valid.length),
      total: valid.length,
      phase: 'committing',
    });
  }

  const errorCsvPath = failures.length > 0 ? writeErrorCsv(batchRow.filename, failures) : null;
  const at = nowIso();
  conn().run(
    `UPDATE import_batches SET status = 'committed', valid_rows = ?, error_rows = ?, committed_at = ? WHERE id = ?`,
    [inserted + updated, failures.length + staged.validated.errors.length, at, batchId],
  );
  auditLog.append({
    actorId: scope.actorId,
    actorName: scope.actorName,
    entity: 'import_batches',
    entityId: batchId,
    action: 'import_commit',
    after: { entity, inserted, updated, failed: failures.length },
    meta: { filename: batchRow.filename },
  });

  return {
    batchId,
    inserted,
    updated,
    skipped: staged.validated.errors.length,
    failed: failures.length,
    errorCsvPath,
    ms: Date.now() - started,
  };
}

/**
 * Writes the rejected rows beside the database, so they are easy to find.
 *
 * Deliberately not beside the source file: that file may be on a read-only
 * network share or in a downloads folder the operator has since cleaned up. The
 * data directory is always writable and is where every other artefact of ours
 * already lives.
 */
function writeErrorCsv(filename: string, errors: readonly ImportRowError[]): string {
  const directory = path.dirname(conn().filePath());
  const base = path.basename(filename, path.extname(filename));
  const target = path.join(directory, `${base}-errors.csv`);
  const lines = ['row,column,reason,value'];
  for (const error of errors) {
    const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    lines.push(
      [String(error.row), error.column ?? '', error.reason, error.value ?? ''].map(escape).join(','),
    );
  }
  try {
    writeFileSync(target, lines.join('\n'), 'utf8');
    return target;
  } catch {
    return '';
  }
}

/** A correctly-headed CSV for an entity, so the guess is never needed. */
export function template(entity: ImportEntity): { readonly filename: string; readonly csv: string } {
  const specs = FIELDS[entity];
  const headers = specs.map((spec) => spec.label);
  const example = specs.map((spec) => {
    switch (spec.type) {
      case 'money':
        return '100.00';
      case 'int':
        return '0';
      case 'date':
        return '2026-01-31';
      case 'bool':
        return 'yes';
      case 'enum':
        return spec.values?.[0] ?? '';
      default:
        return '';
    }
  });
  const escape = (value: string): string => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return {
    filename: `${entity}-template.csv`,
    csv: `${headers.map(escape).join(',')}\n${example.map(escape).join(',')}\n`,
  };
}
