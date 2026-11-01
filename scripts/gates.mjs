/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Repository gates (T11 acceptance #8, #10).
 *
 * Four rules that are cheap to check and expensive to violate, because each one
 * is invisible until it is a hundred violations deep:
 *
 *   1. **No hex colours in components.** Every colour is a CSS custom property
 *      defined once in `index.css`, so dark mode cannot be a second palette that
 *      drifts from the first.
 *   2. **No `if (industry`.** Behaviour is chosen by the module registry and the
 *      industry preset's data, never by branching on a company's industry name —
 *      a preset added tomorrow must not need a code change (R7).
 *   3. **A copyright header in every source file.** A file with no header is a
 *      file somebody copied in from somewhere.
 *   4. **No `console.log` in shipped code.** A debug print in the renderer is a
 *      log line a customer can read and a reviewer will miss.
 *
 * Usage:  node scripts/gates.mjs        (exit 0 = all gates pass)
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

const HEADER = 'Copyright (c) 2026 arfanayub0';

/** Every file under `src/` with one of the given extensions. */
function walk(dir, extensions, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, extensions, out);
      continue;
    }
    if (extensions.some((extension) => entry.name.endsWith(extension))) out.push(full);
  }
  return out;
}

const relative = (file) => path.relative(ROOT, file).replaceAll(path.sep, '/');

const failures = [];
const checks = [];

function gate(name, fn) {
  const problems = fn();
  checks.push({ name, problems: problems.length });
  failures.push(...problems.map((problem) => ({ gate: name, ...problem })));
}

/**
 * The only files where a hex literal is legitimate.
 *
 * Both are places a CSS custom property physically cannot reach:
 *   - `index.css` is where the tokens are *defined*, so it is the one file that
 *     must contain literal colours;
 *   - `window.ts` passes `backgroundColor` / `titleBarOverlay` to Electron's
 *     native window chrome before any document exists;
 *   - `pdf/template.ts` prints on white paper, where the dark theme's tokens
 *     would be wrong even if they were reachable.
 * Everything else must reference a token, so dark mode cannot drift.
 */
const ALLOWED_HEX = new Set([
  'src/renderer/index.css',
  'src/main/window.ts',
  'src/main/pdf/template.ts',
]);

// ── 1. no hex literals outside the token files ──────────────────────────────
gate('no hex colours outside tokens', () => {
  const problems = [];
  for (const file of walk(SRC, ['.ts', '.tsx', '.css'])) {
    if (ALLOWED_HEX.has(relative(file))) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      // `#fff` / `#ffffff` / `#ffffffff` — a hex colour, not an id or a fragment.
      if (/#[0-9a-fA-F]{3,8}\b/.test(line) && !/^\s*\*/.test(line)) {
        problems.push({ file: relative(file), line: index + 1, detail: line.trim().slice(0, 100) });
      }
    });
  }
  return problems;
});

// ── 2. no branching on the industry preset ──────────────────────────────────
gate('no `if (industry`', () => {
  const problems = [];
  for (const file of walk(SRC, ['.ts', '.tsx'])) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/if\s*\(\s*(?:[A-Za-z_$][\w$]*\.)?industry\b/.test(line) && !/^\s*(\*|\/\/)/.test(line)) {
        problems.push({ file: relative(file), line: index + 1, detail: line.trim().slice(0, 100) });
      }
    });
  }
  return problems;
});

// ── 3. copyright header ─────────────────────────────────────────────────────
gate('copyright header', () => {
  const problems = [];
  for (const file of walk(SRC, ['.ts', '.tsx', '.css'])) {
    const head = fs.readFileSync(file, 'utf8').slice(0, 400);
    if (!head.includes(HEADER)) problems.push({ file: relative(file), line: 1, detail: 'missing header' });
  }
  return problems;
});

// ── 4. no console.log in shipped code ───────────────────────────────────────
gate('no console.log', () => {
  const problems = [];
  for (const file of walk(SRC, ['.ts', '.tsx'])) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      // `console.log(` — not `console.info`/`error`, which the log module owns,
      // and not a mention inside a comment.
      if (/\bconsole\.log\s*\(/.test(line) && !/^\s*(\*|\/\/)/.test(line)) {
        problems.push({ file: relative(file), line: index + 1, detail: line.trim().slice(0, 100) });
      }
    });
  }
  return problems;
});

// ── report ──────────────────────────────────────────────────────────────────
for (const check of checks) {
  const status = check.problems === 0 ? 'PASS' : `FAIL (${String(check.problems)})`;
  console.log(`  ${status.padEnd(12)} ${check.name}`);
}

if (failures.length > 0) {
  console.error('');
  for (const failure of failures.slice(0, 60)) {
    console.error(`  ${failure.gate}: ${failure.file}:${String(failure.line)}  ${failure.detail}`);
  }
  if (failures.length > 60) console.error(`  … and ${String(failures.length - 60)} more`);
  console.error(`\nGATES FAILED — ${String(failures.length)} problem(s)`);
  process.exitCode = 1;
} else {
  console.log(`\nGATES PASSED — ${String(checks.length)} checks`);
}
