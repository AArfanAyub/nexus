/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * T02 acceptance tests for the main-process core.
 *
 * These drive the REAL envelope dispatcher (`dist/main/main/ipc.js`) against a
 * real sql.js database in a temp directory. No Electron GUI is involved: the
 * module imports `electron` only for `ipcMain`/`app`, and neither is touched by
 * `registerChannels()` or `dispatch()`.
 *
 * Covered acceptance criteria:
 *   #7  correct password → {user, permissions[]}; 5 bad attempts lock the
 *       account; the audit log gains exactly one `login_failed` row per attempt
 *   #8  audit.verify() → {ok:true} on a clean log; editing one `after_json`
 *       → {ok:false, brokenAtSeq:n}
 *   #11 a forced constraint violation → {ok:false, error:{code:'CONFLICT'}}
 *
 * Run with `npm test` (which builds `dist/main` first).
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const DIST = path.join(__dirname, '..', 'dist', 'main', 'main');
const { initConnection, conn } = require(path.join(DIST, 'db', 'connection.js'));
const { migrate } = require(path.join(DIST, 'db', 'migrate.js'));
const usersService = require(path.join(DIST, 'services', 'users.js'));
const audit = require(path.join(DIST, 'services', 'audit.js'));
const ipc = require(path.join(DIST, 'ipc.js'));

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-core-'));
const DB_FILE = path.join(WORK_DIR, 'nexus.db');

// `resolveWasmPath()` reads `app.isPackaged`, and there is no Electron `app` in
// a plain Node process, so both paths are injected explicitly.
const WASM_FILE = require.resolve('sql.js/dist/sql-wasm.wasm');

const OWNER = { username: 'owner', fullName: 'Ada Owner', password: 'Nexus!Str0ng-2026' };
const VIEWER = { username: 'viewer1', fullName: 'Vic Viewer', password: 'Quiet!Harbor-92' };
const WRONG_PASSWORD = 'not-the-password';

/** Calls the dispatcher and returns the raw `ApiResult`. */
async function call(channel, payload) {
  return ipc.dispatch(channel, payload);
}

/** Audit row count, read straight from the table. */
function auditCount() {
  const row = conn().one('SELECT COUNT(*) AS total FROM audit_log');
  return Number(row.total);
}

/** User row count, read straight from the table. */
function userCount() {
  const row = conn().one('SELECT COUNT(*) AS total FROM users');
  return Number(row.total);
}

/** Counts `login_failed` rows. */
function failedLoginCount() {
  const row = conn().one("SELECT COUNT(*) AS total FROM audit_log WHERE action = 'login_failed'");
  return Number(row.total);
}

function roleIdByName(name) {
  const role = usersService.listRoles().find((candidate) => candidate.name === name);
  assert.ok(role, `expected the seeded role "${name}" to exist`);
  return role.id;
}

test('T02-01 schema migrates and role presets seed', async () => {
  await initConnection({ wasmPath: WASM_FILE, filePath: DB_FILE });
  ipc.registerChannels();
  const result = migrate();

  assert.equal(result.from, 0);
  // A change detector, not a limit: adding a migration must update this line in
  // the same commit. v5/v6 are the T11 scale proof — the indexes the 300 000-line
  // benchmark asked for, and the posting date on the ledger line itself.
  assert.equal(result.to, 10);
  assert.deepEqual(result.applied, [
    'v1 initial-schema',
    'v2 scale-indexes-archive-cache',
    'v3 inventory-layers-uom-ops-links',
    'v4 crm-lead-status-admin-indexes',
    'v5 scale-covering-indexes',
    'v6 ledger-line-posted-date',
    'v7 archive-balance-rollup',
    'v8 search-nocase-indexes',
    'v9 foreign-key-indexes',
    'v10 currency-catalogue',
  ]);

  const versionRow = conn().one('PRAGMA user_version');
  assert.equal(Number(versionRow.user_version), 10);

  usersService.ensureRolePresets();
  const roles = usersService.listRoles();
  assert.equal(roles.length, 6, 'owner, admin, accountant, sales, warehouse, viewer');

  // Idempotent: calling it again must not duplicate anything.
  usersService.ensureRolePresets();
  assert.equal(usersService.listRoles().length, 6);

  const tables = conn().all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  assert.ok(tables.length >= 48, `expected >= 48 domain tables, saw ${tables.length}`);
});

test('T02-02 the first-run owner can be created with no session', async () => {
  assert.equal(userCount(), 0);

  const created = await call('users.create', {
    ...OWNER,
    roleIds: [roleIdByName('Owner')],
  });

  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.username, 'owner');
  assert.equal(created.data.isOwner, true);
  assert.equal(created.data.isActive, true);
  assert.equal(userCount(), 1);

  // The owner is created audited as `bootstrap_owner`.
  const row = conn().one("SELECT action FROM audit_log WHERE entity = 'user' ORDER BY seq ASC");
  assert.equal(row.action, 'bootstrap_owner');
});

