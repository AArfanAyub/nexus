"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CSP_DEVELOPMENT = exports.CSP_PRODUCTION = void 0;
/**
 * The Content-Security-Policy, in one place, importable from both sides.
 *
 * It lives in `shared/` rather than in `main/security.ts` because three things
 * need the same string and none of them can import the others:
 *
 *  - the main process, as a response header (`onHeadersReceived`);
 *  - the Vite build, to rewrite the `<meta>` in `index.html` for a packaged
 *    build (`vite.config.ts` — a config file cannot import `electron`);
 *  - the offline probe, which asserts the packaged document really carries
 *    `connect-src 'none'`.
 *
 * ## Why the meta tag matters at all
 *
 * `onHeadersReceived` never fires for a `file://` load — there is no HTTP
 * response to attach a header to. In a packaged build the `<meta>` tag in
 * `index.html` *is* the policy, and it used to be the development one: it still
 * allowed `ws://localhost:5173`. Nothing listens there in a shipped app, but a
 * policy that permits a socket is not an offline guarantee. The build now
 * rewrites it (see `scripts/probe-offline.mjs`, which fails the run on anything
 * that is not `connect-src 'none'`).
 */
/** Production: no network at all. The offline mandate, made executable. */
exports.CSP_PRODUCTION = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "media-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');
/**
 * Development: two relaxations, both dev-only.
 *   - `connect-src` allows the Vite HMR websocket;
 *   - `script-src` allows `'unsafe-inline'` because Vite injects the React
 *     Refresh preamble as an inline module script, and without it `npm run dev`
 *     shows a blank window.
 */
exports.CSP_DEVELOPMENT = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws://localhost:5173 http://localhost:5173",
    "object-src 'none'",
    "frame-src 'none'",
    "media-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');
//# sourceMappingURL=csp.js.map