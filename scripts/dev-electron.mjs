/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Launches Electron for `npm run dev` with the Vite dev-server URL in the
 * environment. A tiny script instead of `cross-env` keeps the devDependency
 * list inside the approved set (no extra package, works on Windows and POSIX).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: 'http://localhost:5173', NODE_ENV: 'development' },
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});
