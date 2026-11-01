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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.licenseStatus = licenseStatus;
exports.machineIdOf = machineIdOf;
exports.features = features;
exports.hasEdition = hasEdition;
exports.checkClockRollback = checkClockRollback;
exports.touchLastSeen = touchLastSeen;
exports.activate = activate;
exports.deactivate = deactivate;
exports.onStartup = onStartup;
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
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
const dates_1 = require("../../shared/dates");
const connection_1 = require("../db/connection");
const log_1 = require("../log");
const machine_1 = require("../license/machine");
const verify_1 = require("../license/verify");
const auditLog = __importStar(require("./audit"));
const EDITIONS = ['community', 'pro', 'enterprise'];
/** Edition → feature flags. Advisory by design (T3 residual risk). */
const EDITION_FEATURES = {
    community: ['core'],
    pro: ['core', 'multi_currency', 'crm_analytics', 'bulk_import', 'backup'],
    enterprise: ['core', 'multi_currency', 'crm_analytics', 'bulk_import', 'backup', 'api', 'multi_company'],
};
/** A backwards clock jump larger than this is treated as suspect. */
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const SYSTEM_ACTOR = { actorId: null, actorName: 'system' };
function stampPath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), '.stamp');
}
function activationKeyPath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'license.key');
}
function normaliseEdition(value) {
    return EDITIONS.includes(value) ? value : 'community';
}
/** Reads the singleton row, creating the Community default on first run. */
function ensureRow() {
    const database = (0, connection_1.conn)();
    const existing = database.one(`SELECT id, edition, licensee, email, seats, features_json, machine_id, key_hash,
            activated_at, last_seen_at, suspect_clock, updated_at
       FROM license_state WHERE id = 1`);
    if (existing)
        return existing;
    const at = (0, dates_1.nowIso)();
    database.run(`INSERT INTO license_state
       (id, edition, licensee, email, seats, features_json, machine_id, key_hash,
        activated_at, last_seen_at, suspect_clock, updated_at)
     VALUES (1, 'community', NULL, NULL, 1, ?, NULL, NULL, NULL, NULL, 0, ?)`, [JSON.stringify(EDITION_FEATURES.community), at]);
    database.markDirty();
    const created = database.one(`SELECT id, edition, licensee, email, seats, features_json, machine_id, key_hash,
            activated_at, last_seen_at, suspect_clock, updated_at
       FROM license_state WHERE id = 1`);
    if (!created)
        throw new Error('license_state row could not be created');
    return created;
}
function parseFeatures(json, edition) {
    try {
        const parsed = JSON.parse(json);
        if (Array.isArray(parsed))
            return parsed.filter((entry) => typeof entry === 'string');
    }
    catch {
        (0, log_1.logWarn)('license', 'features_json is not valid JSON; falling back to the edition defaults');
    }
    return EDITION_FEATURES[edition];
}
/** The current licence, always including this machine's id. */
function licenseStatus() {
    const row = ensureRow();
    const edition = normaliseEdition(row.edition);
    return {
        edition,
        licensee: row.licensee,
        email: row.email,
        seats: Number(row.seats),
        features: parseFeatures(row.features_json, edition),
        machineId: (0, machine_1.machineId)(),
        keyHash: row.key_hash,
        activatedAt: row.activated_at,
        lastSeenAt: row.last_seen_at,
        suspectClock: row.suspect_clock === 1,
        updatedAt: row.updated_at,
        expiresAt: null,
    };
}
/** This machine's id, for the copyable field on the licence page. */
function machineIdOf() {
    return (0, machine_1.machineId)();
}
/** Feature flags for the active edition. */
function features() {
    return licenseStatus().features;
}
/** True when the edition is at least `required`. */
function hasEdition(required) {
    const order = ['community', 'pro', 'enterprise'];
    return order.indexOf(licenseStatus().edition) >= order.indexOf(required);
}
/**
 * Compares the wall clock against the last time we saw it. A backwards jump of
 * more than five minutes sets `suspect_clock = 1` and returns `true`.
 * Never throws, never blocks.
 */
