/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Company profile, user prefs, security policy, gapless numbering, fiscal
 * years, base currency and custom fields (ARCHITECTURE §C.5, BR-08, BR-23).
 *
 * Two rules shape this file:
 *   - A number is allocated **only when a document is posted**, inside the
 *     posting transaction. Drafts have `number = NULL`, so deleting a draft can
 *     never burn a number (BR-08).
 *   - The base currency is immutable once the ledger has moved (BR-23); the
 *     guard reads `journal_entries`, not a flag, so a restore cannot lie.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { nowIso, fiscalPeriods, fiscalYearRange, todayIso } from '../../shared/dates';
import type {
  Address,
  Company,
  Currency,
  CustomField,
  CustomFieldType,
  SecurityPolicy,
  Sequence,
  Tax,
} from '../../shared/types';
import { conn } from '../db/connection';
import { conflict, notFound, validation } from '../errors';

import { securityPolicy } from './auth';

// ── settings key/value ───────────────────────────────────────────────────────

/** Reads a JSON setting, returning `null` when absent or corrupt. */
export function readSetting<T>(key: string): T | null {
  const row = conn().one<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', [key]);
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

/** Upserts a JSON setting. Callers own the transaction. */
export function writeSetting(key: string, value: unknown, actorId: string | null = null): void {
  conn().run(
    `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [key, JSON.stringify(value), nowIso(), actorId],
  );
}

/** `settings.get` — the whole bag, or just the requested keys. */
export function getSettings(keys?: readonly string[]): Record<string, unknown> {
  const rows = keys && keys.length > 0
    ? conn().all<{ key: string; value_json: string }>(
        `SELECT key, value_json FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`,
        [...keys],
      )
    : conn().all<{ key: string; value_json: string }>('SELECT key, value_json FROM settings');
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value_json) as unknown;
    } catch {
      out[row.key] = row.value_json;
    }
  }
  return out;
}

// ── company ──────────────────────────────────────────────────────────────────

interface CompanyRow {
  readonly id: string;
  readonly name: string;
  readonly legal_name: string | null;
  readonly tax_id: string | null;
  readonly address_json: string | null;
  readonly logo_path: string | null;
  readonly base_currency: string;
  readonly fiscal_year_start_month: number;
  readonly date_format: string;
  readonly number_format: string;
  readonly industry_preset: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function toCompany(row: CompanyRow): Company {
  let address: Address | null = null;
  if (row.address_json) {
    try {
      address = JSON.parse(row.address_json) as Address;
    } catch {
      address = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    legalName: row.legal_name,
    taxId: row.tax_id,
    address,
    logoPath: row.logo_path,
    baseCurrency: row.base_currency,
    fiscalYearStartMonth: Number(row.fiscal_year_start_month),
    dateFormat: row.date_format,
    numberFormat: row.number_format,
    industryPreset: row.industry_preset,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The single company row, or `null` before onboarding. */
export function getCompany(): Company | null {
  const row = conn().one<CompanyRow>('SELECT * FROM companies LIMIT 1');
  return row ? toCompany(row) : null;
}

/** True once onboarding has created the company row. */
export function companyExists(): boolean {
  const row = conn().one<{ total: number }>('SELECT COUNT(*) AS total FROM companies');
  return row ? Number(row.total) > 0 : false;
}

export interface CompanyPatch {
  readonly name?: string;
  readonly legalName?: string | null;
  readonly taxId?: string | null;
  readonly address?: Address | null;
  readonly dateFormat?: string;
  readonly numberFormat?: string;
}

/** Updates the identity fields. Currency and fiscal month have their own guards. */
export function saveCompany(patch: CompanyPatch): Company {
  const current = getCompany();
  if (!current) throw notFound('Company');

  if (patch.name !== undefined && patch.name.trim().length < 2) {
    throw validation('name', 'The company name needs at least 2 characters.');
  }
  if (patch.taxId !== undefined && patch.taxId !== null && patch.taxId.length > 40) {
    throw validation('taxId', 'That tax id is too long (40 characters maximum).');
  }

  conn().run(
    `UPDATE companies SET name = ?, legal_name = ?, tax_id = ?, address_json = ?,
       date_format = ?, number_format = ?, updated_at = ? WHERE id = ?`,
    [
      patch.name?.trim() ?? current.name,
      patch.legalName === undefined ? current.legalName : patch.legalName,
      patch.taxId === undefined ? current.taxId : patch.taxId,
      patch.address === undefined ? JSON.stringify(current.address) : JSON.stringify(patch.address),
      patch.dateFormat ?? current.dateFormat,
      patch.numberFormat ?? current.numberFormat,
      nowIso(),
      current.id,
    ],
  );
  return getCompany() ?? current;
}

const MAX_LOGO_BYTES = 256 * 1024;

/**
 * Stores the logo as a file next to the database and returns its path. A data
 * URL is accepted (the renderer reads the file), but the bytes are re-checked
 * here — a 256 kB limit in the UI is a hint, not a control.
 */
export function saveLogo(dataUrl: string): { readonly path: string } {
  const match = /^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw validation('logo', 'Upload a PNG, JPEG, WebP or SVG image.');
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1] === 'svg+xml' ? 'svg' : match[1];
  const bytes = Buffer.from(match[2] ?? '', 'base64');
  if (bytes.byteLength === 0) throw validation('logo', 'That image file is empty.');
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    throw validation('logo', 'The logo must be 256 kB or smaller.');
  }

  const company = getCompany();
  if (!company) throw notFound('Company');

  const dir = path.join(app.getPath('userData'), 'branding');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `logo.${extension}`);
  writeFileSync(file, bytes);
  conn().run('UPDATE companies SET logo_path = ?, updated_at = ? WHERE id = ?', [
    file,
    nowIso(),
    company.id,
  ]);
  return { path: file };
}

// ── security policy ──────────────────────────────────────────────────────────

/** Persists `settings.security`. Validated so a bad value cannot lock everyone out. */
export function saveSecurity(patch: Partial<SecurityPolicy>): SecurityPolicy {
  const current = securityPolicy();
  const next: SecurityPolicy = {
    idleTimeoutMin: clampInt(patch.idleTimeoutMin, 1, 240, 'idleTimeoutMin', current.idleTimeoutMin),
    minPasswordLength: clampInt(patch.minPasswordLength, 8, 64, 'minPasswordLength', current.minPasswordLength),
    requireSymbol: patch.requireSymbol === undefined ? current.requireSymbol : Boolean(patch.requireSymbol),
    maxAttempts: clampInt(patch.maxAttempts, 3, 20, 'maxAttempts', current.maxAttempts),
    lockoutMin: clampInt(patch.lockoutMin, 1, 1440, 'lockoutMin', current.lockoutMin),
  };
  writeSetting('security', next);
  return next;
}

function clampInt(value: number | undefined, min: number, max: number, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw validation(field, `Enter a whole number between ${String(min)} and ${String(max)}.`);
  }
  return value;
}

// ── numbering (BR-08) ────────────────────────────────────────────────────────

/** `INV-` + 5 digits + suffix. Pure so it can be unit-tested. */
export function formatSequence(prefix: string, padding: number, value: number, suffix: string): string {
  return `${prefix}${String(value).padStart(padding, '0')}${suffix}`;
}

/** The fiscal year row that owns `date`, creating it on first use. */
export interface FiscalYearRow {
  readonly id: string;
  readonly name: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly is_current: number;
}

/**
 * Finds (or creates) the fiscal year and its 12 periods for `date`. Runs inside
 * the caller's transaction so a failed onboarding leaves no orphan periods.
 */
export function ensureFiscalYear(startMonth: number, date = todayIso()): FiscalYearRow {
  const range = fiscalYearRange(date, startMonth);
  const existing = conn().one<FiscalYearRow>('SELECT * FROM fiscal_years WHERE start_date = ?', [
    range.start,
  ]);
  if (existing) return existing;

  const id = randomUUID();
  const label = `${range.start.slice(0, 4)}–${range.end.slice(0, 4)}`;
  conn().run(
    'INSERT INTO fiscal_years (id, name, start_date, end_date, is_current) VALUES (?, ?, ?, ?, 0)',
    [id, label, range.start, range.end],
  );
  for (const period of fiscalPeriods(startMonth, date)) {
    conn().run(
      'INSERT INTO periods (id, fiscal_year_id, name, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), id, period.name, period.start, period.end, 'open'],
    );
  }
  conn().run('UPDATE fiscal_years SET is_current = 1 WHERE id = ?', [id]);
  conn().run('UPDATE fiscal_years SET is_current = 0 WHERE id <> ?', [id]);
  const created = conn().one<FiscalYearRow>('SELECT * FROM fiscal_years WHERE id = ?', [id]);
  if (!created) throw notFound('Fiscal year');
  return created;
}

/** The fiscal year containing `date`; created on demand. */
export function fiscalYearFor(date: string): FiscalYearRow {
  const company = getCompany();
  const startMonth = company?.fiscalYearStartMonth ?? 1;
  const range = fiscalYearRange(date, startMonth);
  const row = conn().one<FiscalYearRow>('SELECT * FROM fiscal_years WHERE start_date = ?', [range.start]);
  return row ?? ensureFiscalYear(startMonth, date);
}

/** Every sequence, current fiscal year first. */
export function listSequences(): readonly Sequence[] {
  const rows = conn().all<{
    doc_type: string;
    fiscal_year_id: string;
    prefix: string;
    padding: number;
    next_value: number;
    suffix: string;
  }>('SELECT * FROM number_sequences ORDER BY doc_type ASC, fiscal_year_id ASC');
  return rows.map((row) => ({
    docType: row.doc_type,
    fiscalYearId: row.fiscal_year_id,
    prefix: row.prefix,
    padding: Number(row.padding),
    nextValue: Number(row.next_value),
    suffix: row.suffix,
  }));
}

export interface SequenceInput {
  readonly docType: string;
  readonly prefix: string;
  readonly padding: number;
  readonly suffix?: string;
}

/** Creates or edits the sequence for the current fiscal year. */
export function saveSequence(input: SequenceInput): Sequence {
  const docType = input.docType.trim();
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(docType)) {
    throw validation('docType', 'Document types are lowercase words such as invoice or purchase_order.');
  }
  if (input.prefix.length > 12) throw validation('prefix', 'Keep the prefix to 12 characters.');
  if (!Number.isInteger(input.padding) || input.padding < 1 || input.padding > 8) {
    throw validation('padding', 'Padding must be between 1 and 8 digits.');
  }
  const suffix = input.suffix ?? '';
  if (suffix.length > 12) throw validation('suffix', 'Keep the suffix to 12 characters.');

  const year = ensureFiscalYear(getCompany()?.fiscalYearStartMonth ?? 1);
  const existing = conn().one<{ next_value: number }>(
    'SELECT next_value FROM number_sequences WHERE doc_type = ? AND fiscal_year_id = ?',
    [docType, year.id],
  );
  conn().run(
    `INSERT INTO number_sequences (doc_type, fiscal_year_id, prefix, padding, next_value, suffix)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(doc_type, fiscal_year_id) DO UPDATE SET prefix = excluded.prefix,
       padding = excluded.padding, suffix = excluded.suffix`,
    [docType, year.id, input.prefix, input.padding, existing ? Number(existing.next_value) : 1, suffix],
  );
  return requireSequence(docType, year.id);
}

function requireSequence(docType: string, fiscalYearId: string): Sequence {
  const row = conn().one<{
    doc_type: string;
    fiscal_year_id: string;
    prefix: string;
    padding: number;
    next_value: number;
    suffix: string;
  }>('SELECT * FROM number_sequences WHERE doc_type = ? AND fiscal_year_id = ?', [docType, fiscalYearId]);
  if (!row) throw notFound('Numbering sequence');
  return {
    docType: row.doc_type,
    fiscalYearId: row.fiscal_year_id,
    prefix: row.prefix,
    padding: Number(row.padding),
    nextValue: Number(row.next_value),
    suffix: row.suffix,
  };
}

/** What the next number *would* be. Reads only — never consumes (BR-08). */
export function previewNumber(docType: string): { readonly next: string } {
  const year = ensureFiscalYear(getCompany()?.fiscalYearStartMonth ?? 1);
  const sequence = requireSequence(docType, year.id);
  return { next: formatSequence(sequence.prefix, sequence.padding, sequence.nextValue, sequence.suffix) };
}

/**
 * Allocates the next number. **Only call inside the posting transaction** — the
 * increment must roll back with the document it belongs to.
 */
export function nextNumber(docType: string, fiscalYearId: string): string {
  const sequence = requireSequence(docType, fiscalYearId);
  conn().run(
    'UPDATE number_sequences SET next_value = next_value + 1 WHERE doc_type = ? AND fiscal_year_id = ?',
    [docType, fiscalYearId],
  );
  return formatSequence(sequence.prefix, sequence.padding, sequence.nextValue, sequence.suffix);
}

/** Rewinds a sequence to 1. Audited by the caller; refuses to move backwards silently. */
export function resetSequence(docType: string): Sequence {
  const year = ensureFiscalYear(getCompany()?.fiscalYearStartMonth ?? 1);
  const sequence = requireSequence(docType, year.id);
  if (sequence.nextValue === 1) {
    throw conflict(`The ${docType} sequence is already at 1 — there is nothing to reset.`);
  }
  conn().run(
    'UPDATE number_sequences SET next_value = 1 WHERE doc_type = ? AND fiscal_year_id = ?',
    [docType, year.id],
  );
  return requireSequence(docType, year.id);
}

// ── currencies (BR-23) ───────────────────────────────────────────────────────

export function listCurrencies(): readonly Currency[] {
  const rows = conn().all<{
    code: string;
    name: string;
    symbol: string | null;
    decimals: number;
    rate_bp: number;
    is_base: number;
    updated_at: string;
  }>('SELECT * FROM currencies ORDER BY is_base DESC, code ASC');
  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    symbol: row.symbol,
    decimals: Number(row.decimals),
    rateBp: Number(row.rate_bp),
    isBase: Number(row.is_base) === 1,
    updatedAt: row.updated_at,
  }));
}

/**
 * Switches the base currency. Refused once any journal entry has been posted:
 * every stored cent would silently change meaning (BR-23).
 */
export function setBaseCurrency(code: string): { readonly refused?: string } {
  const target = conn().one<{ code: string }>('SELECT code FROM currencies WHERE code = ?', [code]);
  if (!target) throw validation('code', 'Add that currency before making it the base currency.');

  const posted = conn().one<{ total: number }>(
    "SELECT COUNT(*) AS total FROM journal_entries WHERE status IN ('posted','reversed')",
  );
  if (posted && Number(posted.total) > 0) {
    return {
      refused:
        'The base currency cannot change once entries have been posted. Create a new company file, or post a revaluation.',
    };
  }

  const company = getCompany();
  if (!company) throw notFound('Company');
  conn().run('UPDATE currencies SET is_base = 0, updated_at = ?', [nowIso()]);
  conn().run('UPDATE currencies SET is_base = 1, rate_bp = 10000, updated_at = ? WHERE code = ?', [
    nowIso(),
    code,
  ]);
  conn().run('UPDATE companies SET base_currency = ?, updated_at = ? WHERE id = ?', [
    code,
    nowIso(),
    company.id,
  ]);
  return {};
}

// ── taxes ────────────────────────────────────────────────────────────────────

export function listTaxes(): readonly Tax[] {
  const rows = conn().all<{
    id: string;
    name: string;
    rate_bp: number;
    is_inclusive: number;
    is_compound: number;
    account_id: string | null;
    is_archived: number;
  }>('SELECT * FROM taxes ORDER BY name ASC');
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    rateBp: Number(row.rate_bp),
    isInclusive: Number(row.is_inclusive) === 1,
    isCompound: Number(row.is_compound) === 1,
    accountId: row.account_id,
    isArchived: Number(row.is_archived) === 1,
  }));
}

// ── custom fields (US-49) ────────────────────────────────────────────────────

interface CustomFieldRow {
  readonly id: string;
  readonly entity: string;
  readonly key: string;
  readonly label: string;
  readonly type: CustomFieldType;
  readonly is_required: number;
  readonly options_json: string | null;
  readonly sort_order: number;
  readonly is_active: number;
}

function toCustomField(row: CustomFieldRow): CustomField {
  let options: readonly string[] | null = null;
  if (row.options_json) {
    try {
      const parsed = JSON.parse(row.options_json) as unknown;
      options = Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : null;
    } catch {
      options = null;
    }
  }
  return {
    id: row.id,
    entity: row.entity,
    key: row.key,
    label: row.label,
    type: row.type,
    isRequired: Number(row.is_required) === 1,
    options,
    sortOrder: Number(row.sort_order),
    isActive: Number(row.is_active) === 1,
  };
}

export function listCustomFields(entity?: string): readonly CustomField[] {
  const rows = entity
    ? conn().all<CustomFieldRow>(
        'SELECT * FROM custom_fields WHERE entity = ? AND is_active = 1 ORDER BY sort_order ASC, key ASC',
        [entity],
      )
    : conn().all<CustomFieldRow>('SELECT * FROM custom_fields ORDER BY entity ASC, sort_order ASC');
  return rows.map(toCustomField);
}

export interface CustomFieldInput {
  readonly id?: string;
  readonly entity: string;
  readonly key: string;
  readonly label: string;
  readonly type: CustomFieldType;
  readonly isRequired?: boolean;
  readonly options?: readonly string[] | null;
  readonly sortOrder?: number;
  readonly isActive?: boolean;
}

/** Creates or edits a custom field definition. */
export function saveCustomField(input: CustomFieldInput): CustomField {
  const entity = input.entity.trim();
  const key = input.key.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_]{1,40}$/.test(key)) {
    throw validation('key', 'Keys start with a letter and use letters, digits or underscores.');
  }
  if (input.label.trim().length < 2) throw validation('label', 'Give the field a label.');
  if (input.type === 'select' && (!input.options || input.options.length === 0)) {
    throw validation('options', 'A select field needs at least one option.');
  }

  const at = nowIso();
  const optionsJson = input.options ? JSON.stringify(input.options) : null;

  if (input.id) {
    const existing = conn().one<CustomFieldRow>('SELECT * FROM custom_fields WHERE id = ?', [input.id]);
    if (!existing) throw notFound('Custom field');
    conn().run(
      `UPDATE custom_fields SET entity = ?, key = ?, label = ?, type = ?, is_required = ?,
         options_json = ?, sort_order = ?, is_active = ? WHERE id = ?`,
      [
        entity,
        key,
        input.label.trim(),
        input.type,
        (input.isRequired ?? Number(existing.is_required) === 1) ? 1 : 0,
        optionsJson,
        input.sortOrder ?? Number(existing.sort_order),
        input.isActive === false ? 0 : 1,
        input.id,
      ],
    );
    return requireCustomField(input.id);
  }

  const clash = conn().one<{ id: string }>(
    'SELECT id FROM custom_fields WHERE entity = ? AND key = ?',
    [entity, key],
  );
  if (clash) throw conflict(`"${entity}.${key}" already exists.`);

  const id = randomUUID();
  conn().run(
    `INSERT INTO custom_fields (id, entity, key, label, type, is_required, options_json, sort_order, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      entity,
      key,
      input.label.trim(),
      input.type,
      input.isRequired ? 1 : 0,
      optionsJson,
      input.sortOrder ?? 0,
      input.isActive === false ? 0 : 1,
      at,
    ],
  );
  return requireCustomField(id);
}

function requireCustomField(id: string): CustomField {
  const row = conn().one<CustomFieldRow>('SELECT * FROM custom_fields WHERE id = ?', [id]);
  if (!row) throw notFound('Custom field');
  return toCustomField(row);
}

/** Archives a definition and drops its stored values. */
export function deleteCustomField(id: string): void {
  const row = conn().one<CustomFieldRow>('SELECT * FROM custom_fields WHERE id = ?', [id]);
  if (!row) throw notFound('Custom field');
  conn().run('DELETE FROM custom_values WHERE field_id = ?', [id]);
  conn().run('UPDATE custom_fields SET is_active = 0 WHERE id = ?', [id]);
}

/** Stored custom values for one record, keyed by field key. */
export function getCustomValues(entity: string, entityId: string): Record<string, unknown> {
  const rows = conn().all<{
    key: string;
    type: CustomFieldType;
    value_text: string | null;
    value_num: number | null;
    value_date: string | null;
    value_bool: number | null;
  }>(
    `SELECT f.key, f.type, v.value_text, v.value_num, v.value_date, v.value_bool
       FROM custom_values v JOIN custom_fields f ON f.id = v.field_id
      WHERE v.entity = ? AND v.entity_id = ?`,
    [entity, entityId],
  );
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.type === 'bool') out[row.key] = Number(row.value_bool) === 1;
    else if (row.type === 'number' || row.type === 'money') out[row.key] = row.value_num;
    else if (row.type === 'date') out[row.key] = row.value_date;
    else out[row.key] = row.value_text;
  }
  return out;
}

