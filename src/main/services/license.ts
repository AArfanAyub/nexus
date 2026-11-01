/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Licence state, activation and clock-rollback detection.
 *
 * Two files live outside the database on purpose (ARCHITECTURE §F.1 T4):
 *   `%APPDATA%/nexus/.stamp`      last wall-clock time we saw — restoring a
 *                                 database must not reset it
 *   `%APPDATA%/nexus/license.key` the activation key itself, so a NIC swap can
 *                                 be re-activated with the original key (D-05)
 *
 * Clock rollback NEVER blocks anything: it raises a warning flag and moves on
 * (BR-24, BR-25, US-12). Licences are perpetual, so there is nothing to expire.
 */

import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { nowIso } from '../../shared/dates';
import type { LicenseEdition, LicenseStatus } from '../../shared/types';
import { conn } from '../db/connection';
import { logWarn } from '../log';
import { machineId } from '../license/machine';
import { hashKey, verifyKey, type LicensePayload } from '../license/verify';

import * as auditLog from './audit';

const EDITIONS: readonly LicenseEdition[] = ['community', 'pro', 'enterprise'];

/** Edition → feature flags. Advisory by design (T3 residual risk). */
const EDITION_FEATURES: Readonly<Record<LicenseEdition, readonly string[]>> = {
  community: ['core'],
  pro: ['core', 'multi_currency', 'crm_analytics', 'bulk_import', 'backup'],
  enterprise: ['core', 'multi_currency', 'crm_analytics', 'bulk_import', 'backup', 'api', 'multi_company'],
};

/** A backwards clock jump larger than this is treated as suspect. */
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

export interface AuditActor {
  readonly actorId: string | null;
  readonly actorName: string;
}

const SYSTEM_ACTOR: AuditActor = { actorId: null, actorName: 'system' };

interface LicenseRow {
  readonly id: number;
  readonly edition: string;
  readonly licensee: string | null;
  readonly email: string | null;
  readonly seats: number;
  readonly features_json: string;
  readonly machine_id: string | null;
  readonly key_hash: string | null;
  readonly activated_at: string | null;
  readonly last_seen_at: string | null;
  readonly suspect_clock: number;
  readonly updated_at: string;
}

function stampPath(): string {
  return path.join(app.getPath('userData'), '.stamp');
}

function activationKeyPath(): string {
  return path.join(app.getPath('userData'), 'license.key');
}

function normaliseEdition(value: string): LicenseEdition {
  return EDITIONS.includes(value as LicenseEdition) ? (value as LicenseEdition) : 'community';
}

/** Reads the singleton row, creating the Community default on first run. */
function ensureRow(): LicenseRow {
  const database = conn();
  const existing = database.one<LicenseRow>(
    `SELECT id, edition, licensee, email, seats, features_json, machine_id, key_hash,
            activated_at, last_seen_at, suspect_clock, updated_at
       FROM license_state WHERE id = 1`,
  );
  if (existing) return existing;

  const at = nowIso();
  database.run(
    `INSERT INTO license_state
       (id, edition, licensee, email, seats, features_json, machine_id, key_hash,
        activated_at, last_seen_at, suspect_clock, updated_at)
     VALUES (1, 'community', NULL, NULL, 1, ?, NULL, NULL, NULL, NULL, 0, ?)`,
    [JSON.stringify(EDITION_FEATURES.community), at],
  );
  database.markDirty();
  const created = database.one<LicenseRow>(
    `SELECT id, edition, licensee, email, seats, features_json, machine_id, key_hash,
            activated_at, last_seen_at, suspect_clock, updated_at
       FROM license_state WHERE id = 1`,
  );
  if (!created) throw new Error('license_state row could not be created');
  return created;
}

function parseFeatures(json: string, edition: LicenseEdition): readonly string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    logWarn('license', 'features_json is not valid JSON; falling back to the edition defaults');
  }
  return EDITION_FEATURES[edition];
}

/** The current licence, always including this machine's id. */
export function licenseStatus(): LicenseStatus {
  const row = ensureRow();
  const edition = normaliseEdition(row.edition);
  return {
    edition,
    licensee: row.licensee,
    email: row.email,
    seats: Number(row.seats),
    features: parseFeatures(row.features_json, edition),
    machineId: machineId(),
    keyHash: row.key_hash,
    activatedAt: row.activated_at,
    lastSeenAt: row.last_seen_at,
    suspectClock: row.suspect_clock === 1,
    updatedAt: row.updated_at,
    expiresAt: null,
  };
}

/** This machine's id, for the copyable field on the licence page. */
export function machineIdOf(): string {
  return machineId();
}

/** Feature flags for the active edition. */
export function features(): readonly string[] {
  return licenseStatus().features;
}

/** True when the edition is at least `required`. */
export function hasEdition(required: LicenseEdition): boolean {
  const order: readonly LicenseEdition[] = ['community', 'pro', 'enterprise'];
  return order.indexOf(licenseStatus().edition) >= order.indexOf(required);
}

