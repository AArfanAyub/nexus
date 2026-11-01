"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logDirectory = logDirectory;
exports.logFile = logFile;
exports.logError = logError;
exports.logWarn = logWarn;
exports.logInfo = logInfo;
exports.readLogTail = readLogTail;
/**
 * Main-process file logging. The ONLY place a stack trace or SQL text is
 * allowed to land: `%APPDATA%/nexus/logs/main.log`. Nothing written here may
 * ever be sent to the renderer (CONVENTIONS §6).
 */
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
let resolvedLogDir = null;
let resolvedLogFile = null;
/** `%APPDATA%/nexus/logs` — created on first write. */
function logDirectory() {
    if (resolvedLogDir)
        return resolvedLogDir;
    try {
        resolvedLogDir = node_path_1.default.join(electron_1.app.getPath('userData'), 'logs');
    }
    catch {
        resolvedLogDir = node_path_1.default.join(process.cwd(), 'logs');
    }
    return resolvedLogDir;
}
/** Absolute path of `main.log`. */
function logFile() {
    if (resolvedLogFile)
        return resolvedLogFile;
    resolvedLogFile = node_path_1.default.join(logDirectory(), 'main.log');
    return resolvedLogFile;
}
function serialise(value) {
    if (value instanceof Error) {
        return `${value.name}: ${value.message}\n${value.stack ?? '(no stack)'}`;
    }
    if (typeof value === 'object' && value !== null) {
        try {
            return JSON.stringify(value);
        }
        catch {
            return String(value);
        }
    }
    return String(value);
}
function write(level, scope, message) {
    const line = `${new Date().toISOString()} ${level} [${scope}] ${message}\n`;
    try {
        (0, node_fs_1.mkdirSync)(logDirectory(), { recursive: true });
        (0, node_fs_1.appendFileSync)(logFile(), line, 'utf8');
    }
    catch {
        // Logging must never take the app down.
    }
    if (level !== 'INFO')
        process.stderr.write(line);
}
/** Logs a caught error with its stack. Returns the message that was logged. */
function logError(scope, error, meta) {
    const detail = serialise(error);
    const suffix = meta ? ` ${serialise(meta)}` : '';
    write('ERROR', scope, `${detail}${suffix}`);
    return detail;
}
/** Logs a warning. */
function logWarn(scope, message) {
    write('WARN', scope, message);
}
/** Logs an informational line (startup, migrations, paths). */
function logInfo(scope, message) {
    write('INFO', scope, message);
}
/** Returns the last `lines` lines of the log, for the diagnostics panel. */
function readLogTail(lines = 200) {
    try {
        const content = (0, node_fs_1.readFileSync)(logFile(), 'utf8');
        return content.split('\n').slice(-lines);
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=log.js.map