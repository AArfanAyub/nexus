/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * User and role administration.
 *
 * Two rules shape this file:
 *   - **Disable, never delete.** A user with audit rows is refused a hard delete
 *     and offered `setActive(false)` instead (BR-22, US-08).
 *   - **The last owner cannot be removed.** There must always be somebody who
 *     can activate a licence and restore a backup.
 *
 * Password hashing and permission resolution live in `auth.ts`; this module
 * imports them so the dependency graph stays one-directional (users → auth).
 */

import { randomUUID } from 'node:crypto';

import { nowIso } from '../../shared/dates';
import {
  ROLE_PRESETS,
  ROLE_PRESET_IDS,
  isPermission,
  type Permission,
  type RolePresetId,
} from '../../shared/permissions';
import type { Role, User } from '../../shared/types';
import { conn } from '../db/connection';
import { authRequired, conflict, notFound, validation } from '../errors';

import * as auditLog from './audit';
import {
  assertPasswordStrength,
  currentSession,
  findUserById,
  hashPassword,
  permissionsFor,
  toUser,
  userCount,
  type UserRow,
} from './auth';
interface RoleRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly is_system: number;
  readonly permissions_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function parsePermissions(json: string): readonly Permission[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is Permission => typeof entry === 'string' && isPermission(entry));
}

