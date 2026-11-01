"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readSetting = readSetting;
exports.writeSetting = writeSetting;
exports.getSettings = getSettings;
exports.getCompany = getCompany;
exports.companyExists = companyExists;
exports.saveCompany = saveCompany;
exports.saveLogo = saveLogo;
exports.saveSecurity = saveSecurity;
exports.formatSequence = formatSequence;
exports.ensureFiscalYear = ensureFiscalYear;
exports.fiscalYearFor = fiscalYearFor;
exports.listSequences = listSequences;
exports.saveSequence = saveSequence;
exports.previewNumber = previewNumber;
exports.nextNumber = nextNumber;
exports.resetSequence = resetSequence;
exports.listCurrencies = listCurrencies;
exports.setBaseCurrency = setBaseCurrency;
exports.listTaxes = listTaxes;
exports.listCustomFields = listCustomFields;
exports.saveCustomField = saveCustomField;
exports.deleteCustomField = deleteCustomField;
exports.getCustomValues = getCustomValues;
exports.validateCustomValues = validateCustomValues;
exports.setCustomValues = setCustomValues;
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
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
const dates_1 = require("../../shared/dates");
const connection_1 = require("../db/connection");
const errors_1 = require("../errors");
const auth_1 = require("./auth");
// ── settings key/value ───────────────────────────────────────────────────────
/** Reads a JSON setting, returning `null` when absent or corrupt. */
function readSetting(key) {
    const row = (0, connection_1.conn)().one('SELECT value_json FROM settings WHERE key = ?', [key]);
    if (!row)
        return null;
    try {
        return JSON.parse(row.value_json);
    }
    catch {
        return null;
    }
}
/** Upserts a JSON setting. Callers own the transaction. */
function writeSetting(key, value, actorId = null) {
    (0, connection_1.conn)().run(`INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`, [key, JSON.stringify(value), (0, dates_1.nowIso)(), actorId]);
}
/** `settings.get` — the whole bag, or just the requested keys. */
function getSettings(keys) {
    const rows = keys && keys.length > 0
        ? (0, connection_1.conn)().all(`SELECT key, value_json FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`, [...keys])
        : (0, connection_1.conn)().all('SELECT key, value_json FROM settings');
    const out = {};
    for (const row of rows) {
        try {
            out[row.key] = JSON.parse(row.value_json);
        }
        catch {
            out[row.key] = row.value_json;
        }
    }
    return out;
}
function toCompany(row) {
    let address = null;
    if (row.address_json) {
        try {
            address = JSON.parse(row.address_json);
        }
        catch {
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
function getCompany() {
    const row = (0, connection_1.conn)().one('SELECT * FROM companies LIMIT 1');
    return row ? toCompany(row) : null;
}
/** True once onboarding has created the company row. */
function companyExists() {
    const row = (0, connection_1.conn)().one('SELECT COUNT(*) AS total FROM companies');
    return row ? Number(row.total) > 0 : false;
}
/** Updates the identity fields. Currency and fiscal month have their own guards. */
function saveCompany(patch) {
    const current = getCompany();
    if (!current)
        throw (0, errors_1.notFound)('Company');
    if (patch.name !== undefined && patch.name.trim().length < 2) {
        throw (0, errors_1.validation)('name', 'The company name needs at least 2 characters.');
    }
    if (patch.taxId !== undefined && patch.taxId !== null && patch.taxId.length > 40) {
        throw (0, errors_1.validation)('taxId', 'That tax id is too long (40 characters maximum).');
    }
    (0, connection_1.conn)().run(`UPDATE companies SET name = ?, legal_name = ?, tax_id = ?, address_json = ?,
       date_format = ?, number_format = ?, updated_at = ? WHERE id = ?`, [
        patch.name?.trim() ?? current.name,
        patch.legalName === undefined ? current.legalName : patch.legalName,
        patch.taxId === undefined ? current.taxId : patch.taxId,
        patch.address === undefined ? JSON.stringify(current.address) : JSON.stringify(patch.address),
        patch.dateFormat ?? current.dateFormat,
        patch.numberFormat ?? current.numberFormat,
        (0, dates_1.nowIso)(),
        current.id,
    ]);
    return getCompany() ?? current;
}
const MAX_LOGO_BYTES = 256 * 1024;
/**
 * Stores the logo as a file next to the database and returns its path. A data
 * URL is accepted (the renderer reads the file), but the bytes are re-checked
 * here — a 256 kB limit in the UI is a hint, not a control.
 */
function saveLogo(dataUrl) {
    const match = /^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match)
        throw (0, errors_1.validation)('logo', 'Upload a PNG, JPEG, WebP or SVG image.');
    const extension = match[1] === 'jpeg' ? 'jpg' : match[1] === 'svg+xml' ? 'svg' : match[1];
    const bytes = Buffer.from(match[2] ?? '', 'base64');
    if (bytes.byteLength === 0)
        throw (0, errors_1.validation)('logo', 'That image file is empty.');
    if (bytes.byteLength > MAX_LOGO_BYTES) {
        throw (0, errors_1.validation)('logo', 'The logo must be 256 kB or smaller.');
    }
    const company = getCompany();
    if (!company)
        throw (0, errors_1.notFound)('Company');
    const dir = node_path_1.default.join(electron_1.app.getPath('userData'), 'branding');
    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    const file = node_path_1.default.join(dir, `logo.${extension}`);
    (0, node_fs_1.writeFileSync)(file, bytes);
    (0, connection_1.conn)().run('UPDATE companies SET logo_path = ?, updated_at = ? WHERE id = ?', [
        file,
        (0, dates_1.nowIso)(),
        company.id,
    ]);
    return { path: file };
}
// ── security policy ──────────────────────────────────────────────────────────
/** Persists `settings.security`. Validated so a bad value cannot lock everyone out. */
function saveSecurity(patch) {
    const current = (0, auth_1.securityPolicy)();
    const next = {
        idleTimeoutMin: clampInt(patch.idleTimeoutMin, 1, 240, 'idleTimeoutMin', current.idleTimeoutMin),
        minPasswordLength: clampInt(patch.minPasswordLength, 8, 64, 'minPasswordLength', current.minPasswordLength),
        requireSymbol: patch.requireSymbol === undefined ? current.requireSymbol : Boolean(patch.requireSymbol),
        maxAttempts: clampInt(patch.maxAttempts, 3, 20, 'maxAttempts', current.maxAttempts),
        lockoutMin: clampInt(patch.lockoutMin, 1, 1440, 'lockoutMin', current.lockoutMin),
    };
    writeSetting('security', next);
    return next;
}
function clampInt(value, min, max, field, fallback) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
        throw (0, errors_1.validation)(field, `Enter a whole number between ${String(min)} and ${String(max)}.`);
    }
    return value;
}
// ── numbering (BR-08) ────────────────────────────────────────────────────────
/** `INV-` + 5 digits + suffix. Pure so it can be unit-tested. */
function formatSequence(prefix, padding, value, suffix) {
    return `${prefix}${String(value).padStart(padding, '0')}${suffix}`;
}
/**
 * Finds (or creates) the fiscal year and its 12 periods for `date`. Runs inside
 * the caller's transaction so a failed onboarding leaves no orphan periods.
 */
