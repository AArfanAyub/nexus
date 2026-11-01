/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The cold store (requirement R1).
 *
 * Closed history — posted journal entries, settled invoices, completed payments,
 * old stock moves — is moved out of the hot tables into `archive_records` as a
 * gzipped JSON payload with a SHA-256 of the uncompressed bytes. The hot tables
 * stay small enough that a 10k-customer install still lists in milliseconds, and
 * nothing is lost: every row is restorable and verifiable.
 *
 * Rules:
 *   - one transaction per archive run: either every selected row moves or none
 *   - only *immutable* rows are eligible (posted, not draft; paid or void, not
 *     open) — archiving something the operator can still edit would be a bug
 *   - the payload is hashed **before** compression, so `verifyArchive` proves the
 *     stored bytes still decompress to the same rows
 *   - reports read archived rows back transparently (`archivedBalances`)
 */

import { createHash, randomUUID } from 'node:crypto';
import zlib from 'node:zlib';

import { nowIso } from '../../shared/dates';
import { conn } from '../db/connection';
import { conflict, notFound, validation } from '../errors';

/** Tables that may be archived, with their date column and eligibility rule. */
interface ArchiveSpec {
  readonly table: string;
  readonly dateColumn: string;
  readonly eligibility: string;
  /** Child rows that travel with the parent, keyed by parent id. */
  readonly children?: readonly { readonly table: string; readonly column: string }[];
}

/**
 * Order matters: every table that carries a `journal_entry_id` foreign key is
 * listed **before** `journal_entries`, because the rows are deleted in this
 * order and SQLite checks the constraint on each delete. Archiving "everything
 * older than last year" used to fail with a bare `FOREIGN KEY constraint failed`
 * the moment a settled invoice was still holding a pointer to its ledger entry.
 */
const SPECS: readonly ArchiveSpec[] = [
  {
    table: 'invoices',
    dateColumn: 'date',
    eligibility: "status IN ('paid', 'void')",
    children: [{ table: 'invoice_lines', column: 'invoice_id' }],
  },
  {
    table: 'bills',
    dateColumn: 'date',
    eligibility: "status IN ('paid', 'void')",
    children: [{ table: 'bill_lines', column: 'bill_id' }],
  },
  {
    table: 'payments',
    dateColumn: 'date',
    eligibility: 'unallocated_cents >= 0',
    children: [{ table: 'payment_allocations', column: 'payment_id' }],
  },
  {
    table: 'stock_moves',
    dateColumn: 'moved_at',
    eligibility: "status = 'posted'",
  },
  {
    table: 'journal_entries',
    dateColumn: 'date',
    /**
     * An entry may leave only when nothing live still points at it.
     *
     * Six tables carry a `journal_entry_id` foreign key, and only three of them
     * are archivable at all — so "the entry is old" is not enough. Each `NOT IN`
     * is an uncorrelated subquery, which SQLite evaluates once into a transient
     * index rather than once per row.
     *
     * A reversal pair is all-or-nothing: `reverses_id` is a self-reference, so
     * deleting one half while the other is live violates the constraint, and
     * deleting both would need an order the FK check cannot express. Reversals
     * are rare, so they stay in the hot table — which costs nothing and keeps
     * the audit trail whole.
     */
    eligibility:
      "status = 'posted' AND reverses_id IS NULL " +
      'AND id NOT IN (SELECT reverses_id FROM journal_entries WHERE reverses_id IS NOT NULL) ' +
      'AND id NOT IN (SELECT journal_entry_id FROM invoices WHERE journal_entry_id IS NOT NULL) ' +
      'AND id NOT IN (SELECT journal_entry_id FROM bills WHERE journal_entry_id IS NOT NULL) ' +
      'AND id NOT IN (SELECT journal_entry_id FROM payments WHERE journal_entry_id IS NOT NULL) ' +
      'AND id NOT IN (SELECT journal_entry_id FROM stock_moves WHERE journal_entry_id IS NOT NULL) ' +
      'AND id NOT IN (SELECT journal_entry_id FROM goods_receipts WHERE journal_entry_id IS NOT NULL) ' +
      'AND id NOT IN (SELECT journal_entry_id FROM sales_deliveries WHERE journal_entry_id IS NOT NULL)',
    children: [{ table: 'journal_lines', column: 'entry_id' }],
  },
];

function specFor(table: string): ArchiveSpec {
  const spec = SPECS.find((candidate) => candidate.table === table);
  if (!spec) throw validation('tables', `${table} cannot be archived.`);
  return spec;
}

/** The tables an operator may name. */
export function archivableTables(): readonly string[] {
  return SPECS.map((spec) => spec.table);
}

function digest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export interface ArchiveInput {
  /** Rows dated strictly before this day are eligible. */
  readonly before: string;
  readonly tables?: readonly string[];
  readonly reason?: string;
  readonly actorId?: string | null;
  /** Safety valve: refuse to move more than this in one run. */
  readonly limit?: number;
}

