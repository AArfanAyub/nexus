/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Application bootstrap.
 *
 * Order matters: security policy → database → migrations → RBAC seed → licence
 * clock check → IPC registry → window. Anything that fails before the window
 * exists must show a dialog with the resolved path, never a white screen
 * (risk R1, T02 acceptance #5).
 */

import { app, dialog } from 'electron';

import { applySecurityPolicy } from './security';
import { conn, initConnection, isConnected, resolveDatabasePath, resolveWasmPath } from './db/connection';
import { migrate } from './db/migrate';
import { registerIpc } from './ipc';
import { startJobs, stopJobs } from './jobs';
import { logError, logInfo } from './log';
import * as auth from './services/auth';
import * as license from './services/license';
import { ensureRolePresets } from './services/users';
import { createMainWindow, focusMainWindow, getMainWindow, restartMainWindow, sendToRenderer } from './window';

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

let idleTimer: NodeJS.Timeout | null = null;

function stopIdleTimer(): void {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

/** Locks the session when the idle policy is exceeded and tells the renderer. */
function startIdleTimer(): void {
  stopIdleTimer();
  idleTimer = setInterval(() => {
    try {
      if (auth.checkIdle()) {
        sendToRenderer('app:lock', { at: new Date().toISOString() });
        logInfo('auth.idle', 'session locked after the idle timeout');
      }
    } catch (error) {
      logError('auth.idle', error);
    }
  }, IDLE_TICK_MS);
  idleTimer.unref();
}

function fatal(title: string, detail: string): void {
  dialog.showErrorBox(title, detail);
}

async function bootstrap(): Promise<void> {
  applySecurityPolicy();

  try {
    await initConnection();
  } catch (error) {
    const wasm = resolveWasmPath();
    const dbPath = resolveDatabasePath();
    logError('bootstrap.database', error, { wasm, dbPath });
    fatal(
      'NEXUS cannot start',
      [
        'The database engine could not be loaded, so nothing was opened or changed.',
        '',
        `Engine file expected at:\n${wasm}`,
        '',
        `Database location:\n${dbPath}`,
        '',
        error instanceof Error ? error.message : String(error),
      ].join('\n'),
    );
    app.quit();
    return;
  }

  try {
    const migration = migrate();
    logInfo('bootstrap.migrate', `schema at v${String(migration.to)}`);

    ensureRolePresets();

    const clock = license.onStartup();
    if (clock.suspectClock) {
      logInfo('bootstrap.license', 'suspect clock flagged; work continues normally');
    }

    registerIpc();
    createMainWindow();
    startIdleTimer();
    startJobs();

    logInfo('bootstrap', `NEXUS ${app.getVersion()} ready (packaged: ${String(app.isPackaged)})`);
  } catch (error) {
    logError('bootstrap', error);
    fatal(
      'NEXUS cannot start',
      [
        'Startup failed before the window opened, so nothing was changed.',
        '',
        error instanceof Error ? error.message : String(error),
        '',
        'The full detail is in logs/main.log next to the database.',
      ].join('\n'),
    );
    app.quit();
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });

  void app.whenReady().then(bootstrap);

  app.on('activate', () => {
    if (getMainWindow() === null) {
      createMainWindow();
    } else {
      focusMainWindow();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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
app.on('child-process-gone', (_event, details) => {
  const type = String(details.type);
  logError('app.child-process-gone', new Error(`${type} process gone: ${details.reason}`), {
    type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName ?? null,
    name: details.name ?? null,
  });

  // The renderer has its own handler with its own dialog; the GPU and utility
  // processes have no window of their own, so the window has to be rebuilt.
  if (type !== 'GPU' && type !== 'Utility') return;

  const now = Date.now();
  if (now - lastRecoveryAt < RECOVERY_COOLDOWN_MS) {
    logError(
      'app.child-process-gone',
      new Error(`${type} crashed again within ${String(RECOVERY_COOLDOWN_MS)} ms — not reloading`),
      { type, reason: details.reason },
    );
    return;
  }
  lastRecoveryAt = now;
  logInfo('app.child-process-gone', `rebuilding the window after a ${type} crash`);
  restartMainWindow();
});

app.on('before-quit', () => {
  stopIdleTimer();
  stopJobs();
  try {
    // Hard flush: the debounced writer must not lose the last 200 ms of work.
    if (isConnected()) conn().flushNow();
  } catch (error) {
    logError('shutdown.flush', error);
  }
});

process.on('uncaughtException', (error) => {
  logError('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason);
});
