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
exports.DEFAULT_SECURITY_POLICY = exports.PASSWORD_ALGO = void 0;
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.securityPolicy = securityPolicy;
exports.assertPasswordStrength = assertPasswordStrength;
exports.roleIdsFor = roleIdsFor;
exports.permissionsFor = permissionsFor;
exports.toUser = toUser;
exports.findUserById = findUserById;
exports.userCount = userCount;
exports.currentSession = currentSession;
exports.requireSession = requireSession;
exports.sessionSummary = sessionSummary;
exports.login = login;
exports.unlock = unlock;
exports.lock = lock;
exports.logout = logout;
exports.heartbeat = heartbeat;
exports.checkIdle = checkIdle;
exports.changePassword = changePassword;
exports.bootstrap = bootstrap;
/**
 * Credentials, sessions and the bootstrap payload.
 *
 * - Passwords: scrypt (N=16384, r=8, p=1, 16-byte salt, 64-byte key) with
 *   `timingSafeEqual`. No native module, no bcrypt, no argon2.
 * - Sessions live in memory, keyed by an opaque token; the `sessions` table is
 *   the durable trail for audit, not the authorisation source.
 * - A failed login MUST leave an audit row. That is why `auth.*` channels are
 *   registered as non-transactional in `ipc.ts`: the service commits its own
 *   bookkeeping transaction before throwing, otherwise the rollback would erase
 *   the evidence (T02 acceptance #7).
 */
