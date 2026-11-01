/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Local password recovery — the way back in when the owner forgets the password.
 *
 * NEXUS is offline and single-machine, so there is no email reset and no server to
 * ask. Whoever holds `%APPDATA%\nexus\nexus.db` already holds every invoice in the
 * business; refusing them a password reset protects nothing and only loses data.
 * What matters is that the reset is **visible**: it writes a hash-chained audit
 * entry, so `audit.verify()` still passes and the change shows in Settings → Audit
 * log rather than happening silently.
 *
 * It drives the real modules with a stubbed `electron.app`, which is how
 * `scripts/perf.mjs` already runs the service layer outside Electron — that keeps
 * the scrypt parameters, the audit hash and the atomic file write identical to the
 * running application instead of re-implemented and subtly different.
 *
 *   node scripts/reset-password.mjs --list
 *   node scripts/reset-password.mjs --username owner --password 'New-Pass-123'
 *   node scripts/reset-password.mjs --username owner            # generates one
 *
 * Development/administration only — never shipped inside the app bundle.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function arg(name, fallback) {
  // Both `--name value` and `--name=value` are accepted: the second is what
  // Windows users type, and silently ignoring it would point this script at the
  // wrong database — the one mistake this tool must never make.
  const prefixed = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  if (prefixed) return prefixed.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const USER_DATA =
  arg('user-data-dir', '') || path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'nexus');

// `connection.ts` asks Electron for `app.getPath('userData')` and `app.isPackaged`.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getPath: () => USER_DATA,
        getAppPath: () => process.cwd(),
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { initConnection, conn, closeConnection } = require('../dist/main/main/db/connection.js');
const auth = require('../dist/main/main/services/auth.js');
const audit = require('../dist/main/main/services/audit.js');

/** A readable password that satisfies the strength policy. */
function generatePassword() {
  const words = ['Quiet', 'Harbor', 'Amber', 'Cedar', 'Willow', 'Copper', 'Silver', 'Orchid'];
  const word = words[randomBytes(1)[0] % words.length];
  const word2 = words[randomBytes(1)[0] % words.length];
  return `${word}-${word2}-${randomBytes(3).toString('hex')}`;
}

const databaseFile = path.join(USER_DATA, 'nexus.db');
if (!fs.existsSync(databaseFile)) {
  process.stderr.write(`No database at ${databaseFile}\nStart NEXUS once, then run this again.\n`);
  process.exit(1);
}

await initConnection();

const users = conn().all('SELECT id, username, full_name, is_active, failed_attempts, locked_until FROM users ORDER BY created_at');

if (flag('list') || users.length === 0) {
  process.stdout.write(`Database: ${databaseFile}\n\n`);
  for (const user of users) {
    process.stdout.write(
      `  ${String(user.username).padEnd(14)} ${String(user.full_name).padEnd(22)} ` +
        `${Number(user.is_active) === 1 ? 'active' : 'disabled'}  ` +
        `failed=${Number(user.failed_attempts)}${user.locked_until ? `  locked until ${user.locked_until}` : ''}\n`,
    );
  }
  process.stdout.write('\nReset one with:  node scripts/reset-password.mjs --username <name>\n');
  closeConnection();
  process.exit(0);
}

const username = String(arg('username', '')).trim();
if (username === '') {
  process.stderr.write('Missing --username. Use --list to see the accounts.\n');
  closeConnection();
  process.exit(1);
}

const user = users.find((row) => String(row.username).toLowerCase() === username.toLowerCase());
if (!user) {
  process.stderr.write(`No account called "${username}". Accounts: ${users.map((row) => row.username).join(', ')}\n`);
  closeConnection();
  process.exit(1);
}

const password = arg('password', '') || generatePassword();
try {
  auth.assertPasswordStrength(password, String(user.username));
} catch (error) {
  process.stderr.write(`That password is not strong enough: ${error instanceof Error ? error.message : String(error)}\n`);
  closeConnection();
  process.exit(1);
}

const hash = auth.hashPassword(password);
const at = new Date().toISOString();

conn().tx(() => {
  conn().run(
    `UPDATE users
        SET password_hash = ?, password_salt = ?, password_algo = ?,
            must_change_password = 0, failed_attempts = 0, locked_until = NULL, updated_at = ?
      WHERE id = ?`,
    [hash.hash, hash.salt, hash.algo, at, user.id],
  );

  // The reset must be as visible as a login. Without this row the audit chain
  // would still verify, but the change would be invisible to the owner.
  audit.append({
    actorId: null,
    actorName: 'local-recovery',
    entity: 'user',
    entityId: String(user.id),
    action: 'password_reset',
    before: null,
    after: { username: user.username, via: 'scripts/reset-password.mjs', at },
  });
});

/*
 * `flushNow()` persists only when the image is flagged dirty — inside the app the
 * IPC dispatcher sets that flag, but a script writing directly must set it itself
 * or the write stays in memory and vanishes with the process. This is the one
 * mistake that would make the tool report success while changing nothing.
 */
conn().markDirty();
conn().flushNow();
const check = audit.verify();
closeConnection();

process.stdout.write(
  [
    '',
    `Password reset for "${user.username}" (${user.full_name}).`,
    '',
    `  new password : ${password}`,
    '',
    `  database     : ${databaseFile}`,
    `  audit chain  : ${check.ok ? 'intact' : `BROKEN at seq ${check.brokenAt}`}`,
    '',
    'Sign in with it, then change it in Settings → People.',
    '',
  ].join('\n'),
);
process.exit(check.ok ? 0 : 2);
