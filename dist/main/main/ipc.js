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
exports.validation = exports.notFound = exports.forbidden = exports.conflict = exports.AppError = void 0;
exports.register = register;
exports.dispatch = dispatch;
exports.isRegistered = isRegistered;
exports.registeredChannels = registeredChannels;
exports.registerChannels = registerChannels;
exports.registerIpc = registerIpc;
exports.permissionFor = permissionFor;
exports.permissionExists = permissionExists;
exports.assertSession = assertSession;
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
const electron_1 = require("electron");
const channels_1 = require("../shared/channels");
const dates_1 = require("../shared/dates");
const permissions_1 = require("../shared/permissions");
const schemas_1 = require("../shared/schemas");
const types_1 = require("../shared/types");
const connection_1 = require("./db/connection");
const errors_1 = require("./errors");
const log_1 = require("./log");
const security_1 = require("./security");
const ipc_entity_1 = require("./ipc.entity");
const ipc_documents_1 = require("./ipc.documents");
const ipc_finance_1 = require("./ipc.finance");
const ipc_ops_1 = require("./ipc.ops");
const ipc_crm_1 = require("./ipc.crm");
const ipc_admin_1 = require("./ipc.admin");
const ipc_settings_1 = require("./ipc.settings");
const auditLog = __importStar(require("./services/audit"));
const auth = __importStar(require("./services/auth"));
const license = __importStar(require("./services/license"));
const users = __importStar(require("./services/users"));
// Re-exported so services and tests import the documented path (CONVENTIONS §6).
var errors_2 = require("./errors");
Object.defineProperty(exports, "AppError", { enumerable: true, get: function () { return errors_2.AppError; } });
Object.defineProperty(exports, "conflict", { enumerable: true, get: function () { return errors_2.conflict; } });
Object.defineProperty(exports, "forbidden", { enumerable: true, get: function () { return errors_2.forbidden; } });
Object.defineProperty(exports, "notFound", { enumerable: true, get: function () { return errors_2.notFound; } });
Object.defineProperty(exports, "validation", { enumerable: true, get: function () { return errors_2.validation; } });
const registry = new Map();
// ── rate limiting ────────────────────────────────────────────────────────────
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMITED_CHANNELS = new Set(['auth.login', 'auth.unlock']);
const rateLimitBuckets = new Map();
function assertRateLimit(channel) {
    const now = Date.now();
    const bucket = (rateLimitBuckets.get(channel) ?? []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
    if (bucket.length >= RATE_LIMIT_MAX) {
        (0, log_1.logWarn)('ipc.rateLimit', `${channel} exceeded ${String(RATE_LIMIT_MAX)} attempts in 5 minutes`);
        throw new errors_1.AppError('FORBIDDEN', 'Too many attempts. Wait five minutes before trying again — nothing was changed.');
    }
    bucket.push(now);
    rateLimitBuckets.set(channel, bucket);
}
/** Clears a bucket after a successful authentication. */
function clearRateLimit(channel) {
    rateLimitBuckets.delete(channel);
}
// ── helpers ──────────────────────────────────────────────────────────────────
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isThenable(value) {
    return typeof value === 'object' && value !== null && typeof value.then === 'function';
}
/** Resolves the permission a channel needs, including the `entity.*` family. */
function requiredPermission(channel, payload) {
    const requirement = channels_1.CHANNEL_PERMISSIONS[channel];
    if (requirement === channels_1.PUBLIC)
        return null;
    if (requirement.startsWith('entity.')) {
        const op = requirement.slice('entity.'.length);
        const entityName = isRecord(payload) && typeof payload.entity === 'string' ? payload.entity : '';
        if (!(0, types_1.isEntityName)(entityName)) {
            throw (0, errors_1.validation)('entity', 'That is not a record type this build knows about.');
        }
        const meta = types_1.ENTITIES[entityName];
        if (op === 'read')
            return meta.read;
        if (op === 'write')
            return meta.write;
        if (op === 'delete')
            return meta.remove ?? meta.write;
        return 'documents.export';
    }
    // Anything left must be a real permission; if it is not, the channel map is
    // wrong and failing closed is the only safe answer.
    if (!(0, permissions_1.isPermission)(requirement)) {
        throw new errors_1.AppError('INTERNAL', 'This action is misconfigured and cannot run. Nothing was changed.');
    }
    return requirement;
}
/** Appends the standard audit row for a mutating channel. */
function autoAudit(channel, ctx, result) {
    if (channels_1.READ_ONLY_CHANNELS.has(channel) || channels_1.SELF_AUDITING_CHANNELS.has(channel))
        return;
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
function toWireError(channel, error) {
    if ((0, errors_1.isAppError)(error)) {
        return { code: error.code, message: error.message, details: error.details };
    }
    const detail = (0, log_1.logError)('ipc.dispatch', error, { channel });
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
function execute(registration, channel, payload, ctx) {
    // Read-only channels need no transaction. Self-auditing channels manage their
    // own transaction because their failure path must still persist evidence —
    // a rolled-back `login_failed` audit row would erase the brute-force trail.
    if (channels_1.READ_ONLY_CHANNELS.has(channel) || channels_1.SELF_AUDITING_CHANNELS.has(channel)) {
        return registration.handler(payload, ctx);
    }
    const database = (0, connection_1.conn)();
    const result = database.tx(() => {
        const value = registration.handler(payload, ctx);
        if (isThenable(value)) {
            throw new errors_1.AppError('INTERNAL', 'This action is misconfigured (a mutating handler returned a promise). Nothing was changed.');
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
function register(definition) {
    registry.set(definition.channel, {
        channel: definition.channel,
        // The payload has already been shape-validated against SCHEMAS, so widening
        // the typed parameter to `unknown` is sound. The cast is confined to here.
        handler: definition.handler,
    });
}
/** Dispatches one envelope. Never throws. */
async function dispatch(channelValue, payload) {
    if (typeof channelValue !== 'string' || !(0, channels_1.isChannel)(channelValue)) {
        return {
            ok: false,
            error: { code: 'FORBIDDEN', message: 'That action is not available in this application.' },
        };
    }
    const channel = channelValue;
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
        const validated = (0, schemas_1.validatePayload)(channel, payload);
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
        const requiresSession = !channels_1.NO_SESSION_CHANNELS.has(channel);
        const session = requiresSession ? auth.requireSession() : auth.currentSession();
        const permission = requiredPermission(channel, cleanPayload);
        if (permission && session && !session.permissions.has(permission)) {
            throw (0, errors_1.forbidden)(permission);
        }
        if (RATE_LIMITED_CHANNELS.has(channel))
            assertRateLimit(channel);
        const ctx = {
            channel,
            session,
            actorId: session?.userId ?? null,
            actorName: session?.username ?? 'system',
            permissions: session?.permissions ?? new Set(),
            now: (0, dates_1.nowIso)(),
        };
        const result = execute(registration, channel, cleanPayload, ctx);
        const data = isThenable(result) ? await result : result;
        if (RATE_LIMITED_CHANNELS.has(channel))
            clearRateLimit(channel);
        return { ok: true, data };
    }
    catch (error) {
        return { ok: false, error: toWireError(channel, error) };
    }
}
/** True when a channel has a handler in this build. */
function isRegistered(channel) {
    return registry.has(channel);
}
/** Registered channels, for the diagnostics panel. */
function registeredChannels() {
    return [...registry.keys()].sort();
}
/**
 * Registers every T02 channel handler. Kept separate from `registerIpc()` so
 * the dispatcher can be exercised without an Electron `ipcMain` (see
 * `tests/core.test.cjs`).
 */
function registerChannels() {
    register({
        channel: 'app.bootstrap',
        handler: () => auth.bootstrap({ platform: process.platform, version: electron_1.app.getVersion() }),
    });
    register({
        channel: 'app.quit',
        handler: () => {
            electron_1.app.quit();
            return null;
        },
    });
    register({
        channel: 'app.prefs.save',
        handler: (payload) => {
            const session = auth.requireSession();
            const row = auth.findUserById(session.userId);
            if (!row)
                throw (0, errors_1.notFound)('User');
            let current = {};
            try {
                current = JSON.parse(row.prefs_json);
            }
            catch {
                current = {};
            }
            const merged = { ...current, ...payload };
            (0, connection_1.conn)().run('UPDATE users SET prefs_json = ?, updated_at = ? WHERE id = ?', [
                JSON.stringify(merged),
                (0, dates_1.nowIso)(),
                session.userId,
            ]);
            return merged;
        },
    });
    register({
        channel: 'auth.login',
        handler: (payload) => auth.login(payload.username, payload.password),
    });
    register({
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
    register({
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
            const company = (0, connection_1.conn)().one('SELECT COUNT(*) AS total FROM companies');
            const hasCompany = company ? Number(company.total) > 0 : false;
            const complete = hasCompany && auth.userCount() > 0;
            return { complete, step: complete ? 5 : hasCompany ? 4 : 1 };
        },
    });
    register({
        channel: 'users.create',
        handler: (payload) => users.createUser(payload),
    });
    register({
        channel: 'users.update',
        handler: (payload) => users.updateUser(payload),
    });
    register({
        channel: 'users.setActive',
        handler: (payload) => users.setActive(payload.id, payload.active, payload.reason),
    });
    register({
        channel: 'users.resetPassword',
        handler: (payload) => {
            users.resetPassword(payload.id, payload.newPassword, payload.mustChange);
            return null;
        },
    });
    register({
        channel: 'roles.duplicate',
        handler: (payload) => users.duplicateRole(payload.id, payload.name),
    });
    register({
        channel: 'permissions.catalog',
        handler: () => ({ groups: (0, permissions_1.permissionGroups)() }),
    });
    register({
        channel: 'settings.get',
        handler: (payload) => {
            const keys = payload.keys ?? [];
            const database = (0, connection_1.conn)();
            const rows = keys.length > 0
                ? database.all(`SELECT key, value_json FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`, keys)
                : database.all('SELECT key, value_json FROM settings');
            const output = {};
            for (const row of rows) {
                try {
                    output[row.key] = JSON.parse(row.value_json);
                }
                catch {
                    output[row.key] = row.value_json;
                }
            }
            return output;
        },
    });
    register({
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
    register({
        channel: 'license.activate',
        handler: (payload, ctx) => license.activate(payload.key, { actorId: ctx.actorId, actorName: ctx.actorName }),
    });
    register({
        channel: 'license.deactivate',
        handler: (payload, ctx) => license.deactivate(payload.reason, { actorId: ctx.actorId, actorName: ctx.actorName }),
    });
    register({
        channel: 'license.machineId',
        handler: () => ({ machineId: license.machineIdOf() }),
    });
    // Feature modules register through the same `register`, so their channels are
    // subject to the identical allow-list → validate → session → RBAC pipeline.
    (0, ipc_entity_1.registerEntityChannels)(register);
    (0, ipc_settings_1.registerSettingsChannels)(register);
    (0, ipc_finance_1.registerFinanceChannels)(register);
    (0, ipc_ops_1.registerOpsChannels)(register);
    (0, ipc_documents_1.registerDocumentChannels)(register);
    (0, ipc_crm_1.registerCrmChannels)(register);
    (0, ipc_admin_1.registerAdminChannels)(register);
}
/** Registers the channels and wires the single `ipcMain` invoke handler. */
function registerIpc() {
    registerChannels();
    electron_1.ipcMain.handle(channels_1.INVOKE_MESSAGE, async (event, request) => {
        const senderUrl = event.senderFrame?.url ?? '';
        if (senderUrl !== '' && !(0, security_1.isAppUrl)(senderUrl)) {
            (0, log_1.logWarn)('ipc.sender', `rejected a request from ${senderUrl}`);
            return {
                ok: false,
                error: { code: 'FORBIDDEN', message: 'That request did not come from the application window.' },
            };
        }
        if (!isRecord(request)) {
            return {
                ok: false,
                error: { code: 'VALIDATION', message: 'The request was not understood.' },
            };
        }
        return dispatch(request.channel, request.payload);
    });
}
/** Permission for a channel, exposed for the unit test that walks CHANNELS. */
function permissionFor(channel) {
    return channels_1.CHANNEL_PERMISSIONS[channel];
}
/** True when a permission key is real (used by the role editor). */
function permissionExists(value) {
    return (0, permissions_1.isPermission)(value);
}
/** Guard kept for parity with `authRequired`; throws when there is no session. */
function assertSession() {
    const session = auth.currentSession();
    if (!session)
        throw (0, errors_1.authRequired)();
    return session;
}
//# sourceMappingURL=ipc.js.map