function ensureFiscalYear(startMonth, date = (0, dates_1.todayIso)()) {
    const range = (0, dates_1.fiscalYearRange)(date, startMonth);
    const existing = (0, connection_1.conn)().one('SELECT * FROM fiscal_years WHERE start_date = ?', [
        range.start,
    ]);
    if (existing)
        return existing;
    const id = (0, node_crypto_1.randomUUID)();
    const label = `${range.start.slice(0, 4)}–${range.end.slice(0, 4)}`;
    (0, connection_1.conn)().run('INSERT INTO fiscal_years (id, name, start_date, end_date, is_current) VALUES (?, ?, ?, ?, 0)', [id, label, range.start, range.end]);
    for (const period of (0, dates_1.fiscalPeriods)(startMonth, date)) {
        (0, connection_1.conn)().run('INSERT INTO periods (id, fiscal_year_id, name, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, ?)', [(0, node_crypto_1.randomUUID)(), id, period.name, period.start, period.end, 'open']);
    }
    (0, connection_1.conn)().run('UPDATE fiscal_years SET is_current = 1 WHERE id = ?', [id]);
    (0, connection_1.conn)().run('UPDATE fiscal_years SET is_current = 0 WHERE id <> ?', [id]);
    const created = (0, connection_1.conn)().one('SELECT * FROM fiscal_years WHERE id = ?', [id]);
    if (!created)
        throw (0, errors_1.notFound)('Fiscal year');
    return created;
}
/** The fiscal year containing `date`; created on demand. */
function fiscalYearFor(date) {
    const company = getCompany();
    const startMonth = company?.fiscalYearStartMonth ?? 1;
    const range = (0, dates_1.fiscalYearRange)(date, startMonth);
    const row = (0, connection_1.conn)().one('SELECT * FROM fiscal_years WHERE start_date = ?', [range.start]);
    return row ?? ensureFiscalYear(startMonth, date);
}
/** Every sequence, current fiscal year first. */
function listSequences() {
    const rows = (0, connection_1.conn)().all('SELECT * FROM number_sequences ORDER BY doc_type ASC, fiscal_year_id ASC');
    return rows.map((row) => ({
        docType: row.doc_type,
        fiscalYearId: row.fiscal_year_id,
        prefix: row.prefix,
        padding: Number(row.padding),
        nextValue: Number(row.next_value),
        suffix: row.suffix,
    }));
}
/** Creates or edits the sequence for the current fiscal year. */
function saveSequence(input) {
    const docType = input.docType.trim();
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(docType)) {
        throw (0, errors_1.validation)('docType', 'Document types are lowercase words such as invoice or purchase_order.');
    }
    if (input.prefix.length > 12)
        throw (0, errors_1.validation)('prefix', 'Keep the prefix to 12 characters.');
    if (!Number.isInteger(input.padding) || input.padding < 1 || input.padding > 8) {
        throw (0, errors_1.validation)('padding', 'Padding must be between 1 and 8 digits.');
    }
    const suffix = input.suffix ?? '';
    if (suffix.length > 12)
        throw (0, errors_1.validation)('suffix', 'Keep the suffix to 12 characters.');
    const year = ensureFiscalYear(getCompany()?.fiscalYearStartMonth ?? 1);
    const existing = (0, connection_1.conn)().one('SELECT next_value FROM number_sequences WHERE doc_type = ? AND fiscal_year_id = ?', [docType, year.id]);
    (0, connection_1.conn)().run(`INSERT INTO number_sequences (doc_type, fiscal_year_id, prefix, padding, next_value, suffix)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(doc_type, fiscal_year_id) DO UPDATE SET prefix = excluded.prefix,
       padding = excluded.padding, suffix = excluded.suffix`, [docType, year.id, input.prefix, input.padding, existing ? Number(existing.next_value) : 1, suffix]);
    return requireSequence(docType, year.id);
}
function requireSequence(docType, fiscalYearId) {
    const row = (0, connection_1.conn)().one('SELECT * FROM number_sequences WHERE doc_type = ? AND fiscal_year_id = ?', [docType, fiscalYearId]);
    if (!row)
        throw (0, errors_1.notFound)('Numbering sequence');
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
function previewNumber(docType) {
    const year = ensureFiscalYear(getCompany()?.fiscalYearStartMonth ?? 1);
    const sequence = requireSequence(docType, year.id);
    return { next: formatSequence(sequence.prefix, sequence.padding, sequence.nextValue, sequence.suffix) };
}
/**
 * Allocates the next number. **Only call inside the posting transaction** — the
 * increment must roll back with the document it belongs to.
 */
function nextNumber(docType, fiscalYearId) {
    const sequence = requireSequence(docType, fiscalYearId);
    (0, connection_1.conn)().run('UPDATE number_sequences SET next_value = next_value + 1 WHERE doc_type = ? AND fiscal_year_id = ?', [docType, fiscalYearId]);
    return formatSequence(sequence.prefix, sequence.padding, sequence.nextValue, sequence.suffix);
}
/** Rewinds a sequence to 1. Audited by the caller; refuses to move backwards silently. */
function resetSequence(docType) {
    const year = ensureFiscalYear(getCompany()?.fiscalYearStartMonth ?? 1);
    const sequence = requireSequence(docType, year.id);
    if (sequence.nextValue === 1) {
        throw (0, errors_1.conflict)(`The ${docType} sequence is already at 1 — there is nothing to reset.`);
    }
    (0, connection_1.conn)().run('UPDATE number_sequences SET next_value = 1 WHERE doc_type = ? AND fiscal_year_id = ?', [docType, year.id]);
    return requireSequence(docType, year.id);
}
// ── currencies (BR-23) ───────────────────────────────────────────────────────
function listCurrencies() {
    const rows = (0, connection_1.conn)().all('SELECT * FROM currencies ORDER BY is_base DESC, code ASC');
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
function setBaseCurrency(code) {
    const target = (0, connection_1.conn)().one('SELECT code FROM currencies WHERE code = ?', [code]);
    if (!target)
        throw (0, errors_1.validation)('code', 'Add that currency before making it the base currency.');
    const posted = (0, connection_1.conn)().one("SELECT COUNT(*) AS total FROM journal_entries WHERE status IN ('posted','reversed')");
    if (posted && Number(posted.total) > 0) {
        return {
            refused: 'The base currency cannot change once entries have been posted. Create a new company file, or post a revaluation.',
        };
    }
    const company = getCompany();
    if (!company)
        throw (0, errors_1.notFound)('Company');
    (0, connection_1.conn)().run('UPDATE currencies SET is_base = 0, updated_at = ?', [(0, dates_1.nowIso)()]);
    (0, connection_1.conn)().run('UPDATE currencies SET is_base = 1, rate_bp = 10000, updated_at = ? WHERE code = ?', [
        (0, dates_1.nowIso)(),
        code,
    ]);
    (0, connection_1.conn)().run('UPDATE companies SET base_currency = ?, updated_at = ? WHERE id = ?', [
        code,
        (0, dates_1.nowIso)(),
        company.id,
    ]);
    return {};
}
// ── taxes ────────────────────────────────────────────────────────────────────
function listTaxes() {
    const rows = (0, connection_1.conn)().all('SELECT * FROM taxes ORDER BY name ASC');
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
function toCustomField(row) {
    let options = null;
    if (row.options_json) {
        try {
            const parsed = JSON.parse(row.options_json);
            options = Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : null;
        }
        catch {
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
function listCustomFields(entity) {
    const rows = entity
        ? (0, connection_1.conn)().all('SELECT * FROM custom_fields WHERE entity = ? AND is_active = 1 ORDER BY sort_order ASC, key ASC', [entity])
        : (0, connection_1.conn)().all('SELECT * FROM custom_fields ORDER BY entity ASC, sort_order ASC');
    return rows.map(toCustomField);
}
/** Creates or edits a custom field definition. */
function saveCustomField(input) {
    const entity = input.entity.trim();
    const key = input.key.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]{1,40}$/.test(key)) {
        throw (0, errors_1.validation)('key', 'Keys start with a letter and use letters, digits or underscores.');
    }
    if (input.label.trim().length < 2)
        throw (0, errors_1.validation)('label', 'Give the field a label.');
    if (input.type === 'select' && (!input.options || input.options.length === 0)) {
        throw (0, errors_1.validation)('options', 'A select field needs at least one option.');
    }
    const at = (0, dates_1.nowIso)();
    const optionsJson = input.options ? JSON.stringify(input.options) : null;
    if (input.id) {
        const existing = (0, connection_1.conn)().one('SELECT * FROM custom_fields WHERE id = ?', [input.id]);
        if (!existing)
            throw (0, errors_1.notFound)('Custom field');
        (0, connection_1.conn)().run(`UPDATE custom_fields SET entity = ?, key = ?, label = ?, type = ?, is_required = ?,
         options_json = ?, sort_order = ?, is_active = ? WHERE id = ?`, [
            entity,
            key,
            input.label.trim(),
            input.type,
            (input.isRequired ?? Number(existing.is_required) === 1) ? 1 : 0,
            optionsJson,
            input.sortOrder ?? Number(existing.sort_order),
            input.isActive === false ? 0 : 1,
            input.id,
        ]);
        return requireCustomField(input.id);
    }
    const clash = (0, connection_1.conn)().one('SELECT id FROM custom_fields WHERE entity = ? AND key = ?', [entity, key]);
    if (clash)
        throw (0, errors_1.conflict)(`"${entity}.${key}" already exists.`);
    const id = (0, node_crypto_1.randomUUID)();
    (0, connection_1.conn)().run(`INSERT INTO custom_fields (id, entity, key, label, type, is_required, options_json, sort_order, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
    ]);
    return requireCustomField(id);
}
function requireCustomField(id) {
    const row = (0, connection_1.conn)().one('SELECT * FROM custom_fields WHERE id = ?', [id]);
    if (!row)
        throw (0, errors_1.notFound)('Custom field');
    return toCustomField(row);
}
/** Archives a definition and drops its stored values. */
function deleteCustomField(id) {
    const row = (0, connection_1.conn)().one('SELECT * FROM custom_fields WHERE id = ?', [id]);
    if (!row)
        throw (0, errors_1.notFound)('Custom field');
    (0, connection_1.conn)().run('DELETE FROM custom_values WHERE field_id = ?', [id]);
    (0, connection_1.conn)().run('UPDATE custom_fields SET is_active = 0 WHERE id = ?', [id]);
}
/** Stored custom values for one record, keyed by field key. */
function getCustomValues(entity, entityId) {
    const rows = (0, connection_1.conn)().all(`SELECT f.key, f.type, v.value_text, v.value_num, v.value_date, v.value_bool
       FROM custom_values v JOIN custom_fields f ON f.id = v.field_id
      WHERE v.entity = ? AND v.entity_id = ?`, [entity, entityId]);
    const out = {};
    for (const row of rows) {
        if (row.type === 'bool')
            out[row.key] = Number(row.value_bool) === 1;
        else if (row.type === 'number' || row.type === 'money')
            out[row.key] = row.value_num;
        else if (row.type === 'date')
            out[row.key] = row.value_date;
        else
            out[row.key] = row.value_text;
    }
    return out;
}
/**
 * Validates a submitted value map against the active definitions. Required
 * fields must be present and non-empty — this is what makes `customers.GSTIN`
 * block a save (US-49).
 */
function validateCustomValues(entity, values, options = {}) {
    for (const field of listCustomFields(entity)) {
        const present = Object.prototype.hasOwnProperty.call(values, field.key);
        const raw = values[field.key];
        const empty = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
        if (field.isRequired && empty && !(options.partial && !present)) {
            throw (0, errors_1.validation)(field.key, `"${field.label}" is required.`);
        }
        if (empty)
            continue;
        if (field.type === 'number' || field.type === 'money') {
            if (typeof raw !== 'number' || !Number.isFinite(raw)) {
                throw (0, errors_1.validation)(field.key, `"${field.label}" must be a number.`);
            }
        }
        else if (field.type === 'date') {
            if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
                throw (0, errors_1.validation)(field.key, `"${field.label}" must be a date.`);
            }
        }
        else if (field.type === 'bool') {
            if (typeof raw !== 'boolean')
                throw (0, errors_1.validation)(field.key, `"${field.label}" must be yes or no.`);
        }
        else if (field.type === 'select') {
            if (typeof raw !== 'string' || !(field.options ?? []).includes(raw)) {
                throw (0, errors_1.validation)(field.key, `Pick one of the listed options for "${field.label}".`);
            }
        }
    }
}
/** Writes validated values. Caller owns the transaction. */
function setCustomValues(entity, entityId, values) {
    const fields = listCustomFields(entity);
    for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(values, field.key))
            continue;
        const raw = values[field.key];
        (0, connection_1.conn)().run('DELETE FROM custom_values WHERE entity = ? AND entity_id = ? AND field_id = ?', [
            entity,
            entityId,
            field.id,
        ]);
        if (raw === null || raw === undefined || raw === '')
            continue;
        (0, connection_1.conn)().run(`INSERT INTO custom_values (entity, entity_id, field_id, value_text, value_num, value_date, value_bool)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            entity,
            entityId,
            field.id,
            field.type === 'text' || field.type === 'select' ? String(raw) : null,
            field.type === 'number' || field.type === 'money' ? Number(raw) : null,
            field.type === 'date' ? String(raw) : null,
            field.type === 'bool' ? (raw ? 1 : 0) : null,
        ]);
    }
}
//# sourceMappingURL=settings.js.map