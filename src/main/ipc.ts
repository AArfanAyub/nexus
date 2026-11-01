/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The envelope dispatcher. Every privileged action in the product goes through
 * `dispatch()` and no step can be skipped (ARCHITECTURE §C.1):
 *
 *   1. channel in the allow-list        → else FORBIDDEN
 *   2. payload shape validation         → else VALIDATION (+ `details.field`)
 *   3. session resolution               → else AUTH_REQUIRED
 *   4. RBAC against the channel's map   → else FORBIDDEN
 *   5. BEGIN → handler → audit → COMMIT → markDirty
 *   6. any throw → ROLLBACK, map to a code, log the stack locally only
 *
 * The permission requirement is a property of the channel map, not of the
 * handler, so a channel cannot be registered without one (this is what makes
 * BR-20 structural rather than a review habit).
 */

import { app, ipcMain } from 'electron';

import {
  CHANNEL_PERMISSIONS,
  INVOKE_MESSAGE,
  NO_SESSION_CHANNELS,
  PUBLIC,
  READ_ONLY_CHANNELS,
  SELF_AUDITING_CHANNELS,
  isChannel,
  type Channel,
  type ChannelRequirement,
  type EntityOp,
} from '../shared/channels';
import { nowIso } from '../shared/dates';
import { isPermission, permissionGroups, type Permission } from '../shared/permissions';
import { validatePayload } from '../shared/schemas';
import {
  ENTITIES,
  isEntityName,
  type ApiResult,
  type LoginResult,
  type NexusError,
  type NodePlatform,
} from '../shared/types';
import { conn } from './db/connection';
import {
  AppError,
  authRequired,
  forbidden,
  isAppError,
  notFound,
  validation,
} from './errors';
import { logError, logWarn } from './log';
import { isAppUrl } from './security';
import { registerEntityChannels } from './ipc.entity';
import { registerDocumentChannels } from './ipc.documents';
import { registerFinanceChannels } from './ipc.finance';
import { registerOpsChannels } from './ipc.ops';
import { registerCrmChannels } from './ipc.crm';
import { registerAdminChannels } from './ipc.admin';
import { registerSettingsChannels } from './ipc.settings';
import * as auditLog from './services/audit';
import * as auth from './services/auth';
import * as license from './services/license';
import * as users from './services/users';

// Re-exported so services and tests import the documented path (CONVENTIONS §6).
export { AppError, conflict, forbidden, notFound, validation } from './errors';

export interface HandlerContext {
  readonly channel: Channel;
  readonly session: auth.ActiveSession | null;
  readonly actorId: string | null;
  readonly actorName: string;
  readonly permissions: ReadonlySet<Permission>;
  readonly now: string;
}

type Handler = (payload: unknown, ctx: HandlerContext) => unknown;

interface Registration {
  readonly channel: Channel;
  readonly handler: Handler;
}

const registry = new Map<Channel, Registration>();

// ── rate limiting ────────────────────────────────────────────────────────────

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMITED_CHANNELS: ReadonlySet<Channel> = new Set<Channel>(['auth.login', 'auth.unlock']);
const rateLimitBuckets = new Map<Channel, number[]>();

