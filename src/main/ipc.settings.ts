/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Settings, onboarding and notification channels (§C.3, §C.5, §C.11).
 *
 * The one non-obvious rule here is **`onboarding.complete` is a single
 * transaction**: company → preset → chart of accounts → sequences → pipeline →
 * admin user → optional demo rows. If the demo step throws, the company and the
 * chart of accounts disappear with it, which is exactly what T04 acceptance #3
 * asks for. The licence is validated *before* the transaction and applied
 * *after* it, because it writes files that are not part of the database.
 */

import { randomUUID } from 'node:crypto';

import { INDUSTRY_PRESETS, previewOf } from '../shared/industry-presets';
import type { Address, Notification } from '../shared/types';
import { nowIso } from '../shared/dates';
import { conn } from './db/connection';
import { applyPreset, demoLoaded, removeDemo, seedDemo } from './db/seed';
import { conflict, notFound, validation } from './errors';
import type { RegisterFn } from './ipc';
import * as auditLog from './services/audit';
import { assertPasswordStrength, hashPassword } from './services/auth';
import { machineId } from './license/machine';
import { verifyKey } from './license/verify';
import * as license from './services/license';
import {
  companyExists,
  ensureFiscalYear,
  getCompany,
  listSequences,
  previewNumber,
  resetSequence,
  saveCompany,
  saveLogo,
  saveSecurity,
  saveSequence,
  setBaseCurrency,
  writeSetting,
  type CompanyPatch,
  type SequenceInput,
} from './services/settings';
import * as users from './services/users';
import { archiveOldRecords, archivePreview, archiveStats, restoreArchived, vacuum } from './services/archive';
import { benchmark, generatePerfDataset } from './services/perf';
import { searchGlobal, searchPalette } from './services/search';

// ── onboarding ───────────────────────────────────────────────────────────────

interface OnboardingCompany {
  readonly name: string;
  readonly legalName?: string;
  readonly taxId?: string;
  readonly address?: Address;
}

interface OnboardingAdmin {
  readonly username: string;
  readonly fullName: string;
  readonly email?: string;
  readonly password: string;
}

interface OnboardingPayload {
  readonly company: OnboardingCompany;
  readonly presetId: string;
  readonly currency: string;
  readonly fiscalStartMonth: number;
  readonly admin: OnboardingAdmin;
  readonly licenseKey?: string;
  readonly loadDemo?: boolean;
}

/**
 * Completes setup atomically. `conn().tx` is only entered here — `applyPreset`
 * and `seedDemo` are transaction *bodies*, so a throw rolls everything back.
 */
export function completeOnboarding(payload: OnboardingPayload): {
  readonly companyId: string;
  readonly seeded: number;
  readonly edition: string;
} {
  if (companyExists()) {
    throw conflict('This company file is already set up. Open Settings to make changes.');
  }
  const preset = INDUSTRY_PRESETS.find((candidate) => candidate.id === payload.presetId);
  if (!preset) throw validation('presetId', 'Pick one of the listed industries.');
  if (payload.company.name.trim().length < 2) {
    throw validation('company.name', 'Enter your company name.');
  }
  if (!Number.isInteger(payload.fiscalStartMonth) || payload.fiscalStartMonth < 1 || payload.fiscalStartMonth > 12) {
    throw validation('fiscalStartMonth', 'The fiscal year must start in a month between 1 and 12.');
  }
  assertPasswordStrength(payload.admin.password, payload.admin.username);

  // Validate the licence before anything is written, so a bad key cannot leave
  // a half-configured company behind.
  if (payload.licenseKey && payload.licenseKey.trim().length > 0) {
    verifyKey(payload.licenseKey.trim(), machineId());
  }

  const ownerRole = users.listRoles().find((role) => role.name === 'Owner');
  if (!ownerRole) throw notFound('Owner role');

  const companyId = randomUUID();
  const at = nowIso();
  let seeded = 0;

  conn().tx(() => {
    conn().run(
      `INSERT INTO companies (id, name, legal_name, tax_id, address_json, logo_path, base_currency,
         fiscal_year_start_month, date_format, number_format, industry_preset, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'yyyy-MM-dd', '1,234.56', ?, ?, ?)`,
      [
        companyId,
        payload.company.name.trim(),
        payload.company.legalName?.trim() || null,
        payload.company.taxId?.trim() || null,
        payload.company.address ? JSON.stringify(payload.company.address) : null,
        payload.currency,
        payload.fiscalStartMonth,
        preset.id,
        at,
        at,
      ],
    );

    applyPreset(preset.id, payload.currency);
    ensureFiscalYear(payload.fiscalStartMonth);

    const secret = hashPassword(payload.admin.password);
    const userId = randomUUID();
    conn().run(
      `INSERT INTO users (id, username, full_name, email, password_hash, password_salt, password_algo,
         must_change_password, is_active, is_owner, prefs_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 1, '{}', ?, ?)`,
      [
        userId,
        payload.admin.username.trim().toLowerCase(),
        payload.admin.fullName.trim(),
        payload.admin.email?.trim() || null,
        secret.hash,
        secret.salt,
        secret.algo,
        at,
        at,
      ],
    );
    conn().run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [userId, ownerRole.id]);

    if (payload.loadDemo) {
      seeded = seedDemo().created;
    }

    writeSetting('onboarding.complete', { at, presetId: preset.id, currency: payload.currency }, userId);
    writeSetting('license.notice.dismissed', false, userId);

    auditLog.append({
      actorId: userId,
      actorName: payload.admin.username.trim().toLowerCase(),
      entity: 'company',
      entityId: companyId,
      action: 'onboarding.complete',
      after: { name: payload.company.name, presetId: preset.id, currency: payload.currency, seeded },
    });
  });
  conn().markDirty();

  // Files, not rows: activating outside the transaction is safe because the
  // key was already verified above.
  const edition = payload.licenseKey && payload.licenseKey.trim().length > 0
    ? license.activate(payload.licenseKey.trim(), { actorId: null, actorName: 'onboarding' }).edition
    : license.licenseStatus().edition;

  return { companyId, seeded, edition };
}

