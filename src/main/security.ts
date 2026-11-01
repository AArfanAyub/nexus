/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Electron hardening (ARCHITECTURE §F.1).
 *
 * Everything here is a mitigation for a named threat in §F.2:
 *   CSP                → T5 (XSS via imported data), offline mandate
 *   navigation guards  → T7 (renderer reaching out)
 *   permission handler → camera/mic/notifications denied wholesale
 *   devtools gating    → T2 (patched build), production hygiene
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Menu, app, session, type WebContents } from 'electron';

import { CSP_DEVELOPMENT, CSP_PRODUCTION } from '../shared/csp';
import { logWarn } from './log';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? '';

/**
 * The policies themselves live in `shared/csp.ts` so the Vite build can put the
 * production one into `index.html` — a `file://` load has no response headers, so
 * the meta tag is the policy that actually applies to a packaged app.
 */
export { CSP_DEVELOPMENT, CSP_PRODUCTION } from '../shared/csp';

/** The CSP for the current mode. */
export function currentCsp(): string {
  return app.isPackaged ? CSP_PRODUCTION : CSP_DEVELOPMENT;
}

/**
 * True for URLs that belong to this application: the packaged `dist/renderer`
 * bundle, or the dev server origin. Everything else is a navigation attempt and
 * is denied.
 */
export function isAppUrl(url: string): boolean {
  if (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL)) return true;
  if (!url.startsWith('file://')) return false;
  try {
    const parsed = new URL(url);
    const target = path.normalize(fileURLToPath(`file://${parsed.pathname}`));
    const rendererRoot = path.join(app.getAppPath(), 'dist', 'renderer');
    return target.startsWith(rendererRoot);
  } catch {
    return false;
  }
}

/** Denies every window.open, every foreign navigation and every webview. */
export function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      logWarn('security', `blocked navigation to ${url}`);
    }
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    logWarn('security', 'blocked a webview attachment');
  });

  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      logWarn('security', `blocked redirect to ${url}`);
    }
  });

  // Production: no DevTools, no reload shortcuts, no menu.
  contents.on('devtools-opened', () => {
    if (app.isPackaged) contents.closeDevTools();
  });

  contents.on('before-input-event', (event, input) => {
    if (!app.isPackaged) return;
    const key = input.key.toLowerCase();
    const devtoolsChord = key === 'f12' || (input.control && input.shift && key === 'i');
    const reloadChord = (input.control || input.meta) && key === 'r';
    if (devtoolsChord || reloadChord) {
      event.preventDefault();
      logWarn('security', `blocked ${key} in the packaged build`);
    }
  });
}

/**
 * Applies the session-wide policy. Call once, after `app.whenReady()` and
 * before the first window is created.
 */
export function applySecurityPolicy(): void {
  const defaultSession = session.defaultSession;

  // No camera, microphone, geolocation, notifications, clipboard-read, MIDI.
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  defaultSession.setPermissionCheckHandler(() => false);
  defaultSession.setSpellCheckerEnabled(false);

  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    // Never let a response header from disk win over our policy.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    }
    headers['Content-Security-Policy'] = [currentCsp()];
    headers['X-Content-Type-Options'] = ['nosniff'];
    headers['Referrer-Policy'] = ['no-referrer'];
    callback({ responseHeaders: headers });
  });

  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents);
  });

  if (app.isPackaged) {
    Menu.setApplicationMenu(null);
  }
}