function assertRateLimit(channel: Channel): void {
  const now = Date.now();
  const bucket = (rateLimitBuckets.get(channel) ?? []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
  if (bucket.length >= RATE_LIMIT_MAX) {
    logWarn('ipc.rateLimit', `${channel} exceeded ${String(RATE_LIMIT_MAX)} attempts in 5 minutes`);
    throw new AppError(
      'FORBIDDEN',
      'Too many attempts. Wait five minutes before trying again — nothing was changed.',
    );
  }
  bucket.push(now);
  rateLimitBuckets.set(channel, bucket);
}

/** Clears a bucket after a successful authentication. */
function clearRateLimit(channel: Channel): void {
  rateLimitBuckets.delete(channel);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/** Resolves the permission a channel needs, including the `entity.*` family. */
function requiredPermission(channel: Channel, payload: unknown): Permission | null {
  const requirement: ChannelRequirement = CHANNEL_PERMISSIONS[channel];
  if (requirement === PUBLIC) return null;

  if (requirement.startsWith('entity.')) {
    const op = requirement.slice('entity.'.length) as EntityOp;
    const entityName = isRecord(payload) && typeof payload.entity === 'string' ? payload.entity : '';
    if (!isEntityName(entityName)) {
      throw validation('entity', 'That is not a record type this build knows about.');
    }
    const meta = ENTITIES[entityName];
    if (op === 'read') return meta.read;
    if (op === 'write') return meta.write;
    if (op === 'delete') return meta.remove ?? meta.write;
    return 'documents.export';
  }

  // Anything left must be a real permission; if it is not, the channel map is
  // wrong and failing closed is the only safe answer.
  if (!isPermission(requirement)) {
    throw new AppError('INTERNAL', 'This action is misconfigured and cannot run. Nothing was changed.');
  }
  return requirement;
}

/** Appends the standard audit row for a mutating channel. */
function autoAudit(channel: Channel, ctx: HandlerContext, result: unknown): void {
  if (READ_ONLY_CHANNELS.has(channel) || SELF_AUDITING_CHANNELS.has(channel)) return;
  const [entity = channel, ...rest] = channel.split('.');
  const entityId = isRecord(result) && typeof result.id === 'string' ? result.id : null;
  auditLog.append({
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    entity,
    entityId,
    action: rest.length > 0 ? rest.join('.') : channel,
    after: result ?? null,
  });
}

/** Maps any throw to a wire error. Nothing internal escapes. */
function toWireError(channel: Channel, error: unknown): NexusError {
  if (isAppError(error)) {
    return { code: error.code, message: error.message, details: error.details };
  }

  const detail = logError('ipc.dispatch', error, { channel });
  const text = detail.toLowerCase();

  // SQLite constraint violations are the caller's conflict, not a crash.
  if (text.includes('constraint failed') || text.includes('unique constraint')) {
    return {
      code: 'CONFLICT',
      message: 'That change conflicts with existing data — a value that must be unique is already used.',
    };
  }
  if (text.includes('foreign key constraint')) {
    return {
      code: 'CONFLICT',
      message: 'That record is still referenced by another record, so it cannot be removed.',
    };
  }

  return {
    code: 'INTERNAL',
    message: 'Something went wrong and nothing was changed. Try again; if it repeats, check the log file.',
  };
}

/** Executes a handler inside a transaction when it mutates. */
function execute(
  registration: Registration,
  channel: Channel,
  payload: unknown,
  ctx: HandlerContext,
): unknown {
  // Read-only channels need no transaction. Self-auditing channels manage their
  // own transaction because their failure path must still persist evidence —
  // a rolled-back `login_failed` audit row would erase the brute-force trail.
  if (READ_ONLY_CHANNELS.has(channel) || SELF_AUDITING_CHANNELS.has(channel)) {
    return registration.handler(payload, ctx);
  }

  const database = conn();
  const result = database.tx(() => {
    const value = registration.handler(payload, ctx);
    if (isThenable(value)) {
      throw new AppError(
        'INTERNAL',
        'This action is misconfigured (a mutating handler returned a promise). Nothing was changed.',
      );
    }
    autoAudit(channel, ctx, value);
    return value;
  });
  database.markDirty();
  return result;
}

// ── public surface ───────────────────────────────────────────────────────────

/**
 * Registers a channel handler. The permission comes from `CHANNEL_PERMISSIONS`,
 * so there is no way to register an unguarded channel.
 */
export function register<P, R>(definition: {
  readonly channel: Channel;
  readonly handler: (payload: P, ctx: HandlerContext) => R;
}): void {
  registry.set(definition.channel, {
    channel: definition.channel,
    // The payload has already been shape-validated against SCHEMAS, so widening
    // the typed parameter to `unknown` is sound. The cast is confined to here.
    handler: definition.handler as unknown as Handler,
  });
}

/**
 * The shape of `register`, handed to feature modules (`ipc.entity.ts`,
 * `ipc.settings.ts`) so they can add channels without importing this module at
 * runtime — which would be a require cycle.
 */
export type RegisterFn = typeof register;

/** Dispatches one envelope. Never throws. */
export async function dispatch(channelValue: unknown, payload: unknown): Promise<ApiResult<unknown>> {
  if (typeof channelValue !== 'string' || !isChannel(channelValue)) {
    return {
      ok: false,
      error: { code: 'FORBIDDEN', message: 'That action is not available in this application.' },
    };
  }
  const channel: Channel = channelValue;

  const registration = registry.get(channel);
  if (!registration) {
    return {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'That action is not available yet in this build.',
      },
    };
  }

  try {
    const validated = validatePayload(channel, payload);
    if (!validated.ok) {
      const first = validated.issues[0];
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: first ? first.message : 'The request was not understood.',
          details: { field: first?.path ?? 'payload', issues: validated.issues },
        },
      };
    }
    const cleanPayload = validated.value;

    const requiresSession = !NO_SESSION_CHANNELS.has(channel);
    const session = requiresSession ? auth.requireSession() : auth.currentSession();
    const permission = requiredPermission(channel, cleanPayload);

    if (permission && session && !session.permissions.has(permission)) {
      throw forbidden(permission);
    }

    if (RATE_LIMITED_CHANNELS.has(channel)) assertRateLimit(channel);

    const ctx: HandlerContext = {
      channel,
      session,
      actorId: session?.userId ?? null,
      actorName: session?.username ?? 'system',
      permissions: session?.permissions ?? new Set<Permission>(),
      now: nowIso(),
    };

    const result = execute(registration, channel, cleanPayload, ctx);
    const data = isThenable(result) ? await result : result;

    if (RATE_LIMITED_CHANNELS.has(channel)) clearRateLimit(channel);

    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: toWireError(channel, error) };
  }
}