// ── notifications ────────────────────────────────────────────────────────────

function toNotification(row: Record<string, unknown>): Notification {
  return {
    id: String(row['id']),
    userId: row['user_id'] === null ? null : String(row['user_id']),
    kind: String(row['kind']),
    title: String(row['title']),
    body: row['body'] === null ? null : String(row['body']),
    link: row['link'] === null ? null : String(row['link']),
    severity: String(row['severity']) as Notification['severity'],
    readAt: row['read_at'] === null ? null : String(row['read_at']),
    createdAt: String(row['created_at']),
  };
}

export function listNotifications(options: { readonly unreadOnly?: boolean; readonly limit?: number }): readonly Notification[] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 200);
  const rows = conn().all<Record<string, unknown>>(
    `SELECT * FROM notifications ${options.unreadOnly ? 'WHERE read_at IS NULL' : ''}
      ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
  return rows.map(toNotification);
}

export function markNotificationsRead(input: { readonly ids?: readonly string[]; readonly all?: boolean }): {
  readonly updated: number;
} {
  const at = nowIso();
  if (input.all) {
    const row = conn().one<{ total: number }>('SELECT COUNT(*) AS total FROM notifications WHERE read_at IS NULL');
    conn().run('UPDATE notifications SET read_at = ? WHERE read_at IS NULL', [at]);
    return { updated: Number(row?.total ?? 0) };
  }
  let updated = 0;
  for (const id of input.ids ?? []) {
    conn().run('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL', [at, id]);
    updated += 1;
  }
  return { updated };
}

// ── registration ─────────────────────────────────────────────────────────────

/** Registers the onboarding, settings and notification channels. */
export function registerSettingsChannels(register: RegisterFn): void {
  register<{ presetId: string }, unknown>({
    channel: 'onboarding.preview',
    handler: (payload) => {
      const preset = INDUSTRY_PRESETS.find((candidate) => candidate.id === payload.presetId);
      if (!preset) throw validation('presetId', 'Pick one of the listed industries.');
      return previewOf(preset);
    },
  });

  register<OnboardingPayload, unknown>({
    channel: 'onboarding.complete',
    handler: (payload) => completeOnboarding(payload),
  });

  register<CompanyPatch, unknown>({
    channel: 'settings.company.save',
    handler: (payload) => saveCompany(payload),
  });

  register<{ dataUrl: string }, { path: string }>({
    channel: 'settings.company.logo',
    handler: (payload) => conn().tx(() => saveLogo(payload.dataUrl)),
  });

  register<Record<string, never>, unknown>({
    channel: 'settings.numbering.list',
    handler: () => listSequences(),
  });

  register<SequenceInput, unknown>({
    channel: 'settings.numbering.save',
    handler: (payload) => conn().tx(() => saveSequence(payload)),
  });

  register<{ docType: string }, { next: string }>({
    channel: 'settings.numbering.preview',
    handler: (payload) => previewNumber(payload.docType),
  });

  register<{ docType: string; reason: string }, unknown>({
    channel: 'settings.numbering.reset',
    handler: (payload) => {
      if (!payload.reason || payload.reason.trim().length < 3) {
        throw validation('reason', 'Say why the sequence is being reset — it goes in the audit log.');
      }
      return conn().tx(() => resetSequence(payload.docType));
    },
  });

  register<{ code: string }, { refused?: string }>({
    channel: 'settings.currency.setBase',
    handler: (payload) => conn().tx(() => setBaseCurrency(payload.code)),
  });

  register<Record<string, never>, unknown>({
    channel: 'settings.presets.list',
    handler: () =>
      INDUSTRY_PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        description: preset.description,
        modules: preset.modules,
        landing: preset.landingModule,
      })),
  });

  register<{ presetId: string }, unknown>({
    channel: 'settings.presets.preview',
    handler: (payload) => {
        const preset = INDUSTRY_PRESETS.find((candidate) => candidate.id === payload.presetId);
        if (!preset) throw validation('presetId', 'Pick one of the listed industries.');
        return previewOf(preset);
      },
  });

  register<{ presetId: string; confirm: boolean }, unknown>({
    channel: 'settings.presets.apply',
    handler: (payload) => {
      if (!payload.confirm) {
        throw validation('confirm', 'Applying an industry preset adds accounts, taxes and fields. Confirm first.');
      }
      if (!getCompany()) throw notFound('Company');
      return conn().tx(() => applyPreset(payload.presetId));
    },
  });

  register<Record<string, never>, { created: number }>({
    channel: 'settings.demoData.seed',
    handler: () => {
      if (demoLoaded()) throw conflict('Demo data is already loaded. Remove it before seeding again.');
      return conn().tx(() => seedDemo());
    },
  });

  register<Record<string, never>, { removed: number }>({
    channel: 'settings.demoData.remove',
    handler: () => conn().tx(() => removeDemo()),
  });

  register<
    {
      idleTimeoutMin?: number;
      minPasswordLength?: number;
      requireSymbol?: boolean;
      maxAttempts?: number;
      lockoutMin?: number;
    },
    unknown
  >({
    channel: 'settings.security.save',
    handler: (payload) => conn().tx(() => saveSecurity(payload)),
  });

  register<{ unreadOnly?: boolean; limit?: number }, readonly Notification[]>({
    channel: 'notifications.list',
    handler: (payload) => listNotifications(payload),
  });

  register<{ ids?: readonly string[]; all?: boolean }, { updated: number }>({
    channel: 'notifications.markRead',
    handler: (payload) => conn().tx(() => markNotificationsRead(payload)),
  });

  // ── scale: performance fixtures, archive, search (R1) ──────────────────────
  register<{ customers?: number; products?: number; invoices?: number; seed?: number }, unknown>({
    channel: 'settings.perf.generate',
    handler: (payload) => generatePerfDataset(payload),
  });

  register<Record<string, never>, unknown>({
    channel: 'settings.perf.benchmark',
    handler: () => benchmark(),
  });

  register<{ before: string }, unknown>({
    channel: 'data.archive.preview',
    handler: (payload) => archivePreview(payload.before),
  });

  register<{ before: string; tables?: readonly string[]; reason?: string; limit?: number }, unknown>({
    channel: 'data.archive.run',
    handler: (payload, ctx) =>
      conn().tx(() =>
        archiveOldRecords({
          before: payload.before,
          tables: payload.tables,
          reason: payload.reason,
          limit: payload.limit,
          actorId: ctx.actorId,
        }),
      ),
  });

  register<{ id: string }, unknown>({
    channel: 'data.archive.restore',
    handler: (payload) => conn().tx(() => restoreArchived(payload.id)),
  });

  register<Record<string, never>, unknown>({
    channel: 'data.archive.stats',
    handler: () => archiveStats(),
  });

  register<Record<string, never>, unknown>({
    channel: 'data.archive.vacuum',
    handler: () => vacuum(),
  });

  register<{ q: string; limit?: number; kinds?: readonly string[] }, unknown>({
    channel: 'search.global',
    handler: (payload) => searchGlobal(payload.q, { limit: payload.limit, kinds: payload.kinds }),
  });

  register<{ q: string }, unknown>({
    channel: 'search.palette',
    handler: (payload) => searchPalette(payload.q),
  });
}