test('T02-03 a second user cannot be created without a session', async () => {
  const denied = await call('users.create', {
    username: 'sneaky',
    fullName: 'Sneaky Person',
    password: 'Tidal!Comet-51',
    roleIds: [roleIdByName('Viewer')],
  });

  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'AUTH_REQUIRED');
  assert.equal(userCount(), 1);
});

test('T02-04 correct password returns {user, permissions[]}', async () => {
  const login = await call('auth.login', {
    username: OWNER.username,
    password: OWNER.password,
  });

  assert.equal(login.ok, true, JSON.stringify(login));
  assert.equal(login.data.user.username, 'owner');
  assert.equal(login.data.user.isOwner, true);
  assert.equal(typeof login.data.sessionId, 'string');
  assert.ok(Array.isArray(login.data.permissions));
  assert.ok(
    login.data.permissions.includes('settings.user.manage'),
    'the owner preset must carry settings.user.manage',
  );
  assert.ok(login.data.permissions.includes('settings.audit.read'));

  const row = conn().one("SELECT action FROM audit_log WHERE action = 'login' ORDER BY seq DESC LIMIT 1");
  assert.equal(row.action, 'login');
});

test('T02-05 each wrong password audits exactly one login_failed row', async () => {
  const before = failedLoginCount();
  let lastDenied = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    lastDenied = await call('auth.login', {
      username: OWNER.username,
      password: WRONG_PASSWORD,
    });
    assert.equal(lastDenied.ok, false, `attempt ${attempt} should fail`);
    assert.equal(lastDenied.error.code, 'AUTH_REQUIRED');
    assert.equal(failedLoginCount(), before + attempt, `audit row missing after attempt ${attempt}`);
  }

  // The message never leaks which half of the credential was wrong.
  assert.match(lastDenied.error.message, /username or password/i);
  assert.equal(lastDenied.error.details, undefined, 'no stack or SQL text on the wire');
});

