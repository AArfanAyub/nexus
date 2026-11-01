"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRELOAD_PATH = void 0;
exports.getMainWindow = getMainWindow;
exports.restartMainWindow = restartMainWindow;
exports.createMainWindow = createMainWindow;
exports.sendToRenderer = sendToRenderer;
exports.focusMainWindow = focusMainWindow;
/**
 * The single application window.
 *
 * `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` means
 * the renderer cannot reach Node even if a dependency is compromised (T7). The
 * only bridge is the preload, which exposes an allow-listed `invoke`.
 *
 * The window is hidden until `ready-to-show` so the user never sees a white
 * flash, and it is sized for the 240px sidebar + a 10-column table.
 */
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
const log_1 = require("./log");
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? '';
/** `dist/main/main` → `dist/main/preload/index.js` */
exports.PRELOAD_PATH = node_path_1.default.join(__dirname, '..', 'preload', 'index.js');
/** `dist/main/main` → `dist/renderer/index.html` */
const RENDERER_INDEX = node_path_1.default.join(__dirname, '..', '..', 'renderer', 'index.html');
let mainWindow = null;
/**
 * True while a crash dialog is on screen.
 *
 * A renderer that crashes on load crashes again the moment it is reloaded, so
 * without this guard the operator gets a stack of identical dialogs and cannot
 * reach the Quit button underneath them.
 */
let crashDialogOpen = false;
/** The current window, or `null` after it was closed. */
function getMainWindow() {
    return mainWindow;
}
/**
 * Rebuilds the window from scratch.
 *
 * `webContents.reload()` is not enough after a renderer crash: the process is
 * gone, so reloading the dead `webContents` shows nothing at all — the blank
 * window this exists to prevent. The window itself has to be destroyed and
 * created again.
 */
function restartMainWindow() {
    const current = mainWindow;
    mainWindow = null;
    if (current && !current.isDestroyed())
        current.destroy();
    createMainWindow();
}
/** Creates (and shows) the application window. */
function createMainWindow() {
    const isWindows = process.platform === 'win32';
    const window = new electron_1.BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1180,
        minHeight: 720,
        show: false,
        // Packaged builds carry the icon in the executable and in resources/; the
        // dev build has no .exe of its own, so it points at the same PNG on disk.
        ...(electron_1.app.isPackaged ? { icon: node_path_1.default.join(process.resourcesPath, 'icon.png') } : { icon: node_path_1.default.join(electron_1.app.getAppPath(), 'build', 'icon.png') }),
        backgroundColor: '#161b22',
        autoHideMenuBar: true,
        title: 'NEXUS',
        // Custom titlebar: the renderer draws the bar, Chromium draws the buttons.
        ...(isWindows
            ? {
                titleBarStyle: 'hidden',
                titleBarOverlay: { color: '#161b22', symbolColor: '#e6edf3', height: 48 },
            }
            : { titleBarStyle: 'default' }),
        webPreferences: {
            preload: exports.PRELOAD_PATH,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            webviewTag: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: false,
            spellcheck: false,
            devTools: !electron_1.app.isPackaged,
        },
    });
    window.once('ready-to-show', () => {
        window.show();
    });
    window.on('closed', () => {
        mainWindow = null;
    });
    window.webContents.on('did-fail-load', (_event, code, description, url) => {
        (0, log_1.logError)('window.load', new Error(`${description} (${String(code)})`), { url });
    });
    /**
     * The renderer died. Without this the window stays open and blank, the process
     * keeps running, and the log says nothing — which is exactly what happened in
     * the field when the network service crashed underneath it.
     */
    window.webContents.on('render-process-gone', (_event, details) => {
        (0, log_1.logError)('window.render-gone', new Error(`renderer gone: ${details.reason} (exit code ${String(details.exitCode)})`), { reason: details.reason, exitCode: details.exitCode });
        void offerRecovery(window, {
            message: 'NEXUS stopped responding',
            detail: 'The window stopped running and had to be closed.\n\n' +
                'Your data is safe: everything is written to disk as you go. Reloading ' +
                'reopens the last company.',
            reason: details.reason,
        });
    });
    /** Chromium's own "this page is not responding" — offer the same two doors. */
    window.webContents.on('unresponsive', () => {
        (0, log_1.logError)('window.unresponsive', new Error('renderer stopped responding'));
        void offerRecovery(window, {
            message: 'NEXUS is not responding',
            detail: 'The window has stopped answering. You can wait for it to recover, or ' +
                'reload it — nothing is lost, because every change is already on disk.',
            reason: 'unresponsive',
        });
    });
    window.webContents.on('responsive', () => {
        (0, log_1.logInfo)('window.responsive', 'the renderer is answering again');
    });
    if (DEV_SERVER_URL) {
        void window.loadURL(DEV_SERVER_URL).catch((error) => {
            (0, log_1.logError)('window.loadURL', error, { url: DEV_SERVER_URL });
        });
    }
    else {
        void window.loadFile(RENDERER_INDEX).catch((error) => {
            (0, log_1.logError)('window.loadFile', error, { path: RENDERER_INDEX });
        });
    }
    mainWindow = window;
    return window;
}
/** Sends a main → renderer event to the live window, if any. */
function sendToRenderer(channel, payload) {
    if (!mainWindow || mainWindow.isDestroyed())
        return;
    mainWindow.webContents.send(channel, payload);
}
/** Focuses an existing window (single-instance lock). */
function focusMainWindow() {
    if (!mainWindow)
        return;
    if (mainWindow.isMinimized())
        mainWindow.restore();
    mainWindow.focus();
}
/**
 * Asks the operator what to do after a crash or a hang.
 *
 * Two doors, both of which work: **Reload** rebuilds the window, **Quit** exits
 * cleanly through `before-quit` so the database is flushed. A dialog that offers
 * only "OK" over a blank window is the failure this replaces.
 */
async function offerRecovery(window, input) {
    if (crashDialogOpen)
        return;
    crashDialogOpen = true;
    try {
        const parent = window.isDestroyed() ? null : window;
        const options = {
            type: 'error',
            buttons: ['Reload', 'Quit'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
            title: 'NEXUS',
            message: input.message,
            detail: input.detail,
        };
        const result = parent ? await electron_1.dialog.showMessageBox(parent, options) : await electron_1.dialog.showMessageBox(options);
        if (result.response === 0) {
            (0, log_1.logInfo)('window.recovery', `reloading after ${input.reason}`);
            restartMainWindow();
        }
        else {
            (0, log_1.logInfo)('window.recovery', `quitting after ${input.reason}`);
            electron_1.app.quit();
        }
    }
    catch (error) {
        // A dialog that cannot be shown must not become the second silent failure.
        (0, log_1.logError)('window.recovery', error, { reason: input.reason });
        (0, log_1.logWarn)('window.recovery', 'recovery dialog failed; reloading the window instead');
        restartMainWindow();
    }
    finally {
        crashDialogOpen = false;
    }
}
//# sourceMappingURL=window.js.map