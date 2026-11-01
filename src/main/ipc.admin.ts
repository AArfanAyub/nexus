/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Admin channel handlers (T10): import, backup, and the audit diff.
 *
 * Thin by design. Two things are worth knowing about this file:
 *
 *   - the **file and folder dialogs** live here rather than in the service,
 *     because `dialog` needs a parent window and the service must stay callable
 *     from a test with no Electron at all;
 *   - `data.import.commit` emits `job:progress` between batches, which is the
 *     only reason a 10 000-row import does not freeze the window.
 */

import { dialog } from 'electron';

import type {
  AuditDiff,
  AuditFieldChange,
  BackupEntry,
  BackupManifest,
  BackupRestoreResult,
  BackupResult,
  ImportCommitResult,
  ImportEntity,
  ImportParseResult,
  ImportValidationReport,
} from '../shared/admin';
import type { RegisterFn } from './ipc';
import { conflict, notFound, validation } from './errors';
import * as auditLog from './services/audit';
import * as backup from './services/backup';
import * as importexport from './services/importexport';
import { invalidateCache } from './services/cache';
import { sendToRenderer } from './window';

function scopeOf(ctx: { readonly actorId: string | null; readonly actorName: string }) {
  return { actorId: ctx.actorId, actorName: ctx.actorName };
}

/** Renders one side of a field for display without pretending to be a JSON viewer. */
function display(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Field-level diff of one audit entry.
 *
 * Three buckets rather than one list of pairs: an added field and a changed
 * field mean different things to a reviewer ("this column started being written"
 * versus "this value moved"), and a removed field is the one worth staring at.
 */
export function diffEntry(seq: number): AuditDiff {
  const row = auditLog.bySeq(seq);
  if (!row) throw notFound('Audit entry');

  const before = (row.before ?? {}) as Record<string, unknown>;
  const after = (row.after ?? {}) as Record<string, unknown>;
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  const added: AuditFieldChange[] = [];
  const removed: AuditFieldChange[] = [];
  const changed: AuditFieldChange[] = [];

  for (const key of afterKeys) {
    if (!beforeKeys.includes(key)) {
      added.push({ field: key, before: null, after: display(after[key]) });
      continue;
    }
    const left = display(before[key]);
    const right = display(after[key]);
    if (left !== right) changed.push({ field: key, before: left, after: right });
  }
  for (const key of beforeKeys) {
    if (!afterKeys.includes(key)) removed.push({ field: key, before: display(before[key]), after: null });
  }

  return { seq, added, removed, changed };
}

export function registerAdminChannels(register: RegisterFn): void {
  // ── import ─────────────────────────────────────────────────────────────────
  register({
    channel: 'data.import.pick',
    handler: async () => {
      const result = await dialog.showOpenDialog({
        title: 'Choose a file to import',
        properties: ['openFile'],
        filters: [
          { name: 'Spreadsheets', extensions: ['csv', 'xlsx', 'xls', 'tsv'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) return { path: null };
      return { path: result.filePaths[0] ?? null };
    },
  });

  register({
    channel: 'data.import.parse',
    handler: (payload: { entity: string; path: string }): ImportParseResult => {
      if (!importexport.isImportEntity(payload.entity)) {
        throw validation('entity', 'That is not something you can import.');
      }
      return importexport.parse(payload.entity as ImportEntity, payload.path);
    },
  });

  register({
    channel: 'data.import.validate',
    handler: (payload: {
      batchId: string;
      mapping: Readonly<Record<string, string>>;
      updateExisting?: boolean;
    }): ImportValidationReport =>
      importexport.validate(payload.batchId, payload.mapping, payload.updateExisting === true),
  });

  register({
    channel: 'data.import.commit',
    handler: (payload: { batchId: string }, ctx): ImportCommitResult => {
      const result = importexport.commit(payload.batchId, scopeOf(ctx), (progress) => {
        sendToRenderer('job:progress', progress);
      });
      // An import writes customers, products and accounts; every list that could
      // be showing them is now wrong.
      invalidateCache('');
      return result;
    },
  });

  register({
    channel: 'data.import.template',
    handler: (payload: { entity: string }) => {
      if (!importexport.isImportEntity(payload.entity)) {
        throw validation('entity', 'That is not something you can import.');
      }
      return importexport.template(payload.entity as ImportEntity);
    },
  });

  // ── backup ─────────────────────────────────────────────────────────────────
  register({
    channel: 'backup.pickFolder',
    handler: async () => {
      const result = await dialog.showOpenDialog({
        title: 'Choose a folder for the backup',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return { directory: null };
      return { directory: result.filePaths[0] ?? null };
    },
  });

  register({
    channel: 'backup.run',
    handler: async (payload: { directory: string }, ctx): Promise<BackupResult> =>
      backup.create(payload.directory, scopeOf(ctx)),
  });

  register({
    channel: 'backup.list',
    handler: (payload: { directory: string }): readonly BackupEntry[] => backup.list(payload.directory),
  });

  register({
    channel: 'backup.verify',
    handler: async (payload: { path: string }): Promise<BackupManifest> => backup.verify(payload.path),
  });

  register({
    channel: 'backup.restore',
    handler: async (
      payload: { path: string; skipSafetyCopy?: boolean },
      ctx,
    ): Promise<BackupRestoreResult> => {
      if (payload.path.trim().length === 0) throw conflict('Choose a backup to restore.');
      const result = await backup.restore(payload.path, scopeOf(ctx), {
        skipSafetyCopy: payload.skipSafetyCopy === true,
      });
      return result;
    },
  });

  // ── audit diff ─────────────────────────────────────────────────────────────
  register({
    channel: 'audit.diff',
    handler: (payload: { seq: number }): AuditDiff => diffEntry(payload.seq),
  });
}
