/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';

/**
 * The preload script runs with `sandbox: true`, where Node's `require` is
 * limited to `electron` and a small builtin subset. Therefore the preload
 * (and the `CHANNELS` contract it imports) must be bundled into ONE CommonJS
 * file — that is the only reason this second Vite config exists.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/main/preload', import.meta.url)),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL('./src/preload/index.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['electron'],
      output: {
        format: 'cjs',
        exports: 'none',
      },
    },
  },
});
