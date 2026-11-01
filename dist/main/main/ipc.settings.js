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
exports.completeOnboarding = completeOnboarding;
exports.listNotifications = listNotifications;
exports.markNotificationsRead = markNotificationsRead;
exports.registerSettingsChannels = registerSettingsChannels;
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
const node_crypto_1 = require("node:crypto");
const industry_presets_1 = require("../shared/industry-presets");
const dates_1 = require("../shared/dates");
const connection_1 = require("./db/connection");
const seed_1 = require("./db/seed");
const errors_1 = require("./errors");
const auditLog = __importStar(require("./services/audit"));
const auth_1 = require("./services/auth");
const machine_1 = require("./license/machine");
const verify_1 = require("./license/verify");
const license = __importStar(require("./services/license"));
const settings_1 = require("./services/settings");
const users = __importStar(require("./services/users"));
const archive_1 = require("./services/archive");
const perf_1 = require("./services/perf");
const search_1 = require("./services/search");
/**
 * Completes setup atomically. `conn().tx` is only entered here — `applyPreset`
 * and `seedDemo` are transaction *bodies*, so a throw rolls everything back.
 */
function completeOnboarding(payload) {
    if ((0, settings_1.companyExists)()) {
        throw (0, errors_1.conflict)('This company file is already set up. Open Settings to make changes.');
    }
    const preset = industry_presets_1.INDUSTRY_PRESETS.find((candidate) => candidate.id === payload.presetId);
    if (!preset)
        throw (0, errors_1.validation)('presetId', 'Pick one of the listed industries.');
    if (payload.company.name.trim().length < 2) {
        throw (0, errors_1.validation)('company.name', 'Enter your company name.');
    }
    if (!Number.isInteger(payload.fiscalStartMonth) || payload.fiscalStartMonth < 1 || payload.fiscalStartMonth > 12) {
        throw (0, errors_1.validation)('fiscalStartMonth', 'The fiscal year must start in a month between 1 and 12.');
    }
    (0, auth_1.assertPasswordStrength)(payload.admin.password, payload.admin.username);
    // Validate the licence before anything is written, so a bad key cannot leave
    // a half-configured company behind.
    if (payload.licenseKey && payload.licenseKey.trim().length > 0) {
        (0, verify_1.verifyKey)(payload.licenseKey.trim(), (0, machine_1.machineId)());
    }
    const ownerRole = users.listRoles().find((role) => role.name === 'Owner');
    if (!ownerRole)
        throw (0, errors_1.notFound)('Owner role');
    const companyId = (0, node_crypto_1.randomUUID)();
    const at = (0, dates_1.nowIso)();
    let seeded = 0;
    (0, connection_1.conn)().tx(() => {
        (0, connection_1.conn)().run(`INSERT INTO companies (id, name, legal_name, tax_id, address_json, logo_path, base_currency,
         fiscal_year_start_month, date_format, number_format, industry_preset, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'yyyy-MM-dd', '1,234.56', ?, ?, ?)`, [
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
        ]);
        (0, seed_1.applyPreset)(preset.id, payload.currency);
        (0, settings_1.ensureFiscalYear)(payload.fiscalStartMonth);
        const secret = (0, auth_1.hashPassword)(payload.admin.password);
        const userId = (0, node_crypto_1.randomUUID)();
        (0, connection_1.conn)().run(`INSERT INTO users (id, username, full_name, email, password_hash, password_salt, password_algo,
         must_change_password, is_active, is_owner, prefs_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 1, '{}', ?, ?)`, [
            userId,
            payload.admin.username.trim().toLowerCase(),
            payload.admin.fullName.trim(),
            payload.admin.email?.trim() || null,
            secret.hash,
            secret.salt,
            secret.algo,
            at,
            at,
        ]);
        (0, connection_1.conn)().run('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [userId, ownerRole.id]);
        if (payload.loadDemo) {
            seeded = (0, seed_1.seedDemo)().created;
        }
        (0, settings_1.writeSetting)('onboarding.complete', { at, presetId: preset.id, currency: payload.currency }, userId);
        (0, settings_1.writeSetting)('license.notice.dismissed', false, userId);
        auditLog.append({
            actorId: userId,
            actorName: payload.admin.username.trim().toLowerCase(),
            entity: 'company',
            entityId: companyId,
            action: 'onboarding.complete',
            after: { name: payload.company.name, presetId: preset.id, currency: payload.currency, seeded },
        });
    });
    (0, connection_1.conn)().markDirty();
    // Files, not rows: activating outside the transaction is safe because the
    // key was already verified above.
    const edition = payload.licenseKey && payload.licenseKey.trim().length > 0
        ? license.activate(payload.licenseKey.trim(), { actorId: null, actorName: 'onboarding' }).edition
        : license.licenseStatus().edition;
    return { companyId, seeded, edition };
}
// ── notifications ────────────────────────────────────────────────────────────
function toNotification(row) {
    return {
        id: String(row['id']),
        userId: row['user_id'] === null ? null : String(row['user_id']),
        kind: String(row['kind']),
        title: String(row['title']),
        body: row['body'] === null ? null : String(row['body']),
        link: row['link'] === null ? null : String(row['link']),
        severity: String(row['severity']),
        readAt: row['read_at'] === null ? null : String(row['read_at']),
        createdAt: String(row['created_at']),
    };
}
function listNotifications(options) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 200);
    const rows = (0, connection_1.conn)().all(`SELECT * FROM notifications ${options.unreadOnly ? 'WHERE read_at IS NULL' : ''}
      ORDER BY created_at DESC LIMIT ?`, [limit]);
    return rows.map(toNotification);
}
function markNotificationsRead(input) {
    const at = (0, dates_1.nowIso)();
    if (input.all) {
        const row = (0, connection_1.conn)().one('SELECT COUNT(*) AS total FROM notifications WHERE read_at IS NULL');
        (0, connection_1.conn)().run('UPDATE notifications SET read_at = ? WHERE read_at IS NULL', [at]);
        return { updated: Number(row?.total ?? 0) };
    }
    let updated = 0;
    for (const id of input.ids ?? []) {
        (0, connection_1.conn)().run('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL', [at, id]);
        updated += 1;
    }
    return { updated };
}
// ── registration ─────────────────────────────────────────────────────────────
/** Registers the onboarding, settings and notification channels. */
function registerSettingsChannels(register) {
    register({
        channel: 'onboarding.preview',
        handler: (payload) => {
            const preset = industry_presets_1.INDUSTRY_PRESETS.find((candidate) => candidate.id === payload.presetId);
            if (!preset)
                throw (0, errors_1.validation)('presetId', 'Pick one of the listed industries.');
            return (0, industry_presets_1.previewOf)(preset);
        },
    });
    register({
        channel: 'onboarding.complete',
        handler: (payload) => completeOnboarding(payload),
    });
    register({
        channel: 'settings.company.save',
        handler: (payload) => (0, settings_1.saveCompany)(payload),
    });
    register({
        channel: 'settings.company.logo',
        handler: (payload) => (0, connection_1.conn)().tx(() => (0, settings_1.saveLogo)(payload.dataUrl)),
    });
    register({
        channel: 'settings.numbering.list',
        handler: () => (0, settings_1.listSequences)(),
    });
    register({
        channel: 'settings.numbering.save',
        handler: (payload) => (0, connection_1.conn)().tx(() => (0, settings_1.saveSequence)(payload)),
    });
    register({
        channel: 'settings.numbering.preview',
        handler: (payload) => (0, settings_1.previewNumber)(payload.docType),
    });
    register({
        channel: 'settings.numbering.reset',
        handler: (payload) => {
            if (!payload.reason || payload.reason.trim().length < 3) {
                throw (0, errors_1.validation)('reason', 'Say why the sequence is being reset — it goes in the audit log.');
            }
            return (0, connection_1.conn)().tx(() => (0, settings_1.resetSequence)(payload.docType));
        },
    });
    register({
        channel: 'settings.currency.setBase',
        handler: (payload) => (0, connection_1.conn)().tx(() => (0, settings_1.setBaseCurrency)(payload.code)),
    });
    register({
        channel: 'settings.presets.list',
        handler: () => industry_presets_1.INDUSTRY_PRESETS.map((preset) => ({
            id: preset.id,
            label: preset.label,
            description: preset.description,
            modules: preset.modules,
            landing: preset.landingModule,
        })),
    });
    register({
        channel: 'settings.presets.preview',
        handler: (payload) => {
            const preset = industry_presets_1.INDUSTRY_PRESETS.find((candidate) => candidate.id === payload.presetId);
            if (!preset)
                throw (0, errors_1.validation)('presetId', 'Pick one of the listed industries.');
            return (0, industry_presets_1.previewOf)(preset);
        },
    });
    register({
        channel: 'settings.presets.apply',
        handler: (payload) => {
            if (!payload.confirm) {
                throw (0, errors_1.validation)('confirm', 'Applying an industry preset adds accounts, taxes and fields. Confirm first.');
            }
            if (!(0, settings_1.getCompany)())
                throw (0, errors_1.notFound)('Company');
            return (0, connection_1.conn)().tx(() => (0, seed_1.applyPreset)(payload.presetId));
        },
    });
    register({
        channel: 'settings.demoData.seed',
        handler: () => {
            if ((0, seed_1.demoLoaded)())
                throw (0, errors_1.conflict)('Demo data is already loaded. Remove it before seeding again.');
            return (0, connection_1.conn)().tx(() => (0, seed_1.seedDemo)());
        },
    });
    register({
        channel: 'settings.demoData.remove',
        handler: () => (0, connection_1.conn)().tx(() => (0, seed_1.removeDemo)()),
    });
    register({
        channel: 'settings.security.save',
        handler: (payload) => (0, connection_1.conn)().tx(() => (0, settings_1.saveSecurity)(payload)),
    });
    register({
        channel: 'notifications.list',
        handler: (payload) => listNotifications(payload),
    });
    register({
        channel: 'notifications.markRead',
        handler: (payload) => (0, connection_1.conn)().tx(() => markNotificationsRead(payload)),
    });
    // ── scale: performance fixtures, archive, search (R1) ──────────────────────
    register({
        channel: 'settings.perf.generate',
        handler: (payload) => (0, perf_1.generatePerfDataset)(payload),
    });
    register({
        channel: 'settings.perf.benchmark',
        handler: () => (0, perf_1.benchmark)(),
    });
    register({
        channel: 'data.archive.preview',
        handler: (payload) => (0, archive_1.archivePreview)(payload.before),
    });
    register({
        channel: 'data.archive.run',
        handler: (payload, ctx) => (0, connection_1.conn)().tx(() => (0, archive_1.archiveOldRecords)({
            before: payload.before,
            tables: payload.tables,
            reason: payload.reason,
            limit: payload.limit,
            actorId: ctx.actorId,
        })),
    });
    register({
        channel: 'data.archive.restore',
        handler: (payload) => (0, connection_1.conn)().tx(() => (0, archive_1.restoreArchived)(payload.id)),
    });
    register({
        channel: 'data.archive.stats',
        handler: () => (0, archive_1.archiveStats)(),
    });
    register({
        channel: 'data.archive.vacuum',
        handler: () => (0, archive_1.vacuum)(),
    });
    register({
        channel: 'search.global',
        handler: (payload) => (0, search_1.searchGlobal)(payload.q, { limit: payload.limit, kinds: payload.kinds }),
    });
    register({
        channel: 'search.palette',
        handler: (payload) => (0, search_1.searchPalette)(payload.q),
    });
}
//# sourceMappingURL=ipc.settings.js.map