/**
 * Validates a submitted value map against the active definitions. Required
 * fields must be present and non-empty — this is what makes `customers.GSTIN`
 * block a save (US-49).
 */
export function validateCustomValues(
  entity: string,
  values: Readonly<Record<string, unknown>>,
  options: { readonly partial?: boolean } = {},
): void {
  for (const field of listCustomFields(entity)) {
    const present = Object.prototype.hasOwnProperty.call(values, field.key);
    const raw = values[field.key];
    const empty = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');

    if (field.isRequired && empty && !(options.partial && !present)) {
      throw validation(field.key, `"${field.label}" is required.`);
    }
    if (empty) continue;

    if (field.type === 'number' || field.type === 'money') {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw validation(field.key, `"${field.label}" must be a number.`);
      }
    } else if (field.type === 'date') {
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        throw validation(field.key, `"${field.label}" must be a date.`);
      }
    } else if (field.type === 'bool') {
      if (typeof raw !== 'boolean') throw validation(field.key, `"${field.label}" must be yes or no.`);
    } else if (field.type === 'select') {
      if (typeof raw !== 'string' || !(field.options ?? []).includes(raw)) {
        throw validation(field.key, `Pick one of the listed options for "${field.label}".`);
      }
    }
  }
}

/** Writes validated values. Caller owns the transaction. */
export function setCustomValues(
  entity: string,
  entityId: string,
  values: Readonly<Record<string, unknown>>,
): void {
  const fields = listCustomFields(entity);
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
    const raw = values[field.key];
    conn().run('DELETE FROM custom_values WHERE entity = ? AND entity_id = ? AND field_id = ?', [
      entity,
      entityId,
      field.id,
    ]);
    if (raw === null || raw === undefined || raw === '') continue;
    conn().run(
      `INSERT INTO custom_values (entity, entity_id, field_id, value_text, value_num, value_date, value_bool)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entity,
        entityId,
        field.id,
        field.type === 'text' || field.type === 'select' ? String(raw) : null,
        field.type === 'number' || field.type === 'money' ? Number(raw) : null,
        field.type === 'date' ? String(raw) : null,
        field.type === 'bool' ? (raw ? 1 : 0) : null,
      ],
    );
  }
}
