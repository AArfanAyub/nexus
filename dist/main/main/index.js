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
/**
 * Application bootstrap.
 *
 * Order matters: security policy → database → migrations → RBAC seed → licence
 * clock check → IPC registry → window. Anything that fails before the window
 * exists must show a dialog with the resolved path, never a white screen
 * (risk R1, T02 acceptance #5).
 */
const electron_1 = require("electron");
const security_1 = require("./security");
const connection_1 = require("./db/connection");
const migrate_1 = require("./db/migrate");
const ipc_1 = require("./ipc");
const jobs_1 = require("./jobs");
const log_1 = require("./log");
const auth = __importStar(require("./services/auth"));
const license = __importStar(require("./services/license"));
const users_1 = require("./services/users");
const window_1 = require("./window");
const IDLE_TICK_MS = 30_000;
/**
 * How long after one automatic recovery a second crash is treated as a loop.
 *
 * A GPU process that cannot start crashes again within a second of the reload,
 * so an unguarded handler reloads forever and the operator sees a window that
 * flickers instead of an explanation.
 */
const RECOVERY_COOLDOWN_MS = 30_000;
let lastRecoveryAt = 0;
let idleTimer = null;
function stopIdleTimer() {
    if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
    }
}
/** Locks the session when the idle policy is exceeded and tells the renderer. */
function startIdleTimer() {
    stopIdleTimer();
    idleTimer = setInterval(() => {
        try {
            if (auth.checkIdle()) {
                (0, window_1.sendToRenderer)('app:lock', { at: new Date().toISOString() });
                (0, log_1.logInfo)('auth.idle', 'session locked after the idle timeout');
            }
        }
        catch (error) {
            (0, log_1.logError)('auth.idle', error);
        }
    }, IDLE_TICK_MS);
    idleTimer.unref();
}
function fatal(title, detail) {
    electron_1.dialog.showErrorBox(title, detail);
}
async function bootstrap() {
    (0, security_1.applySecurityPolicy)();
    try {
        await (0, connection_1.initConnection)();
    }
    catch (error) {
        const wasm = (0, connection_1.resolveWasmPath)();
        const dbPath = (0, connection_1.resolveDatabasePath)();
        (0, log_1.logError)('bootstrap.database', error, { wasm, dbPath });
        fatal('NEXUS cannot start', [
            'The database engine could not be loaded, so nothing was opened or changed.',
            '',
            `Engine file expected at:\n${wasm}`,
            '',
            `Database location:\n${dbPath}`,
            '',
            error instanceof Error ? error.message : String(error),
        ].join('\n'));
        electron_1.app.quit();
        return;
    }
    try {
        const migration = (0, migrate_1.migrate)();
        (0, log_1.logInfo)('bootstrap.migrate', `schema at v${String(migration.to)}`);
        (0, users_1.ensureRolePresets)();
        const clock = license.onStartup();
        if (clock.suspectClock) {
            (0, log_1.logInfo)('bootstrap.license', 'suspect clock flagged; work continues normally');
        }
        (0, ipc_1.registerIpc)();
        (0, window_1.createMainWindow)();
        startIdleTimer();
        (0, jobs_1.startJobs)();
        (0, log_1.logInfo)('bootstrap', `NEXUS ${electron_1.app.getVersion()} ready (packaged: ${String(electron_1.app.isPackaged)})`);
    }
    catch (error) {
        (0, log_1.logError)('bootstrap', error);
        fatal('NEXUS cannot start', [
            'Startup failed before the window opened, so nothing was changed.',
            '',
            error instanceof Error ? error.message : String(error),
            '',
            'The full detail is in logs/main.log next to the database.',
        ].join('\n'));
        electron_1.app.quit();
    }
}
const hasSingleInstanceLock = electron_1.app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', () => {
        (0, window_1.focusMainWindow)();
    });
    void electron_1.app.whenReady().then(bootstrap);
    electron_1.app.on('activate', () => {
        if ((0, window_1.getMainWindow)() === null) {
            (0, window_1.createMainWindow)();
        }
        else {
            (0, window_1.focusMainWindow)();
        }
    });
}
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
/**
 * A Chromium child process died — the GPU process, the network service, a
 * utility process.
 *
 * This is the class of failure that produced a blank window with an empty log:
 * `Network service crashed, restarting service.` was printed by Chromium to
 * stderr, nothing reached `logs/main.log`, and the window was unusable. Every
 * branch below writes a line first, because a silent failure is the one thing
 * support cannot work from.
 */
electron_1.app.on('child-process-gone', (_event, details) => {
    const type = String(details.type);
    (0, log_1.logError)('app.child-process-gone', new Error(`${type} process gone: ${details.reason}`), {
        type,
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: details.serviceName ?? null,
        name: details.name ?? null,
    });
    // The renderer has its own handler with its own dialog; the GPU and utility
    // processes have no window of their own, so the window has to be rebuilt.
    if (type !== 'GPU' && type !== 'Utility')
        return;
    const now = Date.now();
    if (now - lastRecoveryAt < RECOVERY_COOLDOWN_MS) {
        (0, log_1.logError)('app.child-process-gone', new Error(`${type} crashed again within ${String(RECOVERY_COOLDOWN_MS)} ms — not reloading`), { type, reason: details.reason });
        return;
    }
    lastRecoveryAt = now;
    (0, log_1.logInfo)('app.child-process-gone', `rebuilding the window after a ${type} crash`);
    (0, window_1.restartMainWindow)();
});
electron_1.app.on('before-quit', () => {
    stopIdleTimer();
    (0, jobs_1.stopJobs)();
    try {
        // Hard flush: the debounced writer must not lose the last 200 ms of work.
        if ((0, connection_1.isConnected)())
            (0, connection_1.conn)().flushNow();
    }
    catch (error) {
        (0, log_1.logError)('shutdown.flush', error);
    }
});
process.on('uncaughtException', (error) => {
    (0, log_1.logError)('uncaughtException', error);
});
process.on('unhandledRejection', (reason) => {
    (0, log_1.logError)('unhandledRejection', reason);
});
//# sourceMappingURL=index.js.map