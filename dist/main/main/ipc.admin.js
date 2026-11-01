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
exports.diffEntry = diffEntry;
exports.registerAdminChannels = registerAdminChannels;
/**
 * Admin channel handlers (T10): import, backup, and the audit diff.
 *
 * Thin by design. Two things are worth knowing about this file:
 *
 *   - the **file and folder dialogs** live here rather than in the service,
 *     because `dialog` needs a parent window and the service must stay callable
 *     from a test with no Electron at all;
 *   - `data.import.commit` emits `job:progress` between batches, which is the
 *     only reason a 10 000-row import does not freeze the window.
 */
const electron_1 = require("electron");
const errors_1 = require("./errors");
const auditLog = __importStar(require("./services/audit"));
const backup = __importStar(require("./services/backup"));
const importexport = __importStar(require("./services/importexport"));
const cache_1 = require("./services/cache");
const window_1 = require("./window");
function scopeOf(ctx) {
    return { actorId: ctx.actorId, actorName: ctx.actorName };
}
/** Renders one side of a field for display without pretending to be a JSON viewer. */
function display(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
/**
 * Field-level diff of one audit entry.
 *
 * Three buckets rather than one list of pairs: an added field and a changed
 * field mean different things to a reviewer ("this column started being written"
 * versus "this value moved"), and a removed field is the one worth staring at.
 */
function diffEntry(seq) {
    const row = auditLog.bySeq(seq);
    if (!row)
        throw (0, errors_1.notFound)('Audit entry');
    const before = (row.before ?? {});
    const after = (row.after ?? {});
    const beforeKeys = Object.keys(before);
    const afterKeys = Object.keys(after);
    const added = [];
    const removed = [];
    const changed = [];
    for (const key of afterKeys) {
        if (!beforeKeys.includes(key)) {
            added.push({ field: key, before: null, after: display(after[key]) });
            continue;
        }
        const left = display(before[key]);
        const right = display(after[key]);
        if (left !== right)
            changed.push({ field: key, before: left, after: right });
    }
    for (const key of beforeKeys) {
        if (!afterKeys.includes(key))
            removed.push({ field: key, before: display(before[key]), after: null });
    }
    return { seq, added, removed, changed };
}
function registerAdminChannels(register) {
    // ── import ─────────────────────────────────────────────────────────────────
    register({
        channel: 'data.import.pick',
        handler: async () => {
            const result = await electron_1.dialog.showOpenDialog({
                title: 'Choose a file to import',
                properties: ['openFile'],
                filters: [
                    { name: 'Spreadsheets', extensions: ['csv', 'xlsx', 'xls', 'tsv'] },
                    { name: 'All files', extensions: ['*'] },
                ],
            });
            if (result.canceled || result.filePaths.length === 0)
                return { path: null };
            return { path: result.filePaths[0] ?? null };
        },
    });
    register({
        channel: 'data.import.parse',
        handler: (payload) => {
            if (!importexport.isImportEntity(payload.entity)) {
                throw (0, errors_1.validation)('entity', 'That is not something you can import.');
            }
            return importexport.parse(payload.entity, payload.path);
        },
    });
    register({
        channel: 'data.import.validate',
        handler: (payload) => importexport.validate(payload.batchId, payload.mapping, payload.updateExisting === true),
    });
    register({
        channel: 'data.import.commit',
        handler: (payload, ctx) => {
            const result = importexport.commit(payload.batchId, scopeOf(ctx), (progress) => {
                (0, window_1.sendToRenderer)('job:progress', progress);
            });
            // An import writes customers, products and accounts; every list that could
            // be showing them is now wrong.
            (0, cache_1.invalidateCache)('');
            return result;
        },
    });
    register({
        channel: 'data.import.template',
        handler: (payload) => {
            if (!importexport.isImportEntity(payload.entity)) {
                throw (0, errors_1.validation)('entity', 'That is not something you can import.');
            }
            return importexport.template(payload.entity);
        },
    });
    // ── backup ─────────────────────────────────────────────────────────────────
    register({
        channel: 'backup.pickFolder',
        handler: async () => {
            const result = await electron_1.dialog.showOpenDialog({
                title: 'Choose a folder for the backup',
                properties: ['openDirectory', 'createDirectory'],
            });
            if (result.canceled || result.filePaths.length === 0)
                return { directory: null };
            return { directory: result.filePaths[0] ?? null };
        },
    });
    register({
        channel: 'backup.run',
        handler: async (payload, ctx) => backup.create(payload.directory, scopeOf(ctx)),
    });
    register({
        channel: 'backup.list',
        handler: (payload) => backup.list(payload.directory),
    });
    register({
        channel: 'backup.verify',
        handler: async (payload) => backup.verify(payload.path),
    });
    register({
        channel: 'backup.restore',
        handler: async (payload, ctx) => {
            if (payload.path.trim().length === 0)
                throw (0, errors_1.conflict)('Choose a backup to restore.');
            const result = await backup.restore(payload.path, scopeOf(ctx), {
                skipSafetyCopy: payload.skipSafetyCopy === true,
            });
            return result;
        },
    });
    // ── audit diff ─────────────────────────────────────────────────────────────
    register({
        channel: 'audit.diff',
        handler: (payload) => diffEntry(payload.seq),
    });
}
//# sourceMappingURL=ipc.admin.js.map