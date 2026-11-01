"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CSP_PRODUCTION = exports.CSP_DEVELOPMENT = void 0;
exports.currentCsp = currentCsp;
exports.isAppUrl = isAppUrl;
exports.hardenWebContents = hardenWebContents;
exports.applySecurityPolicy = applySecurityPolicy;
/**
 * Electron hardening (ARCHITECTURE §F.1).
 *
 * Everything here is a mitigation for a named threat in §F.2:
 *   CSP                → T5 (XSS via imported data), offline mandate
 *   navigation guards  → T7 (renderer reaching out)
 *   permission handler → camera/mic/notifications denied wholesale
 *   devtools gating    → T2 (patched build), production hygiene
 */
const node_path_1 = __importDefault(require("node:path"));
const node_url_1 = require("node:url");
const electron_1 = require("electron");
const csp_1 = require("../shared/csp");
const log_1 = require("./log");
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? '';
/**
 * The policies themselves live in `shared/csp.ts` so the Vite build can put the
 * production one into `index.html` — a `file://` load has no response headers, so
 * the meta tag is the policy that actually applies to a packaged app.
 */
var csp_2 = require("../shared/csp");
Object.defineProperty(exports, "CSP_DEVELOPMENT", { enumerable: true, get: function () { return csp_2.CSP_DEVELOPMENT; } });
Object.defineProperty(exports, "CSP_PRODUCTION", { enumerable: true, get: function () { return csp_2.CSP_PRODUCTION; } });
/** The CSP for the current mode. */
function currentCsp() {
    return electron_1.app.isPackaged ? csp_1.CSP_PRODUCTION : csp_1.CSP_DEVELOPMENT;
}
/**
 * True for URLs that belong to this application: the packaged `dist/renderer`
 * bundle, or the dev server origin. Everything else is a navigation attempt and
 * is denied.
 */
function isAppUrl(url) {
    if (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL))
        return true;
    if (!url.startsWith('file://'))
        return false;
    try {
        const parsed = new URL(url);
        const target = node_path_1.default.normalize((0, node_url_1.fileURLToPath)(`file://${parsed.pathname}`));
        const rendererRoot = node_path_1.default.join(electron_1.app.getAppPath(), 'dist', 'renderer');
        return target.startsWith(rendererRoot);
    }
    catch {
        return false;
    }
}
/** Denies every window.open, every foreign navigation and every webview. */
function hardenWebContents(contents) {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
        if (!isAppUrl(url)) {
            event.preventDefault();
            (0, log_1.logWarn)('security', `blocked navigation to ${url}`);
        }
    });
    contents.on('will-attach-webview', (event) => {
        event.preventDefault();
        (0, log_1.logWarn)('security', 'blocked a webview attachment');
    });
    contents.on('will-redirect', (event, url) => {
        if (!isAppUrl(url)) {
            event.preventDefault();
            (0, log_1.logWarn)('security', `blocked redirect to ${url}`);
        }
    });
    // Production: no DevTools, no reload shortcuts, no menu.
    contents.on('devtools-opened', () => {
        if (electron_1.app.isPackaged)
            contents.closeDevTools();
    });
    contents.on('before-input-event', (event, input) => {
        if (!electron_1.app.isPackaged)
            return;
        const key = input.key.toLowerCase();
        const devtoolsChord = key === 'f12' || (input.control && input.shift && key === 'i');
        const reloadChord = (input.control || input.meta) && key === 'r';
        if (devtoolsChord || reloadChord) {
            event.preventDefault();
            (0, log_1.logWarn)('security', `blocked ${key} in the packaged build`);
        }
    });
}
/**
 * Applies the session-wide policy. Call once, after `app.whenReady()` and
 * before the first window is created.
 */
function applySecurityPolicy() {
    const defaultSession = electron_1.session.defaultSession;
    // No camera, microphone, geolocation, notifications, clipboard-read, MIDI.
    defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    defaultSession.setPermissionCheckHandler(() => false);
    defaultSession.setSpellCheckerEnabled(false);
    defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = { ...details.responseHeaders };
        // Never let a response header from disk win over our policy.
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'content-security-policy')
                delete headers[key];
        }
        headers['Content-Security-Policy'] = [currentCsp()];
        headers['X-Content-Type-Options'] = ['nosniff'];
        headers['Referrer-Policy'] = ['no-referrer'];
        callback({ responseHeaders: headers });
    });
    electron_1.app.on('web-contents-created', (_event, contents) => {
        hardenWebContents(contents);
    });
    if (electron_1.app.isPackaged) {
        electron_1.Menu.setApplicationMenu(null);
    }
}
//# sourceMappingURL=security.js.map