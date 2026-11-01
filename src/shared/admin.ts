/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The admin contract (T10): import, export, backup, and the audit viewer's diff.
 *
 * ## Why the import is staged in four calls
 *
 *   parse    → read the file, return headers + the first rows + a guessed mapping
 *   validate → run every row through the real entity rules, return a report
 *   commit   → insert only the valid rows, in batches, reporting progress
 *   template → a correctly-headed CSV for an entity, so the guess is never needed
 *
 * A 10 000-row file must not block the window, so `parse` and `validate` are
 * cheap and bounded, and `commit` emits `job:progress` events between batches.
 * The batch id ties the four calls together and is what `staged_json` stores.
 */

export type ImportEntity =
  | 'customers'
  | 'vendors'
  | 'products'
  | 'crmAccounts'
  | 'contacts'
  | 'leads'
  | 'deals';

/** One column as the file presents it, and the field it was mapped to. */
export interface ImportColumn {
  readonly header: string;
  readonly field: string | null;
  /** 0–100. 100 is an exact header match; anything below 60 is left unmapped. */
  readonly confidence: number;
  readonly sample: readonly string[];
}

export interface ImportParseRequest {
  readonly entity: ImportEntity;
  /** Absolute path chosen through the native dialog. */
  readonly path: string;
}

export interface ImportParseResult {
  readonly batchId: string;
  readonly entity: ImportEntity;
  readonly filename: string;
  readonly headers: readonly string[];
  readonly columns: readonly ImportColumn[];
  readonly totalRows: number;
  readonly preview: readonly Readonly<Record<string, string>>[];
  /** Rows the reader could not even split, e.g. a stray quote. */
  readonly parseErrors: readonly ImportRowError[];
}

/** One rejected row: where, which column, and why, in words an operator can act on. */
export interface ImportRowError {
  /** 1-based, counting the header as row 1 — the number the spreadsheet shows. */
  readonly row: number;
  readonly column: string | null;
  readonly reason: string;
  readonly value: string | null;
  /** `duplicate` rows are reported separately: they are not wrong, just present. */
  readonly kind: 'invalid' | 'duplicate' | 'required';
}

export interface ImportValidateRequest {
  readonly batchId: string;
  /** Header → entity field. The caller may override the guess entirely. */
  readonly mapping: Readonly<Record<string, string>>;
  /** When true, a row whose natural key already exists updates instead of failing. */
  readonly updateExisting?: boolean;
}

export interface ImportValidationReport {
  readonly batchId: string;
  readonly totalRows: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly duplicateRows: number;
  readonly errors: readonly ImportRowError[];
  /** Per-field rejection counts, for the summary above the table. */
  readonly byField: readonly { readonly field: string; readonly count: number }[];
  /** The first 10 valid rows, so the operator can see what will be created. */
  readonly preview: readonly Readonly<Record<string, string>>[];
}

export interface ImportCommitRequest {
  readonly batchId: string;
}

export interface ImportCommitResult {
  readonly batchId: string;
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failed: number;
  /** Absolute path of the generated error CSV, or null when there was nothing to report. */
  readonly errorCsvPath: string | null;
  readonly ms: number;
}

export interface ImportProgress {
  readonly batchId: string;
  readonly done: number;
  readonly total: number;
  readonly phase: 'validating' | 'committing';
}

// ── backup ──────────────────────────────────────────────────────────────────

export interface BackupManifest {
  readonly version: number;
  readonly appVersion: string;
  readonly createdAt: string;
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly schemaVersion: number;
  /** `PRAGMA integrity_check` output. `ok` means the copy is readable. */
  readonly integrity: string;
  readonly company: string | null;
  readonly counts: Readonly<Record<string, number>>;
}

export interface BackupEntry {
  readonly path: string;
  readonly filename: string;
  readonly bytes: number;
  readonly createdAt: string;
  readonly manifest: BackupManifest | null;
  /** False when the file is present but the manifest is missing or unreadable. */
  readonly manifestValid: boolean;
}

export interface BackupResult {
  readonly path: string;
  readonly manifest: BackupManifest;
  readonly ms: number;
}

export interface BackupRestoreResult {
  readonly path: string;
  readonly restoredAt: string;
  readonly integrity: string;
  /** Always true: a restore invalidates every session and forces a re-login. */
  readonly requiresLogin: boolean;
}

// ── audit viewer ────────────────────────────────────────────────────────────

/** One field that changed, with both sides rendered for display. */
export interface AuditFieldChange {
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface AuditDiff {
  readonly seq: number;
  readonly added: readonly AuditFieldChange[];
  readonly removed: readonly AuditFieldChange[];
  readonly changed: readonly AuditFieldChange[];
}