/** True when a channel has a handler in this build. */
export function isRegistered(channel: Channel): boolean {
  return registry.has(channel);
}

/** Registered channels, for the diagnostics panel. */
export function registeredChannels(): readonly Channel[] {
  return [...registry.keys()].sort();
}

// ── registrations (T02 surface) ──────────────────────────────────────────────

interface LoginPayload {
  readonly username: string;
  readonly password: string;
}
interface UnlockPayload {
  readonly password: string;
}
interface PasswordChangePayload {
  readonly currentPassword: string;
  readonly newPassword: string;
}
interface PrefsPayload {
  readonly theme?: 'light' | 'dark';
  readonly density?: 'compact' | 'comfortable';
  readonly accent?: 'blue' | 'teal' | 'violet' | 'amber';
  readonly sidebarCollapsed?: boolean;
  readonly locale?: string;
}
interface UserCreatePayload {
  readonly username: string;
  readonly fullName: string;
  readonly email?: string;
  readonly password: string;
  readonly roleIds: readonly string[];
}
interface UserUpdatePayload {
  readonly id: string;
  readonly fullName?: string;
  readonly email?: string;
  readonly roleIds?: readonly string[];
  readonly prefs?: Readonly<Record<string, unknown>>;
}
interface UserSetActivePayload {
  readonly id: string;
  readonly active: boolean;
  readonly reason?: string;
}
interface UserResetPasswordPayload {
  readonly id: string;
  readonly newPassword: string;
  readonly mustChange: boolean;
}
interface RoleDuplicatePayload {
  readonly id: string;
  readonly name: string;
}
interface LicenseActivatePayload {
  readonly key: string;
}
interface LicenseDeactivatePayload {
  readonly reason?: string;
}
interface SettingsGetPayload {
  readonly keys?: readonly string[];
}
interface AuditListPayload {
  readonly actorId?: string;
  readonly entity?: string;
  readonly entityId?: string;
  readonly action?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Registers every T02 channel handler. Kept separate from `registerIpc()` so
 * the dispatcher can be exercised without an Electron `ipcMain` (see
 * `tests/core.test.cjs`).
 */
export function registerChannels(): void {
  register({
    channel: 'app.bootstrap',
    handler: () =>
      auth.bootstrap({ platform: process.platform as NodePlatform, version: app.getVersion() }),
  });

  register({
    channel: 'app.quit',
    handler: () => {
      app.quit();
      return null;
    },
  });

  register<PrefsPayload, Record<string, unknown>>({
    channel: 'app.prefs.save',
    handler: (payload) => {
      const session = auth.requireSession();
      const row = auth.findUserById(session.userId);
      if (!row) throw notFound('User');
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(row.prefs_json) as Record<string, unknown>;
      } catch {
        current = {};
      }
      const merged = { ...current, ...payload };
      conn().run('UPDATE users SET prefs_json = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(merged),
        nowIso(),
        session.userId,
      ]);
      return merged;
    },
  });

  register<LoginPayload, LoginResult>({
    channel: 'auth.login',
    handler: (payload) => auth.login(payload.username, payload.password),
  });

  register<UnlockPayload, LoginResult>({
    channel: 'auth.unlock',
    handler: (payload) => auth.unlock(payload.password),
  });

  register({
    channel: 'auth.lock',
    handler: () => auth.lock(),
  });

  register({
    channel: 'auth.logout',
    handler: () => {
      auth.logout();
      return null;
    },
  });

  register({
    channel: 'auth.session',
    handler: () => auth.sessionSummary(),
  });

  register<PasswordChangePayload, null>({
    channel: 'auth.password.change',
    handler: (payload) => {
      auth.changePassword(payload.currentPassword, payload.newPassword);
      return null;
    },
  });

  register({
    channel: 'auth.heartbeat',
    handler: () => auth.heartbeat(),
  });

  register({
    channel: 'onboarding.status',
    handler: () => {
      const company = conn().one<{ total: number }>('SELECT COUNT(*) AS total FROM companies');
      const hasCompany = company ? Number(company.total) > 0 : false;
      const complete = hasCompany && auth.userCount() > 0;
      return { complete, step: complete ? 5 : hasCompany ? 4 : 1 };
    },
  });

  register<UserCreatePayload, unknown>({
    channel: 'users.create',
    handler: (payload) => users.createUser(payload),
  });

  register<UserUpdatePayload, unknown>({
    channel: 'users.update',
    handler: (payload) => users.updateUser(payload),
  });

  register<UserSetActivePayload, unknown>({
    channel: 'users.setActive',
    handler: (payload) => users.setActive(payload.id, payload.active, payload.reason),
  });

  register<UserResetPasswordPayload, null>({
    channel: 'users.resetPassword',
    handler: (payload) => {
      users.resetPassword(payload.id, payload.newPassword, payload.mustChange);
      return null;
    },
  });

  register<RoleDuplicatePayload, unknown>({
    channel: 'roles.duplicate',
    handler: (payload) => users.duplicateRole(payload.id, payload.name),
  });

  register({
    channel: 'permissions.catalog',
    handler: () => ({ groups: permissionGroups() }),
  });

  register<SettingsGetPayload, Record<string, unknown>>({
    channel: 'settings.get',
    handler: (payload) => {
      const keys = payload.keys ?? [];
      const database = conn();
      const rows =
        keys.length > 0
          ? database.all<{ key: string; value_json: string }>(
              `SELECT key, value_json FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`,
              keys,
            )
          : database.all<{ key: string; value_json: string }>('SELECT key, value_json FROM settings');
      const output: Record<string, unknown> = {};
      for (const row of rows) {
        try {
          output[row.key] = JSON.parse(row.value_json);
        } catch {
          output[row.key] = row.value_json;
        }
      }
      return output;
    },
  });

  register<AuditListPayload, unknown>({
    channel: 'audit.list',
    handler: (payload) => auditLog.list(payload),
  });

  register({
    channel: 'audit.verify',
    handler: () => auditLog.verify(),
  });

  register({
    channel: 'license.status',
    handler: () => license.licenseStatus(),
  });

  register<LicenseActivatePayload, unknown>({
    channel: 'license.activate',
    handler: (payload, ctx) =>
      license.activate(payload.key, { actorId: ctx.actorId, actorName: ctx.actorName }),
  });

  register<LicenseDeactivatePayload, unknown>({
    channel: 'license.deactivate',
    handler: (payload, ctx) =>
      license.deactivate(payload.reason, { actorId: ctx.actorId, actorName: ctx.actorName }),
  });

  register({
    channel: 'license.machineId',
    handler: () => ({ machineId: license.machineIdOf() }),
  });

  // Feature modules register through the same `register`, so their channels are
  // subject to the identical allow-list → validate → session → RBAC pipeline.
  registerEntityChannels(register);
  registerSettingsChannels(register);
  registerFinanceChannels(register);
  registerOpsChannels(register);
  registerDocumentChannels(register);
  registerCrmChannels(register);
  registerAdminChannels(register);
}