/**
 * Compares the wall clock against the last time we saw it. A backwards jump of
 * more than five minutes sets `suspect_clock = 1` and returns `true`.
 * Never throws, never blocks.
 */
export function checkClockRollback(): boolean {
  const now = Date.now();
  let lastSeen = 0;
  try {
    const raw = fs.readFileSync(stampPath(), 'utf8').trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) lastSeen = parsed;
  } catch {
    lastSeen = 0;
  }

  const suspect = lastSeen > 0 && now < lastSeen - CLOCK_TOLERANCE_MS;

  try {
    fs.mkdirSync(path.dirname(stampPath()), { recursive: true });
    fs.writeFileSync(stampPath(), String(Math.max(now, lastSeen)), 'utf8');
  } catch (error) {
    logWarn('license.stamp', `cannot write clock stamp: ${String(error)}`);
  }

  const database = conn();
  const row = ensureRow();
  if (suspect && row.suspect_clock !== 1) {
    database.run('UPDATE license_state SET suspect_clock = 1, updated_at = ? WHERE id = 1', [nowIso()]);
    database.markDirty();
    logWarn('license', 'system clock moved backwards; flagging suspect_clock (no lockout)');
  }
  if (!suspect && row.suspect_clock === 1 && lastSeen > 0) {
    // The clock caught up again: clear the warning rather than nagging forever.
    database.run('UPDATE license_state SET suspect_clock = 0, updated_at = ? WHERE id = 1', [nowIso()]);
    database.markDirty();
  }

  return suspect;
}

/** Records the heartbeat used by the clock check. */
export function touchLastSeen(): void {
  const database = conn();
  ensureRow();
  database.run('UPDATE license_state SET last_seen_at = ?, updated_at = ? WHERE id = 1', [
    nowIso(),
    nowIso(),
  ]);
}

function writeActivationFile(key: string): void {
  try {
    fs.mkdirSync(path.dirname(activationKeyPath()), { recursive: true });
    fs.writeFileSync(activationKeyPath(), key.trim(), { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    logWarn('license.file', `cannot store the activation key: ${String(error)}`);
  }
}

function removeActivationFile(): void {
  try {
    fs.rmSync(activationKeyPath(), { force: true });
  } catch {
    // Not fatal: the database state is what matters.
  }
}

function applyPayload(payload: LicensePayload, key: string): void {
  const database = conn();
  ensureRow();
  const at = nowIso();
  database.run(
    `UPDATE license_state
        SET edition = ?, licensee = ?, email = ?, seats = ?, features_json = ?,
            machine_id = ?, key_hash = ?, activated_at = ?, last_seen_at = ?, updated_at = ?
      WHERE id = 1`,
    [
      payload.edition,
      payload.licensee,
      payload.email === '' ? null : payload.email,
      payload.seats,
      JSON.stringify(EDITION_FEATURES[payload.edition]),
      machineId(),
      hashKey(key),
      at,
      at,
      at,
    ],
  );
  database.markDirty();
}

/**
 * Verifies and applies a key. Signature first, machine binding second — a
 * tampered key is `VALIDATION`, a key for another machine is `LICENSE`.
 */
export function activate(key: string, actor: AuditActor = SYSTEM_ACTOR): LicenseStatus {
  const payload = verifyKey(key, machineId());
  const database = conn();

  database.tx(() => {
    applyPayload(payload, key);
    auditLog.append({
      ...actor,
      entity: 'license',
      entityId: '1',
      action: 'activated',
      after: {
        edition: payload.edition,
        licensee: payload.licensee,
        seats: payload.seats,
        machineId: machineId(),
      },
    });
  });

  writeActivationFile(key);
  return licenseStatus();
}

/** Returns to Community. Audited; the data is untouched. */
export function deactivate(reason?: string, actor: AuditActor = SYSTEM_ACTOR): LicenseStatus {
  const before = licenseStatus();
  const database = conn();
  database.tx(() => {
    ensureRow();
    database.run(
      `UPDATE license_state
          SET edition = 'community', licensee = NULL, email = NULL, seats = 1,
              features_json = ?, machine_id = NULL, key_hash = NULL,
              activated_at = NULL, updated_at = ?
        WHERE id = 1`,
      [JSON.stringify(EDITION_FEATURES.community), nowIso()],
    );
    auditLog.append({
      ...actor,
      entity: 'license',
      entityId: '1',
      action: 'deactivated',
      before: { edition: before.edition, licensee: before.licensee },
      after: { edition: 'community' },
      meta: reason ? { reason } : undefined,
    });
  });
  database.markDirty();
  removeActivationFile();
  return licenseStatus();
}

/** Startup step: flag a rolled-back clock and record the heartbeat. */
export function onStartup(): { readonly suspectClock: boolean } {
  const suspect = checkClockRollback();
  touchLastSeen();
  return { suspectClock: suspect };
}