function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: row.is_system === 1,
    permissions: parsePermissions(row.permissions_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function actor(): { readonly actorId: string | null; readonly actorName: string } {
  const session = currentSession();
  if (!session) return { actorId: null, actorName: 'system' };
  return { actorId: session.userId, actorName: session.username };
}

// ── roles ────────────────────────────────────────────────────────────────────

/**
 * Seeds the six role presets. Idempotent: a role that already exists by name is
 * left untouched, so a re-run never overwrites an administrator's edits.
 */
export function ensureRolePresets(): void {
  const database = conn();
  const existing = new Set(
    database.all<{ name: string }>('SELECT name FROM roles WHERE deleted_at IS NULL').map((row) => row.name),
  );
  const missing = ROLE_PRESET_IDS.filter((id) => !existing.has(ROLE_PRESETS[id].name));
  if (missing.length === 0) return;

  const at = nowIso();
  database.tx(() => {
    for (const id of missing) {
      const preset = ROLE_PRESETS[id];
      database.run(
        `INSERT INTO roles (id, name, description, is_system, permissions_json, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
        [randomUUID(), preset.name, preset.description, JSON.stringify(preset.permissions), at, at],
      );
    }
  });
  database.markDirty();
}

/** All live roles, alphabetically. */
export function listRoles(): readonly Role[] {
  return conn()
    .all<RoleRow>(
      `SELECT id, name, description, is_system, permissions_json, created_at, updated_at
         FROM roles WHERE deleted_at IS NULL ORDER BY name`,
    )
    .map(toRole);
}

/** A role or `NOT_FOUND`. */
export function getRole(id: string): Role {
  const row = conn().one<RoleRow>(
    `SELECT id, name, description, is_system, permissions_json, created_at, updated_at
       FROM roles WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  if (!row) throw notFound('Role');
  return toRole(row);
}

/** The role id for a preset, used by the first-run owner path. */
function roleIdForPreset(preset: RolePresetId): string {
  const row = conn().one<{ id: string }>(
    'SELECT id FROM roles WHERE name = ? AND deleted_at IS NULL',
    [ROLE_PRESETS[preset].name],
  );
  if (!row) throw notFound(`Role "${ROLE_PRESETS[preset].name}"`);
  return row.id;
}

/** Copies a role under a new name (the role editor's "Duplicate" action). */
export function duplicateRole(id: string, name: string): Role {
  const source = getRole(id);
  const trimmed = name.trim();
  if (trimmed.length < 2) throw validation('name', 'Give the role a name of at least 2 characters.');
  const clash = conn().one<{ id: string }>('SELECT id FROM roles WHERE name = ? AND deleted_at IS NULL', [
    trimmed,
  ]);
  if (clash) throw conflict(`A role named "${trimmed}" already exists.`);

  const database = conn();
  const newId = randomUUID();
  const at = nowIso();
  database.tx(() => {
    database.run(
      `INSERT INTO roles (id, name, description, is_system, permissions_json, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
      [newId, trimmed, source.description, JSON.stringify(source.permissions), at, at],
    );
    auditLog.append({
      ...actor(),
      entity: 'role',
      entityId: newId,
      action: 'duplicate',
      after: { name: trimmed, from: source.name },
    });
  });
  database.markDirty();
  return getRole(newId);
}

/** Writes a role's permission list, refusing unknown keys. */
export function setRolePermissions(id: string, permissions: readonly string[]): Role {
  const role = getRole(id);
  const cleaned: Permission[] = [];
  for (const key of permissions) {
    if (!isPermission(key)) throw validation('permissions', `Unknown permission: ${key}`);
    if (!cleaned.includes(key)) cleaned.push(key);
  }

  const database = conn();
  database.tx(() => {
    database.run('UPDATE roles SET permissions_json = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(cleaned),
      nowIso(),
      id,
    ]);
    auditLog.append({
      ...actor(),
      entity: 'role',
      entityId: id,
      action: 'permissions_changed',
      before: { permissions: role.permissions },
      after: { permissions: cleaned },
    });
  });
  database.markDirty();
  return getRole(id);
}

// ── users ────────────────────────────────────────────────────────────────────

/** All live users, by username. */
export function listUsers(): readonly User[] {
  return conn()
    .all<UserRow>(
      `SELECT id, username, full_name, email, password_hash, password_salt, password_algo,
              must_change_password, is_active, is_owner, prefs_json, failed_attempts,
              locked_until, last_login_at, created_at, updated_at, deleted_at
         FROM users WHERE deleted_at IS NULL ORDER BY username`,
    )
    .map(toUser);
}

/** A user or `NOT_FOUND`. */
export function getUser(id: string): User {
  const row = findUserById(id);
  if (!row) throw notFound('User');
  return toUser(row);
}

export interface CreateUserInput {
  readonly username: string;
  readonly fullName: string;
  readonly email?: string;
  readonly password: string;
  readonly roleIds: readonly string[];
}

/**
 * Creates a user.
 *
 * **First-run exception.** While `users` is empty there is no session to
 * authorise against — that is the bootstrap owner created before onboarding
 * (T04 replaces this path with the wizard). It is forced to `is_owner = 1` and
 * audited as `user.bootstrap_owner`.
 */
export function createUser(input: CreateUserInput): User {
  const database = conn();
  const username = input.username.trim().toLowerCase();
  const isFirstRun = userCount() === 0;

  // The channel is reachable without a session (first run), so the guard lives
  // here: once anybody exists, creating a user requires a signed-in caller.
  if (!isFirstRun && currentSession() === null) {
    throw authRequired('Sign in before creating users.');
  }

  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw validation('username', 'Use 3-64 characters: letters, numbers, dot, dash or underscore.');
  }
  const clash = database.one<{ id: string }>('SELECT id FROM users WHERE username = ?', [username]);
  if (clash) throw conflict(`The username "${username}" is already taken.`);

  assertPasswordStrength(input.password, username);

  const roleIds = input.roleIds.length > 0 ? input.roleIds : isFirstRun ? [roleIdForPreset('owner')] : [];
  for (const roleId of roleIds) getRole(roleId);

  const id = randomUUID();
  const at = nowIso();
  const secret = hashPassword(input.password);

  database.tx(() => {
    database.run(
      `INSERT INTO users
         (id, username, full_name, email, password_hash, password_salt, password_algo,
          must_change_password, is_active, is_owner, prefs_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '{}', ?, ?)`,
      [
        id,
        username,
        input.fullName.trim(),
        input.email?.trim() ?? null,
        secret.hash,
        secret.salt,
        secret.algo,
        isFirstRun ? 0 : 1,
        isFirstRun ? 1 : 0,
        at,
        at,
      ],
    );
    for (const roleId of roleIds) {
      database.run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [id, roleId]);
    }
    auditLog.append({
      ...actor(),
      entity: 'user',
      entityId: id,
      action: isFirstRun ? 'bootstrap_owner' : 'create',
      after: { username, fullName: input.fullName, roleIds },
    });
  });
  database.markDirty();

  return getUser(id);
}

export interface UpdateUserInput {
  readonly id: string;
  readonly fullName?: string;
  readonly email?: string;
  readonly roleIds?: readonly string[];
  readonly prefs?: Readonly<Record<string, unknown>>;
}

/** Updates profile fields, roles and preferences. */
export function updateUser(input: UpdateUserInput): User {
  const row = findUserById(input.id);
  if (!row) throw notFound('User');
  const before = toUser(row);

  const database = conn();
  database.tx(() => {
    if (input.fullName !== undefined) {
      database.run('UPDATE users SET full_name = ?, updated_at = ? WHERE id = ?', [
        input.fullName.trim(),
        nowIso(),
        input.id,
      ]);
    }
    if (input.email !== undefined) {
      database.run('UPDATE users SET email = ?, updated_at = ? WHERE id = ?', [
        input.email.trim() === '' ? null : input.email.trim(),
        nowIso(),
        input.id,
      ]);
    }
    if (input.prefs !== undefined) {
      database.run('UPDATE users SET prefs_json = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(input.prefs),
        nowIso(),
        input.id,
      ]);
    }
    if (input.roleIds !== undefined) {
      for (const roleId of input.roleIds) getRole(roleId);
      database.run('DELETE FROM user_roles WHERE user_id = ?', [input.id]);
      for (const roleId of input.roleIds) {
        database.run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [input.id, roleId]);
      }
    }
    auditLog.append({
      ...actor(),
      entity: 'user',
      entityId: input.id,
      action: 'update',
      before,
      after: { ...input },
    });
  });
  database.markDirty();

  return getUser(input.id);
}

/** Enables or disables an account. The alternative to deleting it (BR-22). */
export function setActive(id: string, active: boolean, reason?: string): User {
  const row = findUserById(id);
  if (!row) throw notFound('User');
  if (!active) {
    const session = currentSession();
    if (session && session.userId === id) {
      throw conflict('You cannot disable the account you are signed in with.');
    }
    if (row.is_owner === 1) {
      const owners = conn().one<{ total: number }>(
        'SELECT COUNT(*) AS total FROM users WHERE is_owner = 1 AND is_active = 1 AND deleted_at IS NULL',
      );
      if (owners && Number(owners.total) <= 1) {
        throw conflict('This is the only active owner. Make another user an owner first.');
      }
    }
  }

  const database = conn();
  database.tx(() => {
    database.run('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?', [
      active ? 1 : 0,
      nowIso(),
      id,
    ]);
    auditLog.append({
      ...actor(),
      entity: 'user',
      entityId: id,
      action: active ? 'enable' : 'disable',
      before: { isActive: row.is_active === 1 },
      after: { isActive: active },
      meta: reason ? { reason } : undefined,
    });
  });
  database.markDirty();

  return getUser(id);
}

/** Sets a new password on behalf of another user. */
export function resetPassword(id: string, newPassword: string, mustChange: boolean): void {
  const row = findUserById(id);
  if (!row) throw notFound('User');
  assertPasswordStrength(newPassword, row.username);

  const secret = hashPassword(newPassword);
  const database = conn();
  database.tx(() => {
    database.run(
      `UPDATE users SET password_hash = ?, password_salt = ?, password_algo = ?,
                        must_change_password = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE id = ?`,
      [secret.hash, secret.salt, secret.algo, mustChange ? 1 : 0, nowIso(), id],
    );
    auditLog.append({
      ...actor(),
      entity: 'user',
      entityId: id,
      action: 'password_reset',
      meta: { mustChange },
    });
  });
  database.markDirty();
}

/**
 * Hard delete, only for a user with no history. Everything else is refused with
 * a message that offers the supported alternative (US-08).
 */
export function deleteUser(id: string): void {
  const row = findUserById(id);
  if (!row) throw notFound('User');
  const history = auditLog.countForEntity('user', id);
  if (history > 0) {
    throw conflict(
      `${row.username} has ${String(history)} audit entries and cannot be deleted. Disable the account instead — it keeps the history intact and blocks sign-in.`,
    );
  }

  const database = conn();
  database.tx(() => {
    database.run('DELETE FROM user_roles WHERE user_id = ?', [id]);
    database.run('DELETE FROM users WHERE id = ?', [id]);
    auditLog.append({
      ...actor(),
      entity: 'user',
      entityId: id,
      action: 'delete',
      before: { username: row.username },
    });
  });
  database.markDirty();
}

/** Union of the permissions of every role the user holds. */
export function permissionsForUser(userId: string): ReadonlySet<Permission> {
  return permissionsFor(userId);
}