/** Registers the channels and wires the single `ipcMain` invoke handler. */
export function registerIpc(): void {
  registerChannels();

  ipcMain.handle(INVOKE_MESSAGE, async (event, request: unknown) => {
    const senderUrl = event.senderFrame?.url ?? '';
    if (senderUrl !== '' && !isAppUrl(senderUrl)) {
      logWarn('ipc.sender', `rejected a request from ${senderUrl}`);
      return {
        ok: false,
        error: { code: 'FORBIDDEN', message: 'That request did not come from the application window.' },
      } satisfies ApiResult<unknown>;
    }
    if (!isRecord(request)) {
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'The request was not understood.' },
      } satisfies ApiResult<unknown>;
    }
    return dispatch(request.channel, request.payload);
  });
}

/** Permission for a channel, exposed for the unit test that walks CHANNELS. */
export function permissionFor(channel: Channel): ChannelRequirement {
  return CHANNEL_PERMISSIONS[channel];
}

/** True when a permission key is real (used by the role editor). */
export function permissionExists(value: string): boolean {
  return isPermission(value);
}

/** Guard kept for parity with `authRequired`; throws when there is no session. */
export function assertSession(): auth.ActiveSession {
  const session = auth.currentSession();
  if (!session) throw authRequired();
  return session;
}