const node_crypto_1 = require("node:crypto");
const dates_1 = require("../../shared/dates");
const modules_1 = require("../../shared/modules");
const permissions_1 = require("../../shared/permissions");
const connection_1 = require("../db/connection");
const errors_1 = require("../errors");
const log_1 = require("../log");
const auditLog = __importStar(require("./audit"));
const license_1 = require("./license");
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
/** Stored in `users.password_algo`; a future change gets a new label. */
exports.PASSWORD_ALGO = 'scrypt-n16384-r8-p1';
const BAD_CREDENTIALS = 'Incorrect username or password.';
const LOCKED_MESSAGE = 'Too many failed sign-in attempts. This account is locked for a few minutes — try again shortly.';
exports.DEFAULT_SECURITY_POLICY = {
    idleTimeoutMin: 15,
    minPasswordLength: 10,
    requireSymbol: false,
    maxAttempts: 5,
    lockoutMin: 15,
};
const sessions = new Map();
let activeToken = null;
// ── passwords ────────────────────────────────────────────────────────────────
/** scrypt hash with a fresh 16-byte salt. */
function hashPassword(password, saltBase64) {
    const salt = saltBase64 ? Buffer.from(saltBase64, 'base64') : (0, node_crypto_1.randomBytes)(SALT_BYTES);
    const key = (0, node_crypto_1.scryptSync)(password.normalize('NFKC'), salt, KEY_BYTES, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: 64 * 1024 * 1024,
    });
    return {
        hash: key.toString('base64'),
        salt: salt.toString('base64'),
        algo: exports.PASSWORD_ALGO,
    };
}
/** Constant-time comparison. Returns false rather than throwing on damage. */
function verifyPassword(password, stored) {
    if (stored.algo !== exports.PASSWORD_ALGO) {
        (0, log_1.logError)('auth.verify', new Error(`Unsupported password algorithm: ${stored.algo}`));
        return false;
    }
    try {
        const expected = Buffer.from(stored.hash, 'base64');
        const candidate = (0, node_crypto_1.scryptSync)(password.normalize('NFKC'), Buffer.from(stored.salt, 'base64'), expected.length, {
            N: SCRYPT_N,
            r: SCRYPT_R,
            p: SCRYPT_P,
            maxmem: 64 * 1024 * 1024,
        });
        return candidate.length === expected.length && (0, node_crypto_1.timingSafeEqual)(candidate, expected);
    }
    catch (error) {
        (0, log_1.logError)('auth.verify', error);
        return false;
    }
}
/** Reads `settings.security`, falling back to the documented defaults. */
function securityPolicy() {
    const row = (0, connection_1.conn)().one('SELECT value_json FROM settings WHERE key = ?', [
        'security',
    ]);
    if (!row)
        return exports.DEFAULT_SECURITY_POLICY;
    try {
        const parsed = JSON.parse(row.value_json);
        return {
            idleTimeoutMin: Number(parsed.idleTimeoutMin ?? exports.DEFAULT_SECURITY_POLICY.idleTimeoutMin),
            minPasswordLength: Number(parsed.minPasswordLength ?? exports.DEFAULT_SECURITY_POLICY.minPasswordLength),
            requireSymbol: Boolean(parsed.requireSymbol ?? exports.DEFAULT_SECURITY_POLICY.requireSymbol),
            maxAttempts: Number(parsed.maxAttempts ?? exports.DEFAULT_SECURITY_POLICY.maxAttempts),
            lockoutMin: Number(parsed.lockoutMin ?? exports.DEFAULT_SECURITY_POLICY.lockoutMin),
        };
    }
    catch {
        return exports.DEFAULT_SECURITY_POLICY;
    }
}
/** Rejects a weak password with a sentence the user can act on. */
function assertPasswordStrength(password, username) {
    const policy = securityPolicy();
    if (password.length < policy.minPasswordLength) {
        throw (0, errors_1.validation)('newPassword', `Use at least ${String(policy.minPasswordLength)} characters so the password is not guessable.`);
    }
    if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
        throw (0, errors_1.validation)('newPassword', 'The password must contain at least one symbol.');
    }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
        throw (0, errors_1.validation)('newPassword', 'The password must contain at least one letter and one number.');
    }
    if (username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) {
        throw (0, errors_1.validation)('newPassword', 'The password must not contain your username.');
    }
}
// ── rows → DTOs ──────────────────────────────────────────────────────────────
function safeJson(text, fallback) {
    if (!text)
        return fallback;
    try {
        return JSON.parse(text);
    }
    catch {
        return fallback;
    }
}
/** Role ids for a user, in role-name order. */
function roleIdsFor(userId) {
    return (0, connection_1.conn)()
        .all(`SELECT ur.role_id FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ? AND r.deleted_at IS NULL
        ORDER BY r.name`, [userId])
        .map((row) => row.role_id);
}
/** Union of every role's permissions. Unknown keys in stored JSON are dropped. */
function permissionsFor(userId) {
    const rows = (0, connection_1.conn)().all(`SELECT r.permissions_json FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ? AND r.deleted_at IS NULL`, [userId]);
    return (0, permissions_1.resolvePermissions)(rows.map((row) => safeJson(row.permissions_json, [])));
}
/** Maps a `users` row plus its roles to the wire DTO. */
function toUser(row) {
    return {
        id: row.id,
        username: row.username,
        fullName: row.full_name,
        email: row.email,
        isActive: row.is_active === 1,
        isOwner: row.is_owner === 1,
        mustChangePassword: row.must_change_password === 1,
        roleIds: roleIdsFor(row.id),
        prefs: safeJson(row.prefs_json, {}),
        lastLoginAt: row.last_login_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function findUserById(id) {
    return (0, connection_1.conn)().one(`SELECT id, username, full_name, email, password_hash, password_salt, password_algo,
            must_change_password, is_active, is_owner, prefs_json, failed_attempts,
            locked_until, last_login_at, created_at, updated_at, deleted_at
       FROM users WHERE id = ? AND deleted_at IS NULL`, [id]);
}
function findUserByUsername(username) {
    return (0, connection_1.conn)().one(`SELECT id, username, full_name, email, password_hash, password_salt, password_algo,
            must_change_password, is_active, is_owner, prefs_json, failed_attempts,
            locked_until, last_login_at, created_at, updated_at, deleted_at
       FROM users WHERE username = ? AND deleted_at IS NULL`, [username]);
}
/** Number of live users — `0` means this is a first run and onboarding has not run. */
function userCount() {
    const row = (0, connection_1.conn)().one('SELECT COUNT(*) AS total FROM users WHERE deleted_at IS NULL');
    return row ? Number(row.total) : 0;
}
// ── session ──────────────────────────────────────────────────────────────────
function prepareSession(row) {
    const startedAt = (0, dates_1.nowIso)();
    return {
        token: (0, node_crypto_1.randomBytes)(32).toString('base64url'),
        sessionId: (0, node_crypto_1.randomUUID)(),
        userId: row.id,
        username: row.username,
        startedAt,
        user: toUser(row),
        permissions: permissionsFor(row.id),
        locked: false,
        lastSeenAt: startedAt,
    };
}
/** Writes the durable session row and makes the session current. */
function activateSession(session) {
    (0, connection_1.conn)().run('INSERT INTO sessions (id, user_id, started_at, last_seen_at) VALUES (?, ?, ?, ?)', [
        session.sessionId,
        session.userId,
        session.startedAt,
        session.lastSeenAt,
    ]);
    sessions.set(session.token, session);
    activeToken = session.token;
}
function loginResultOf(session) {
    return {
        user: session.user,
        permissions: [...session.permissions].sort(),
        sessionId: session.sessionId,
    };
}
/** The session the renderer is currently acting as, if any. */
function currentSession() {
    if (!activeToken)
        return null;
    return sessions.get(activeToken) ?? null;
}
/** The session or an `AUTH_REQUIRED` error. */
function requireSession() {
    const session = currentSession();
    if (!session)
        throw (0, errors_1.authRequired)();
    return session;
}
/** What `auth.session` returns: never the token. */
function sessionSummary() {
    const session = currentSession();
    const policy = securityPolicy();
    if (!session) {
        return { user: null, locked: false, idleTimeoutMin: policy.idleTimeoutMin, lastSeenAt: null };
    }
    return {
        user: session.user,
        locked: session.locked,
        idleTimeoutMin: policy.idleTimeoutMin,
        lastSeenAt: session.lastSeenAt,
    };
}
/** Records a failed attempt, locks the account when the limit is reached, and audits. */
function recordFailedLogin(username, row, reason) {
    const database = (0, connection_1.conn)();
    database.tx(() => {
        if (row) {
            const policy = securityPolicy();
            const attempts = Number(row.failed_attempts) + 1;
            const lockUntil = attempts >= policy.maxAttempts
                ? new Date(Date.now() + policy.lockoutMin * 60_000).toISOString()
                : null;
            database.run(`UPDATE users SET failed_attempts = ?, locked_until = COALESCE(?, locked_until), updated_at = ?
          WHERE id = ?`, [attempts, lockUntil, (0, dates_1.nowIso)(), row.id]);
        }
        auditLog.append({
            actorId: row?.id ?? null,
            actorName: username,
            entity: 'user',
            entityId: row?.id ?? null,
            action: 'login_failed',
            meta: { reason },
        });
    });
    database.markDirty();
}
/**
 * Verifies credentials, opens a session, audits the outcome.
 * One `login_failed` audit row per failed attempt (T02 acceptance #7).
 */
function login(usernameInput, password) {
    const username = usernameInput.trim().toLowerCase();
    const database = (0, connection_1.conn)();
    const row = findUserByUsername(username);
    if (!row) {
        recordFailedLogin(username, undefined, 'unknown_username');
        throw (0, errors_1.authRequired)(BAD_CREDENTIALS);
    }
    if (row.deleted_at !== null || row.is_active !== 1) {
        recordFailedLogin(username, row, 'inactive');
        throw (0, errors_1.authRequired)('This account is disabled. Ask an administrator to re-enable it.');
    }
    if (row.locked_until) {
        const lockedUntil = Date.parse(row.locked_until);
        if (!Number.isNaN(lockedUntil) && lockedUntil > Date.now()) {
            recordFailedLogin(username, row, 'locked');
            throw (0, errors_1.conflict)(LOCKED_MESSAGE);
        }
    }
    const valid = verifyPassword(password, {
        hash: row.password_hash,
        salt: row.password_salt,
        algo: row.password_algo,
    });
    if (!valid) {
        recordFailedLogin(username, row, 'bad_password');
        throw (0, errors_1.authRequired)(BAD_CREDENTIALS);
    }
    const session = prepareSession(row);
    database.tx(() => {
        database.run(`UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ?
        WHERE id = ?`, [(0, dates_1.nowIso)(), (0, dates_1.nowIso)(), row.id]);
        activateSession(session);
        auditLog.append({
            actorId: row.id,
            actorName: row.username,
            entity: 'user',
            entityId: row.id,
            action: 'login',
            meta: { sessionId: session.sessionId },
        });
    });
    database.markDirty();
    return loginResultOf(session);
}
/** Re-authenticates the locked session. */
function unlock(password) {
    const session = requireSession();
    const row = findUserById(session.userId);
    if (!row)
        throw (0, errors_1.authRequired)();
    const valid = verifyPassword(password, {
        hash: row.password_hash,
        salt: row.password_salt,
        algo: row.password_algo,
    });
    if (!valid) {
        const database = (0, connection_1.conn)();
        database.tx(() => {
            auditLog.append({
                actorId: row.id,
                actorName: row.username,
                entity: 'user',
                entityId: row.id,
                action: 'unlock_failed',
            });
        });
        database.markDirty();
        throw (0, errors_1.authRequired)(BAD_CREDENTIALS);
    }
    const database = (0, connection_1.conn)();
    database.tx(() => {
        session.locked = false;
        session.lastSeenAt = (0, dates_1.nowIso)();
        database.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [session.lastSeenAt, session.sessionId]);
        auditLog.append({
            actorId: row.id,
            actorName: row.username,
            entity: 'user',
            entityId: row.id,
            action: 'unlock',
        });
    });
    database.markDirty();
    return {
        user: session.user,
        permissions: [...session.permissions].sort(),
        sessionId: session.sessionId,
    };
}
/** Locks the session in place; the renderer keeps its unsaved state (D-16). */
function lock() {
    const session = requireSession();
    const lockedAt = (0, dates_1.nowIso)();
    const database = (0, connection_1.conn)();
    database.tx(() => {
        session.locked = true;
        auditLog.append({
            actorId: session.userId,
            actorName: session.username,
            entity: 'user',
            entityId: session.userId,
            action: 'lock',
        });
    });
    database.markDirty();
    return { lockedAt };
}
/** Ends the session. */
function logout() {
    const session = currentSession();
    if (!session)
        return;
    const endedAt = (0, dates_1.nowIso)();
    const database = (0, connection_1.conn)();
    database.tx(() => {
        database.run('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?', [
            endedAt,
            'logout',
            session.sessionId,
        ]);
        auditLog.append({
            actorId: session.userId,
            actorName: session.username,
            entity: 'user',
            entityId: session.userId,
            action: 'logout',
        });
    });
    sessions.delete(session.token);
    if (activeToken === session.token)
        activeToken = null;
    database.markDirty();
}
/** Refreshes `lastSeenAt`; returns whether the session is locked. */
function heartbeat() {
    const session = requireSession();
    session.lastSeenAt = (0, dates_1.nowIso)();
    return { locked: session.locked };
}
/**
 * Applies the idle policy. Called by the main-process timer; locks the session
 * and reports `true` when the renderer must show the lock screen.
 */
function checkIdle() {
    const session = currentSession();
    if (!session || session.locked)
        return false;
    const policy = securityPolicy();
    const idleMs = Date.now() - Date.parse(session.lastSeenAt);
    if (idleMs < policy.idleTimeoutMin * 60_000)
        return false;
    try {
        lock();
        return true;
    }
    catch (error) {
        (0, log_1.logError)('auth.checkIdle', error);
        return false;
    }
}
/** Changes the current user's password after re-checking the old one. */
function changePassword(currentPassword, newPassword) {
    const session = requireSession();
    const row = findUserById(session.userId);
    if (!row)
        throw (0, errors_1.authRequired)();
    const valid = verifyPassword(currentPassword, {
        hash: row.password_hash,
        salt: row.password_salt,
        algo: row.password_algo,
    });
    if (!valid) {
        throw (0, errors_1.authRequired)('The current password is not correct.');
    }
    assertPasswordStrength(newPassword, row.username);
    if (newPassword === currentPassword) {
        throw (0, errors_1.validation)('newPassword', 'The new password must be different from the current one.');
    }
    const next = hashPassword(newPassword);
    const database = (0, connection_1.conn)();
    database.tx(() => {
        database.run(`UPDATE users SET password_hash = ?, password_salt = ?, password_algo = ?,
                        must_change_password = 0, updated_at = ?
        WHERE id = ?`, [next.hash, next.salt, next.algo, (0, dates_1.nowIso)(), row.id]);
        auditLog.append({
            actorId: row.id,
            actorName: row.username,
            entity: 'user',
            entityId: row.id,
            action: 'password_changed',
        });
    });
    database.markDirty();
}
// ── bootstrap ────────────────────────────────────────────────────────────────
function readCompany() {
    const row = (0, connection_1.conn)().one(`SELECT id, name, legal_name, tax_id, address_json, logo_path, base_currency,
            fiscal_year_start_month, date_format, number_format, industry_preset,
            created_at, updated_at
       FROM companies LIMIT 1`);
    if (!row)
        return null;
    return {
        id: row.id,
        name: row.name,
        legalName: row.legal_name,
        taxId: row.tax_id,
        address: row.address_json === null ? null : safeJson(row.address_json, null),
        logoPath: row.logo_path,
        baseCurrency: row.base_currency,
        fiscalYearStartMonth: Number(row.fiscal_year_start_month),
        dateFormat: row.date_format,
        numberFormat: row.number_format,
        industryPreset: row.industry_preset,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function presetOf(company) {
    const candidate = company?.industryPreset;
    if (!candidate)
        return null;
    const known = [
        'manufacturing',
        'wholesale_retail',
        'services',
        'construction',
        'education',
        'ngo',
        'logistics',
    ];
    return known.includes(candidate) ? candidate : null;
}
function visibleModuleIds(company, permissions) {
    const preset = presetOf(company);
    return modules_1.MODULES.filter((module) => {
        if (preset) {
            if (module.enabledByPreset.length > 0 && !module.enabledByPreset.includes(preset))
                return false;
        }
        if (module.permissions.length === 0)
            return true;
        return module.permissions.some((permission) => permissions.has(permission));
    }).map((module) => module.id);
}
/**
 * `app.bootstrap` — one call that tells the renderer everything it needs to
 * decide between onboarding, login, lock screen and the shell.
 */
function bootstrap(context) {
    const session = currentSession();
    const company = readCompany();
    const license = (0, license_1.licenseStatus)();
    const permissions = session ? session.permissions : new Set();
    const prefs = session?.user.prefs ?? {};
    return {
        initialised: company !== null && userCount() > 0,
        needsOnboarding: company === null || userCount() === 0,
        session: sessionSummary(),
        user: session && !session.locked ? session.user : null,
        permissions: [...permissions].sort(),
        company,
        license,
        prefs,
        suspectClock: license.suspectClock,
        edition: license.edition,
        features: license.features,
        modules: visibleModuleIds(company, permissions),
        theme: prefs.theme ?? 'light',
        density: prefs.density ?? 'comfortable',
        platform: context.platform,
        version: context.version,
    };
}
//# sourceMappingURL=auth.js.map