test('T02-06 five failures lock the account, even for the right password', async () => {
  // Four failures happened in T02-05; the fifth trips the lock.
  const fifth = await call('auth.login', {
    username: OWNER.username,
    password: WRONG_PASSWORD,
  });
  assert.equal(fifth.ok, false);
  assert.equal(fifth.error.code, 'AUTH_REQUIRED');

  const locked = conn().one("SELECT locked_until, failed_attempts FROM users WHERE username = 'owner'");
  assert.ok(locked.locked_until, 'locked_until must be set after maxAttempts');
  assert.equal(Number(locked.failed_attempts), 5);

  const correctButLocked = await call('auth.login', {
    username: OWNER.username,
    password: OWNER.password,
  });
  assert.equal(correctButLocked.ok, false);
  assert.equal(correctButLocked.error.code, 'CONFLICT');
  assert.match(correctButLocked.error.message, /locked/i);

  // A locked attempt is still evidence, not a silent no-op.
  assert.ok(failedLoginCount() >= 6, `expected >= 6 login_failed rows, saw ${failedLoginCount()}`);

  // Clear the lock the way an administrator would, then confirm sign-in works.
  conn().run(
    "UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE username = 'owner'",
  );
  const recovered = await call('auth.login', {
    username: OWNER.username,
    password: OWNER.password,
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
});

test('T02-07 RBAC: a viewer cannot reach a user-management channel', async () => {
  const created = await call('users.create', {
    ...VIEWER,
    roleIds: [roleIdByName('Viewer')],
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  await call('auth.logout', {});
  const viewerLogin = await call('auth.login', {
    username: VIEWER.username,
    password: VIEWER.password,
  });
  assert.equal(viewerLogin.ok, true, JSON.stringify(viewerLogin));
  assert.equal(viewerLogin.data.permissions.includes('settings.user.manage'), false);

  const forbidden = await call('users.create', {
    username: 'another',
    fullName: 'Another Person',
    password: 'Velvet!Anvil-73',
    roleIds: [roleIdByName('Viewer')],
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'FORBIDDEN');

  // The viewer preset is read-everything, so pick a write channel it lacks.
  const roleForbidden = await call('roles.duplicate', {
    id: roleIdByName('Viewer'),
    name: 'Copy of Viewer',
  });
  assert.equal(roleForbidden.ok, false);
  assert.equal(roleForbidden.error.code, 'FORBIDDEN');

  // Read access is genuinely granted: the audit chain is readable by a viewer.
  const auditReadable = await call('audit.verify', {});
  assert.equal(auditReadable.ok, true, JSON.stringify(auditReadable));

  await call('auth.logout', {});
  const ownerAgain = await call('auth.login', {
    username: OWNER.username,
    password: OWNER.password,
  });
  assert.equal(ownerAgain.ok, true);
});

test('T02-08 validation, allow-list and unknown-channel failures', async () => {
  const missingPassword = await call('auth.login', { username: 'owner' });
  assert.equal(missingPassword.ok, false);
  assert.equal(missingPassword.error.code, 'VALIDATION');
  assert.ok(missingPassword.error.details.field, 'VALIDATION names the offending field');

  const tooLong = await call('auth.login', {
    username: 'owner',
    password: 'x'.repeat(400),
  });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error.code, 'VALIDATION');

  const unknown = await call('totally.made.up', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'FORBIDDEN');
  assert.match(unknown.error.message, /not available/i);

  const notAString = await call(undefined, {});
  assert.equal(notAString.ok, false);
  assert.equal(notAString.error.code, 'FORBIDDEN');
});

test('T02-09 a constraint violation comes back as CONFLICT with human text', async () => {
  const duplicateUsername = await call('users.create', {
    username: 'OWNER', // the service lowercases before comparing
    fullName: 'Impostor',
    password: 'Granite!Falcon-38',
    roleIds: [roleIdByName('Viewer')],
  });
  assert.equal(duplicateUsername.ok, false);
  assert.equal(duplicateUsername.error.code, 'CONFLICT');
  assert.match(duplicateUsername.error.message, /already taken/i);
  assert.equal(userCount(), 2, 'the failed insert rolled back');

  const duplicateRole = await call('roles.duplicate', {
    id: roleIdByName('Viewer'),
    name: 'Viewer',
  });
  assert.equal(duplicateRole.ok, false);
  assert.equal(duplicateRole.error.code, 'CONFLICT');
  assert.match(duplicateRole.error.message, /already exists/i);

  // The UNIQUE index really is enforced at the storage layer, which is what
  // makes the dispatcher's "constraint failed" → CONFLICT mapping reachable.
  assert.throws(
    () =>
      conn().run(
        `INSERT INTO roles (id, name, description, is_system, permissions_json, created_at, updated_at)
         VALUES (?, ?, ?, 0, '[]', ?, ?)`,
        [
          '00000000-0000-4000-8000-000000000000',
          'Viewer',
          'raw duplicate',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ],
      ),
    /UNIQUE constraint failed/i,
  );

  const roleCount = conn().one("SELECT COUNT(*) AS total FROM roles WHERE name = 'Viewer'");
  assert.equal(Number(roleCount.total), 1, 'the rejected insert left no row behind');
});

test('T02-10 the audit chain verifies, and tampering is pinpointed', async () => {
  const clean = await call('audit.verify', {});
  assert.equal(clean.ok, true, JSON.stringify(clean));
  assert.equal(clean.data.ok, true);
  assert.equal(clean.data.checked, auditCount());
  assert.ok(clean.data.checked >= 10, `expected a populated chain, saw ${clean.data.checked}`);
  assert.equal(clean.data.brokenAtSeq, undefined);

  const target = conn().one("SELECT seq FROM audit_log WHERE action = 'login' ORDER BY seq ASC LIMIT 1");
  const tamperedSeq = Number(target.seq);

  conn().run("UPDATE audit_log SET after_json = '{\"tampered\":true}' WHERE seq = ?", [tamperedSeq]);

  const broken = await call('audit.verify', {});
  assert.equal(broken.ok, true, 'verify reports tampering in the payload, it does not throw');
  assert.equal(broken.data.ok, false);
  assert.equal(broken.data.brokenAtSeq, tamperedSeq);

  // Direct service call agrees with the channel.
  const direct = audit.verify();
  assert.equal(direct.ok, false);
  assert.equal(direct.brokenAtSeq, tamperedSeq);
});

test('T02-11 no session means AUTH_REQUIRED for protected channels', async () => {
  await call('auth.logout', {});

  const denied = await call('audit.verify', {});
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'AUTH_REQUIRED');

  const rolesDenied = await call('roles.duplicate', {
    id: roleIdByName('Viewer'),
    name: 'Copy of Viewer',
  });
  assert.equal(rolesDenied.ok, false);
  assert.equal(rolesDenied.error.code, 'AUTH_REQUIRED');
});

test('T02-12 flushNow writes a real SQLite file to disk', async () => {
  conn().flushNow();

  assert.ok(fs.existsSync(DB_FILE), 'the database file must exist after flushNow');
  const bytes = fs.readFileSync(DB_FILE);
  assert.ok(bytes.byteLength > 0);
  assert.equal(bytes.subarray(0, 15).toString('utf8'), 'SQLite format 3');
});
