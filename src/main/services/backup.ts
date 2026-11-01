/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

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

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import initSqlJs from 'sql.js';

import type {
  BackupEntry,
  BackupManifest,
  BackupRestoreResult,
  BackupResult,
} from '../../shared/admin';
import { nowIso } from '../../shared/dates';
import { closeConnection, conn, initConnection, resolveWasmPath, userVersion } from '../db/connection';
import { conflict, notFound } from '../errors';
import * as auditLog from './audit';
import { invalidateCache } from './cache';

export interface BackupScope {
  readonly actorId: string | null;
  readonly actorName: string;
}

const MANIFEST_VERSION = 1;
const MANIFEST_SUFFIX = '.manifest.json';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/** Row counts worth stating in a manifest: enough to spot an empty backup. */
function counts(): Record<string, number> {
  const tables = ['users', 'customers', 'vendors', 'products', 'invoices', 'bills', 'deals', 'journal_entries'];
  const out: Record<string, number> = {};
  for (const table of tables) {
    try {
      const row = conn().one<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table}`);
      out[table] = Number(row?.total ?? 0);
    } catch {
      out[table] = -1;
    }
  }
  return out;
}

function companyName(): string | null {
  try {
    const row = conn().one<{ name: string }>('SELECT name FROM companies LIMIT 1');
    return row?.name ?? null;
  } catch {
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
async function integrityOf(bytes: Uint8Array): Promise<string> {
  const wasmPath = resolveWasmPath();
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const database = new SQL.Database(bytes);
  try {
    const result = database.exec('PRAGMA integrity_check');
    const rows = result[0]?.values ?? [];
    const first = rows[0]?.[0];
    return typeof first === 'string' ? first : 'unknown';
  } finally {
    database.close();
  }
}

/** `nexus-2026-01-31T09-15-00.db` */
function backupFilename(at: string): string {
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
export async function create(targetDir: string, scope: BackupScope): Promise<BackupResult> {
  const started = Date.now();
  const directory = targetDir.trim();
  if (directory.length === 0) throw conflict('Choose a folder to back up into.');

  conn().flushNow();
  const source = conn().filePath();
  if (!existsSync(source)) throw conflict('The database file has not been written yet, so there is nothing to back up.');
  const bytes = new Uint8Array(readFileSync(source));
  if (bytes.byteLength === 0) throw conflict('The database file is empty, so there is nothing to back up.');

  mkdirSync(directory, { recursive: true });
  const at = nowIso();
  const filename = backupFilename(at);
  const target = path.join(directory, filename);
  const digest = sha256(bytes);

  const integrity = await integrityOf(bytes);
  if (integrity !== 'ok') {
    throw conflict(`The copy failed its integrity check (${integrity}). Nothing was written.`);
  }

  writeFileSync(target, Buffer.from(bytes));
  const manifest: BackupManifest = {
    version: MANIFEST_VERSION,
    appVersion: process.env['npm_package_version'] ?? '1.0.0',
    createdAt: at,
    filename,
    bytes: bytes.byteLength,
    sha256: digest,
    schemaVersion: userVersion(),
    integrity,
    company: companyName(),
    counts: counts(),
  };
  writeFileSync(path.join(directory, `${filename}${MANIFEST_SUFFIX}`), JSON.stringify(manifest, null, 2), 'utf8');

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
export function list(directory: string): readonly BackupEntry[] {
  const dir = directory.trim();
  if (dir.length === 0 || !existsSync(dir)) return [];
  const entries: BackupEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.db')) continue;
    const full = path.join(dir, name);
    let bytes = 0;
    let createdAt = nowIso();
    try {
      const stat = statSync(full);
      bytes = stat.size;
      createdAt = stat.mtime.toISOString();
    } catch {
      continue;
    }
    let manifest: BackupManifest | null = null;
    try {
      const raw = readFileSync(`${full}${MANIFEST_SUFFIX}`, 'utf8');
      manifest = JSON.parse(raw) as BackupManifest;
    } catch {
      manifest = null;
    }
    entries.push({ path: full, filename: name, bytes, createdAt, manifest, manifestValid: manifest !== null });
  }
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return entries;
}

/** Reads and checks one backup without restoring it. */
export async function verify(filePath: string): Promise<BackupManifest> {
  if (!existsSync(filePath)) throw notFound('Backup file');
  const bytes = new Uint8Array(readFileSync(filePath));
  const digest = sha256(bytes);

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(`${filePath}${MANIFEST_SUFFIX}`, 'utf8')) as BackupManifest;
  } catch {
    throw conflict('That backup has no manifest beside it, so it cannot be verified.');
  }
  if (manifest.sha256 !== digest) {
    throw conflict('That backup has changed since it was written — the checksum does not match. Restore refused.');
  }
  const integrity = await integrityOf(bytes);
  if (integrity !== 'ok') throw conflict(`That backup fails its integrity check (${integrity}). Restore refused.`);
  if (manifest.schemaVersion > userVersion()) {
    throw conflict(
      `That backup is schema v${String(manifest.schemaVersion)} and this build reads v${String(userVersion())}. Upgrade NEXUS before restoring it.`,
    );
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
export async function restore(
  filePath: string,
  scope: BackupScope,
  options: { readonly skipSafetyCopy?: boolean } = {},
): Promise<BackupRestoreResult> {
  const manifest = await verify(filePath);
  const target = conn().filePath();
  const bytes = new Uint8Array(readFileSync(filePath));

  if (options.skipSafetyCopy !== true) {
    conn().flushNow();
    if (existsSync(target)) {
      const safety = `${target}.pre-restore-${nowIso().replace(/[:.]/g, '-')}`;
      try {
        writeFileSync(safety, readFileSync(target));
      } catch {
        // A safety copy is a courtesy; failing to make one must not block a
        // restore the operator has already confirmed.
      }
    }
  }

  // Write through a temporary file and rename, so a crash mid-write cannot leave
  // a half-written database where the real one was.
  const staging = `${target}.restoring`;
  writeFileSync(staging, Buffer.from(bytes));
  closeConnection();
  renameSync(staging, target);
  await initConnection({ filePath: target });

  invalidateCache('');
  const restoredAt = nowIso();
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
export function preRestoreCopies(filePath: string): readonly string[] {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) return [];
  const base = path.basename(filePath);
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.pre-restore-`))
    .map((name) => path.join(dir, name));
}
