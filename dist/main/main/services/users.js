"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureRolePresets = ensureRolePresets;
exports.listRoles = listRoles;
exports.getRole = getRole;
exports.duplicateRole = duplicateRole;
exports.setRolePermissions = setRolePermissions;
exports.listUsers = listUsers;
exports.getUser = getUser;
exports.createUser = createUser;
exports.updateUser = updateUser;
exports.setActive = setActive;
exports.resetPassword = resetPassword;
exports.deleteUser = deleteUser;
exports.permissionsForUser = permissionsForUser;
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
const node_crypto_1 = require("node:crypto");
const dates_1 = require("../../shared/dates");
const permissions_1 = require("../../shared/permissions");
const connection_1 = require("../db/connection");
const errors_1 = require("../errors");
const auditLog = __importStar(require("./audit"));
const auth_1 = require("./auth");
function parsePermissions(json) {
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return [];
    }
    if (!Array.isArray(parsed))
        return [];
    return parsed.filter((entry) => typeof entry === 'string' && (0, permissions_1.isPermission)(entry));
}
function toRole(row) {
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
function actor() {
    const session = (0, auth_1.currentSession)();
    if (!session)
        return { actorId: null, actorName: 'system' };
    return { actorId: session.userId, actorName: session.username };
}
// ── roles ────────────────────────────────────────────────────────────────────
/**
 * Seeds the six role presets. Idempotent: a role that already exists by name is
 * left untouched, so a re-run never overwrites an administrator's edits.
 */
function ensureRolePresets() {
    const database = (0, connection_1.conn)();
    const existing = new Set(database.all('SELECT name FROM roles WHERE deleted_at IS NULL').map((row) => row.name));
    const missing = permissions_1.ROLE_PRESET_IDS.filter((id) => !existing.has(permissions_1.ROLE_PRESETS[id].name));
    if (missing.length === 0)
        return;
    const at = (0, dates_1.nowIso)();
    database.tx(() => {
        for (const id of missing) {
            const preset = permissions_1.ROLE_PRESETS[id];
            database.run(`INSERT INTO roles (id, name, description, is_system, permissions_json, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`, [(0, node_crypto_1.randomUUID)(), preset.name, preset.description, JSON.stringify(preset.permissions), at, at]);
        }
    });
    database.markDirty();
}
/** All live roles, alphabetically. */
function listRoles() {
    return (0, connection_1.conn)()
        .all(`SELECT id, name, description, is_system, permissions_json, created_at, updated_at
         FROM roles WHERE deleted_at IS NULL ORDER BY name`)
        .map(toRole);
}
/** A role or `NOT_FOUND`. */
function getRole(id) {
    const row = (0, connection_1.conn)().one(`SELECT id, name, description, is_system, permissions_json, created_at, updated_at
       FROM roles WHERE id = ? AND deleted_at IS NULL`, [id]);
    if (!row)
        throw (0, errors_1.notFound)('Role');
    return toRole(row);
}
/** The role id for a preset, used by the first-run owner path. */
function roleIdForPreset(preset) {
    const row = (0, connection_1.conn)().one('SELECT id FROM roles WHERE name = ? AND deleted_at IS NULL', [permissions_1.ROLE_PRESETS[preset].name]);
    if (!row)
        throw (0, errors_1.notFound)(`Role "${permissions_1.ROLE_PRESETS[preset].name}"`);
    return row.id;
}
/** Copies a role under a new name (the role editor's "Duplicate" action). */
function duplicateRole(id, name) {
    const source = getRole(id);
    const trimmed = name.trim();
    if (trimmed.length < 2)
        throw (0, errors_1.validation)('name', 'Give the role a name of at least 2 characters.');
    const clash = (0, connection_1.conn)().one('SELECT id FROM roles WHERE name = ? AND deleted_at IS NULL', [
        trimmed,
    ]);
    if (clash)
        throw (0, errors_1.conflict)(`A role named "${trimmed}" already exists.`);
    const database = (0, connection_1.conn)();
    const newId = (0, node_crypto_1.randomUUID)();
    const at = (0, dates_1.nowIso)();
    database.tx(() => {
        database.run(`INSERT INTO roles (id, name, description, is_system, permissions_json, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`, [newId, trimmed, source.description, JSON.stringify(source.permissions), at, at]);
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
function setRolePermissions(id, permissions) {
    const role = getRole(id);
    const cleaned = [];
    for (const key of permissions) {
        if (!(0, permissions_1.isPermission)(key))
            throw (0, errors_1.validation)('permissions', `Unknown permission: ${key}`);
        if (!cleaned.includes(key))
            cleaned.push(key);
    }
    const database = (0, connection_1.conn)();
    database.tx(() => {
        database.run('UPDATE roles SET permissions_json = ?, updated_at = ? WHERE id = ?', [
            JSON.stringify(cleaned),
            (0, dates_1.nowIso)(),
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
function listUsers() {
    return (0, connection_1.conn)()
        .all(`SELECT id, username, full_name, email, password_hash, password_salt, password_algo,
              must_change_password, is_active, is_owner, prefs_json, failed_attempts,
              locked_until, last_login_at, created_at, updated_at, deleted_at
         FROM users WHERE deleted_at IS NULL ORDER BY username`)
        .map(auth_1.toUser);
}
/** A user or `NOT_FOUND`. */
function getUser(id) {
    const row = (0, auth_1.findUserById)(id);
    if (!row)
        throw (0, errors_1.notFound)('User');
    return (0, auth_1.toUser)(row);
}
/**
 * Creates a user.
 *
 * **First-run exception.** While `users` is empty there is no session to
 * authorise against — that is the bootstrap owner created before onboarding
 * (T04 replaces this path with the wizard). It is forced to `is_owner = 1` and
 * audited as `user.bootstrap_owner`.
 */
function createUser(input) {
    const database = (0, connection_1.conn)();
    const username = input.username.trim().toLowerCase();
    const isFirstRun = (0, auth_1.userCount)() === 0;
    // The channel is reachable without a session (first run), so the guard lives
    // here: once anybody exists, creating a user requires a signed-in caller.
    if (!isFirstRun && (0, auth_1.currentSession)() === null) {
        throw (0, errors_1.authRequired)('Sign in before creating users.');
    }
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
        throw (0, errors_1.validation)('username', 'Use 3-64 characters: letters, numbers, dot, dash or underscore.');
    }
    const clash = database.one('SELECT id FROM users WHERE username = ?', [username]);
    if (clash)
        throw (0, errors_1.conflict)(`The username "${username}" is already taken.`);
    (0, auth_1.assertPasswordStrength)(input.password, username);
    const roleIds = input.roleIds.length > 0 ? input.roleIds : isFirstRun ? [roleIdForPreset('owner')] : [];
    for (const roleId of roleIds)
        getRole(roleId);
    const id = (0, node_crypto_1.randomUUID)();
    const at = (0, dates_1.nowIso)();
    const secret = (0, auth_1.hashPassword)(input.password);
    database.tx(() => {
        database.run(`INSERT INTO users
         (id, username, full_name, email, password_hash, password_salt, password_algo,
          must_change_password, is_active, is_owner, prefs_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '{}', ?, ?)`, [
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
        ]);
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
/** Updates profile fields, roles and preferences. */
function updateUser(input) {
    const row = (0, auth_1.findUserById)(input.id);
    if (!row)
        throw (0, errors_1.notFound)('User');
    const before = (0, auth_1.toUser)(row);
    const database = (0, connection_1.conn)();
    database.tx(() => {
        if (input.fullName !== undefined) {
            database.run('UPDATE users SET full_name = ?, updated_at = ? WHERE id = ?', [
                input.fullName.trim(),
                (0, dates_1.nowIso)(),
                input.id,
            ]);
        }
        if (input.email !== undefined) {
            database.run('UPDATE users SET email = ?, updated_at = ? WHERE id = ?', [
                input.email.trim() === '' ? null : input.email.trim(),
                (0, dates_1.nowIso)(),
                input.id,
            ]);
        }
        if (input.prefs !== undefined) {
            database.run('UPDATE users SET prefs_json = ?, updated_at = ? WHERE id = ?', [
                JSON.stringify(input.prefs),
                (0, dates_1.nowIso)(),
                input.id,
            ]);
        }
        if (input.roleIds !== undefined) {
            for (const roleId of input.roleIds)
                getRole(roleId);
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
function setActive(id, active, reason) {
    const row = (0, auth_1.findUserById)(id);
    if (!row)
        throw (0, errors_1.notFound)('User');
    if (!active) {
        const session = (0, auth_1.currentSession)();
        if (session && session.userId === id) {
            throw (0, errors_1.conflict)('You cannot disable the account you are signed in with.');
        }
        if (row.is_owner === 1) {
            const owners = (0, connection_1.conn)().one('SELECT COUNT(*) AS total FROM users WHERE is_owner = 1 AND is_active = 1 AND deleted_at IS NULL');
            if (owners && Number(owners.total) <= 1) {
                throw (0, errors_1.conflict)('This is the only active owner. Make another user an owner first.');
            }
        }
    }
    const database = (0, connection_1.conn)();
    database.tx(() => {
        database.run('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?', [
            active ? 1 : 0,
            (0, dates_1.nowIso)(),
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
function resetPassword(id, newPassword, mustChange) {
    const row = (0, auth_1.findUserById)(id);
    if (!row)
        throw (0, errors_1.notFound)('User');
    (0, auth_1.assertPasswordStrength)(newPassword, row.username);
    const secret = (0, auth_1.hashPassword)(newPassword);
    const database = (0, connection_1.conn)();
    database.tx(() => {
        database.run(`UPDATE users SET password_hash = ?, password_salt = ?, password_algo = ?,
                        must_change_password = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE id = ?`, [secret.hash, secret.salt, secret.algo, mustChange ? 1 : 0, (0, dates_1.nowIso)(), id]);
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
function deleteUser(id) {
    const row = (0, auth_1.findUserById)(id);
    if (!row)
        throw (0, errors_1.notFound)('User');
    const history = auditLog.countForEntity('user', id);
    if (history > 0) {
        throw (0, errors_1.conflict)(`${row.username} has ${String(history)} audit entries and cannot be deleted. Disable the account instead — it keeps the history intact and blocks sign-in.`);
    }
    const database = (0, connection_1.conn)();
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
function permissionsForUser(userId) {
    return (0, auth_1.permissionsFor)(userId);
}
//# sourceMappingURL=users.js.map