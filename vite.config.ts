/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { CSP_PRODUCTION } from './src/shared/csp';

/**
 * Puts the production policy into the packaged `index.html`.
 *
 * A `file://` load has no response headers, so `onHeadersReceived` in
 * `security.ts` never runs for it and the `<meta>` tag is the only policy that
 * applies. Before this plugin the packaged app shipped the *development* policy,
 * which still allowed `ws://localhost:5173` — harmless in practice, but a
 * permitted socket is not an offline guarantee. `scripts/probe-offline.mjs`
 * fails the run if the packaged document does not say `connect-src 'none'`.
 */
function productionCsp(): Plugin {
  return {
    name: 'nexus-production-csp',
    apply: 'build',
    transformIndexHtml(html: string): string {
      const rewritten = html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/,
        `$1${CSP_PRODUCTION}$2`,
      );
      if (rewritten === html) {
        // A silent no-op here means the meta tag changed shape and the packaged
        // app is back to the development policy.
        throw new Error('nexus-production-csp: the Content-Security-Policy meta tag was not found');
      }
      return rewritten;
    },
  };
}

/**
 * Renderer build. `base: './'` keeps every asset reference relative so the
 * packaged app can be loaded from `file://` (decision D-14).
 */
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react(), productionCsp()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },
});
