/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Settings → System → Backup (T10).
 *
 * Three actions and one list:
 *
 *   choose a folder → back up now → see what is in that folder → restore one
 *
 * Restoring is the only destructive thing in the application, so it is the only
 * place with a typed confirmation. The panel says out loud what will happen
 * (sessions dropped, re-login required, a pre-restore copy kept beside the
 * database) before the button is enabled, because a restore that surprises
 * somebody is a support ticket at best.
 */

import { useState } from 'react';

import type { BackupEntry, BackupRestoreResult, BackupResult } from '@shared/admin';

import { EmptyState, SectionCard, TableSkeleton } from '../../components/patterns';
import { Modal } from '../../components/Modal';
import { Button, Chip, Input } from '../../components/ui';
import { invoke } from '../../lib/api';
import { clearQueryCache, useQuery } from '../../lib/useQuery';
import { toast } from '../../lib/toast';
import { dateTime } from '../../lib/format';

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BackupPanel(): JSX.Element {
  const [directory, setDirectory] = useState('');
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<BackupEntry | null>(null);
  const [confirmWord, setConfirmWord] = useState('');

  const list = useQuery<readonly BackupEntry[]>(
    `backup:list:${directory}`,
    () => invoke<readonly BackupEntry[]>('backup.list', { directory }),
    { enabled: directory.trim().length > 0, staleMs: 10_000 },
  );

  async function chooseFolder(): Promise<void> {
    try {
      const result = await invoke<{ directory: string | null }>('backup.pickFolder', {});
      if (result.directory) setDirectory(result.directory);
    } catch {
      toast.error('Could not open the folder picker');
    }
  }

  async function run(): Promise<void> {
    if (directory.trim().length === 0) {
      toast.error('Choose a folder first');
      return;
    }
    setBusy(true);
    try {
      const result = await invoke<BackupResult>('backup.run', { directory });
      toast.success('Backup written', `${result.manifest.filename} · ${bytesLabel(result.manifest.bytes)}`);
      list.refresh();
    } catch (error) {
      toast.error('The backup failed', error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function doRestore(): Promise<void> {
    if (!restoring) return;
    setBusy(true);
    try {
      const result = await invoke<BackupRestoreResult>('backup.restore', { path: restoring.path });
      clearQueryCache();
      toast.success('Restored', `${result.path} · integrity ${result.integrity}`);
      setRestoring(null);
      setConfirmWord('');
      // The whole session belongs to a database that no longer exists.
      window.location.reload();
    } catch (error) {
      toast.error('The restore was refused', error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <SectionCard
        title="Backups"
        description="A backup is a verified copy of the database: checksum, integrity check and schema version, all recorded beside it."
        actions={
          <>
            <Input
              aria-label="Backup folder"
              placeholder="No folder chosen"
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
              className="w-72"
            />
            <Button onClick={() => void chooseFolder()}>Choose folder…</Button>
            <Button variant="primary" onClick={() => void run()} loading={busy}>
              Back up now
            </Button>
          </>
        }
      >
        {directory.trim().length === 0 ? (
          <div className="p-3">
            <EmptyState
              title="No folder chosen"
              description="Pick a folder — a USB stick or a synced drive is better than the same disk."
              action={<Button onClick={() => void chooseFolder()}>Choose folder…</Button>}
            />
          </div>
        ) : list.loading ? (
          <div className="p-3">
            <TableSkeleton rows={4} columns={4} />
          </div>
        ) : (list.data ?? []).length === 0 ? (
          <div className="p-3">
            <EmptyState title="No backups in that folder" description="Press Back up now to write the first one." />
          </div>
        ) : (
          <table className="w-full text-meta">
            <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">File</th>
                <th className="px-3 py-2">Written</th>
                <th className="px-3 py-2 text-right">Size</th>
                <th className="px-3 py-2">Integrity</th>
                <th className="px-3 py-2">Schema</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(list.data ?? []).map((entry) => (
                <tr key={entry.path}>
                  <td className="px-3 py-2 font-mono text-[11px] text-text">{entry.filename}</td>
                  <td className="px-3 py-2 text-muted">{dateTime(entry.manifest?.createdAt ?? entry.createdAt)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{bytesLabel(entry.bytes)}</td>
                  <td className="px-3 py-2">
                    {entry.manifestValid ? (
                      <Chip tone={entry.manifest?.integrity === 'ok' ? 'success' : 'danger'}>
                        {entry.manifest?.integrity ?? 'unknown'}
                      </Chip>
                    ) : (
                      <Chip tone="warning">no manifest</Chip>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted">
                    {entry.manifest ? `v${String(entry.manifest.schemaVersion)}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRestoring(entry);
                        setConfirmWord('');
                      }}
                    >
                      Restore…
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <Modal
        open={restoring !== null}
        onOpenChange={(next) => {
          if (!next) setRestoring(null);
        }}
        title="Restore this backup"
        description="This replaces the live database. It cannot be undone from inside the application."
        size="md"
        destructive
        confirmText="restore"
        busy={busy}
        onConfirm={() => void doRestore()}
      >
        <div className="space-y-2 text-meta">
          <p>
            <span className="text-muted">File: </span>
            <span className="font-mono text-text">{restoring?.filename}</span>
          </p>
          <p className="text-muted">
            Before replacing anything, a copy of the current database is kept beside it as
            <span className="font-mono"> .pre-restore-…</span>. Every session is then dropped and you will be asked to
            sign in again, because the users table has just changed underneath it.
          </p>
          {confirmWord.trim().length > 0 && confirmWord.trim() !== 'restore' ? (
            <p className="text-danger">Type restore to confirm.</p>
          ) : null}
          <Input
            aria-label="Type restore to confirm"
            placeholder="restore"
            value={confirmWord}
            onChange={(event) => setConfirmWord(event.target.value)}
          />
        </div>
      </Modal>
    </div>
  );
}