function checkClockRollback() {
    const now = Date.now();
    let lastSeen = 0;
    try {
        const raw = node_fs_1.default.readFileSync(stampPath(), 'utf8').trim();
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed))
            lastSeen = parsed;
    }
    catch {
        lastSeen = 0;
    }
    const suspect = lastSeen > 0 && now < lastSeen - CLOCK_TOLERANCE_MS;
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(stampPath()), { recursive: true });
        node_fs_1.default.writeFileSync(stampPath(), String(Math.max(now, lastSeen)), 'utf8');
    }
    catch (error) {
        (0, log_1.logWarn)('license.stamp', `cannot write clock stamp: ${String(error)}`);
    }
    const database = (0, connection_1.conn)();
    const row = ensureRow();
    if (suspect && row.suspect_clock !== 1) {
        database.run('UPDATE license_state SET suspect_clock = 1, updated_at = ? WHERE id = 1', [(0, dates_1.nowIso)()]);
        database.markDirty();
        (0, log_1.logWarn)('license', 'system clock moved backwards; flagging suspect_clock (no lockout)');
    }
    if (!suspect && row.suspect_clock === 1 && lastSeen > 0) {
        // The clock caught up again: clear the warning rather than nagging forever.
        database.run('UPDATE license_state SET suspect_clock = 0, updated_at = ? WHERE id = 1', [(0, dates_1.nowIso)()]);
        database.markDirty();
    }
    return suspect;
}
/** Records the heartbeat used by the clock check. */
function touchLastSeen() {
    const database = (0, connection_1.conn)();
    ensureRow();
    database.run('UPDATE license_state SET last_seen_at = ?, updated_at = ? WHERE id = 1', [
        (0, dates_1.nowIso)(),
        (0, dates_1.nowIso)(),
    ]);
}
function writeActivationFile(key) {
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(activationKeyPath()), { recursive: true });
        node_fs_1.default.writeFileSync(activationKeyPath(), key.trim(), { encoding: 'utf8', mode: 0o600 });
    }
    catch (error) {
        (0, log_1.logWarn)('license.file', `cannot store the activation key: ${String(error)}`);
    }
}
function removeActivationFile() {
    try {
        node_fs_1.default.rmSync(activationKeyPath(), { force: true });
    }
    catch {
        // Not fatal: the database state is what matters.
    }
}
function applyPayload(payload, key) {
    const database = (0, connection_1.conn)();
    ensureRow();
    const at = (0, dates_1.nowIso)();
    database.run(`UPDATE license_state
        SET edition = ?, licensee = ?, email = ?, seats = ?, features_json = ?,
            machine_id = ?, key_hash = ?, activated_at = ?, last_seen_at = ?, updated_at = ?
      WHERE id = 1`, [
        payload.edition,
        payload.licensee,
        payload.email === '' ? null : payload.email,
        payload.seats,
        JSON.stringify(EDITION_FEATURES[payload.edition]),
        (0, machine_1.machineId)(),
        (0, verify_1.hashKey)(key),
        at,
        at,
        at,
    ]);
    database.markDirty();
}
/**
 * Verifies and applies a key. Signature first, machine binding second — a
 * tampered key is `VALIDATION`, a key for another machine is `LICENSE`.
 */
function activate(key, actor = SYSTEM_ACTOR) {
    const payload = (0, verify_1.verifyKey)(key, (0, machine_1.machineId)());
    const database = (0, connection_1.conn)();
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
                machineId: (0, machine_1.machineId)(),
            },
        });
    });
    writeActivationFile(key);
    return licenseStatus();
}
/** Returns to Community. Audited; the data is untouched. */
function deactivate(reason, actor = SYSTEM_ACTOR) {
    const before = licenseStatus();
    const database = (0, connection_1.conn)();
    database.tx(() => {
        ensureRow();
        database.run(`UPDATE license_state
          SET edition = 'community', licensee = NULL, email = NULL, seats = 1,
              features_json = ?, machine_id = NULL, key_hash = NULL,
              activated_at = NULL, updated_at = ?
        WHERE id = 1`, [JSON.stringify(EDITION_FEATURES.community), (0, dates_1.nowIso)()]);
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
function onStartup() {
    const suspect = checkClockRollback();
    touchLastSeen();
    return { suspectClock: suspect };
}
//# sourceMappingURL=license.js.map