export interface ArchiveResult {
  readonly records: number;
  readonly rows: number;
  readonly tables: readonly string[];
}

/**
 * Moves eligible rows into the archive and deletes them from the hot table, in
 * one transaction. Returns what moved so the UI can report it honestly.
 */
export function archiveOldRecords(input: ArchiveInput): ArchiveResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.before)) {
    throw validation('before', 'Pick the cutoff date.');
  }
  const tables = input.tables && input.tables.length > 0 ? input.tables : archivableTables();
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 5000), 1), 50_000);
  const at = nowIso();
  let records = 0;
  let rows = 0;
  const touched: string[] = [];

  for (const table of tables) {
    const spec = specFor(table);
    const parents = conn().all<Record<string, unknown>>(
      `SELECT * FROM ${spec.table} WHERE ${spec.dateColumn} < ? AND ${spec.eligibility} LIMIT ?`,
      [input.before, limit],
    );
    if (parents.length === 0) continue;
    touched.push(table);

    // The cold store's balance rollup has to be written *before* the rows are
    // deleted, and it has to cover exactly the rows this run takes — hence the
    // temp table of ids rather than "everything before the cutoff", which would
    // be wrong the moment the row limit bites (v7, see migrate.v7.ts).
    if (spec.table === 'journal_entries') {
      conn().exec('CREATE TEMP TABLE IF NOT EXISTS archive_moving (id TEXT PRIMARY KEY);');
      conn().exec('DELETE FROM archive_moving;');
      for (const parent of parents) {
        conn().run('INSERT OR IGNORE INTO archive_moving (id) VALUES (?)', [String(parent['id'])]);
      }
      conn().run(
        `INSERT INTO archive_balances (date, account_id, debit_cents, credit_cents)
         SELECT e.date, l.account_id, COALESCE(SUM(l.debit_cents), 0), COALESCE(SUM(l.credit_cents), 0)
           FROM archive_moving m
           JOIN journal_entries e ON e.id = m.id
           JOIN journal_lines l ON l.entry_id = e.id
          GROUP BY e.date, l.account_id
         ON CONFLICT(date, account_id) DO UPDATE
            SET debit_cents = debit_cents + excluded.debit_cents,
                credit_cents = credit_cents + excluded.credit_cents`,
      );
      conn().exec('DELETE FROM archive_moving;');
    }

    for (const parent of parents) {
      const id = String(parent['id']);
      const children: Record<string, readonly Record<string, unknown>[]> = {};
      for (const child of spec.children ?? []) {
        children[child.table] = conn().all<Record<string, unknown>>(
          `SELECT * FROM ${child.table} WHERE ${child.column} = ?`,
          [id],
        );
      }
      const payload = JSON.stringify({ parent, children });
      const sha256 = digest(payload);
      const payloadGz = zlib.gzipSync(Buffer.from(payload, 'utf8'));
      const childRows = (spec.children ?? []).reduce(
        (total, child) => total + (children[child.table]?.length ?? 0),
        0,
      );

      conn().run(
        `INSERT INTO archive_records (id, table_name, entity_id, payload_gz, row_count, sha256,
           archived_at, archived_by, reason, range_start, range_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          spec.table,
          id,
          payloadGz,
          1 + childRows,
          sha256,
          at,
          input.actorId ?? null,
          input.reason?.trim() || null,
          String(parent[spec.dateColumn] ?? '').slice(0, 10),
          String(parent[spec.dateColumn] ?? '').slice(0, 10),
        ],
      );

      // Children first: the foreign keys point at the parent.
      for (const child of spec.children ?? []) {
        conn().run(`DELETE FROM ${child.table} WHERE ${child.column} = ?`, [id]);
      }
      conn().run(`DELETE FROM ${spec.table} WHERE id = ?`, [id]);
      records += 1;
      rows += 1 + childRows;
    }
  }

  return { records, rows, tables: touched };
}

export interface RestoreResult {
  readonly table: string;
  readonly entityId: string;
  readonly rows: number;
}

/** Puts one archived record back, verifying its hash first. */
export function restoreArchived(archiveId: string): RestoreResult {
  const row = conn().one<{
    id: string;
    table_name: string;
    entity_id: string;
    payload_gz: Uint8Array;
    sha256: string;
  }>('SELECT id, table_name, entity_id, payload_gz, sha256 FROM archive_records WHERE id = ?', [archiveId]);
  if (!row) throw notFound('Archived record');

  const payload = zlib.gunzipSync(Buffer.from(row.payload_gz)).toString('utf8');
  if (digest(payload) !== row.sha256) {
    throw conflict('That archived record is damaged: its checksum no longer matches. Restore from a backup instead.');
  }

  const parsed = JSON.parse(payload) as {
    parent: Record<string, unknown>;
    children?: Record<string, readonly Record<string, unknown>[]>;
  };
  const spec = specFor(row.table_name);

  let restored = 0;
  insertRow(spec.table, parsed.parent);
  restored += 1;
  for (const child of spec.children ?? []) {
    for (const childRow of parsed.children?.[child.table] ?? []) {
      insertRow(child.table, childRow);
      restored += 1;
    }
  }
  // The record is live again, so it must leave the cold-store rollup as well —
  // otherwise the trial balance counts the same entry twice.
  if (spec.table === 'journal_entries') {
    unrollArchivedEntry(
      String(parsed.parent['date'] ?? ''),
      parsed.children?.['journal_lines'] ?? [],
    );
  }
  conn().run('DELETE FROM archive_records WHERE id = ?', [archiveId]);
  return { table: spec.table, entityId: row.entity_id, rows: restored };
}

/** `INSERT OR REPLACE` from a plain object, binding every column by name. */
function insertRow(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  if (columns.length === 0) return;
  const placeholders = columns.map(() => '?').join(', ');
  const values = columns.map((column) => {
    const value = row[column];
    if (value === null || typeof value === 'string' || typeof value === 'number') return value;
    return value === undefined ? null : JSON.stringify(value);
  });
  conn().run(`INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, values);
}

export interface ArchiveStat {
  readonly table: string;
  readonly records: number;
  readonly bytes: number;
  readonly oldest: string | null;
  readonly newest: string | null;
}

export function archiveStats(): readonly ArchiveStat[] {
  return conn().all<{
    table_name: string;
    records: number;
    bytes: number;
    oldest: string | null;
    newest: string | null;
  }>(
    `SELECT table_name, COUNT(*) AS records, COALESCE(SUM(LENGTH(payload_gz)), 0) AS bytes,
            MIN(archived_at) AS oldest, MAX(archived_at) AS newest
       FROM archive_records GROUP BY table_name ORDER BY table_name`,
  ).map((row) => ({
    table: row.table_name,
    records: Number(row.records),
    bytes: Number(row.bytes),
    oldest: row.oldest,
    newest: row.newest,
  }));
}

/** Reclaims file space after a big archive run. SQLite-only, no rewrite. */
export function vacuum(): { readonly beforeBytes: number; readonly afterBytes: number } {
  const before = conn().fileSizeBytes();
  conn().exec('VACUUM;');
  conn().markDirty();
  conn().flushNow();
  return { beforeBytes: before, afterBytes: conn().fileSizeBytes() };
}

/**
 * Debit/credit totals per account for archived journal entries overlapping a
 * range. Reports call this and union it with the live tables, so an archived
 * period still balances (R1).
 *
 * Reads the rollup written at archive time (v7). The old implementation parsed
 * every payload and carried a `LIMIT 5000` that silently dropped 95 % of a
 * 100 000-entry archive — a trial balance that still balanced but was wrong.
 */
export function archivedBalances(
  from: string,
  to: string,
): ReadonlyMap<string, { debit: number; credit: number }> {
  const result = new Map<string, { debit: number; credit: number }>();
  const rows = conn().all<{ account_id: string; debit: number; credit: number }>(
    `SELECT account_id,
            COALESCE(SUM(debit_cents), 0) AS debit,
            COALESCE(SUM(credit_cents), 0) AS credit
       FROM archive_balances
      WHERE date >= ? AND date <= ?
      GROUP BY account_id`,
    [from, to],
  );
  for (const row of rows) {
    result.set(row.account_id, { debit: Number(row.debit), credit: Number(row.credit) });
  }
  return result;
}

/**
 * Takes one archived entry's contribution back out of the rollup.
 *
 * Called by `restoreArchived` inside the same transaction that re-inserts the
 * rows: the record moves from the cold store to the live ledger, so its totals
 * must move with it or the trial balance counts it twice.
 */
function unrollArchivedEntry(date: string, lines: readonly Record<string, unknown>[]): void {
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    const accountId = String(line['account_id'] ?? '');
    if (!accountId) continue;
    const current = totals.get(accountId) ?? { debit: 0, credit: 0 };
    current.debit += Number(line['debit_cents'] ?? 0);
    current.credit += Number(line['credit_cents'] ?? 0);
    totals.set(accountId, current);
  }
  for (const [accountId, amount] of totals) {
    conn().run(
      `UPDATE archive_balances
          SET debit_cents = debit_cents - ?, credit_cents = credit_cents - ?
        WHERE date = ? AND account_id = ?`,
      [amount.debit, amount.credit, date, accountId],
    );
  }
  // A row that nets to nothing is noise in a table that is meant to be small.
  conn().run('DELETE FROM archive_balances WHERE debit_cents = 0 AND credit_cents = 0');
}

/** How many live rows are eligible right now — drives the Settings button. */
export function archivePreview(before: string): readonly { table: string; eligible: number }[] {
  return SPECS.map((spec) => {
    const row = conn().one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${spec.table} WHERE ${spec.dateColumn} < ? AND ${spec.eligibility}`,
      [before],
    );
    return { table: spec.table, eligible: Number(row?.total ?? 0) };
  });
}
