/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Permission and module gates, over the real UI (development only).
 *
 * `node scripts/probe-roles.mjs --port 9280`
 *
 * Rendering a page as the owner proves nothing about the two guards that decide
 * whether someone else may see it at all:
 *
 *   1. **RBAC** — a viewer who types `/settings/users` must land on the
 *      permission panel, not on the page. The main process refuses the channels
 *      too (BR-20); this checks the *UI* half, which is what a user sees.
 *   2. **Module preset** — a company whose preset does not stock goods must not
 *      reach `/inventory/stock`. The route table marks the module disabled and
 *      the shell redirects to the dashboard.
 *
 * It signs in as the owner, creates a viewer account through the same channels
 * the UI uses, then signs in as that viewer. Everything it creates is a fresh
 * user in whatever database the app was launched against — run it against a
 * throwaway `--user-data-dir`.
 */

import process from 'node:process';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const PORT = Number(arg('port', '9280'));
const OWNER = arg('login', 'owner:Quiet-Harbor-92x');
const VIEWER = { username: 'viewer-check', password: 'Quiet-Harbor-92x', fullName: 'Viewer Check' };
const SETTLE = Number(arg('settle', '900'));

/**
 * Two different promises, two different checks.
 *
 * The Viewer preset is `readOnly()` — every permission ending in `.read` or
 * `.use` — so it is *meant* to open Users, Roles, Company and the Audit log.
 * What it must not do is see the manage-only screens, and it must not be offered
 * a single mutating control on the ones it can see. Asserting "a viewer is
 * blocked everywhere" would be wrong, and asserting only that it is blocked on
 * some routes would miss the buttons.
 */
const MANAGE_ONLY = ['#/settings/security', '#/settings/backup'];
const READ_ONLY_VISIBLE = [
  '#/settings/users',
  '#/settings/roles',
  '#/settings/company',
  '#/settings/audit-log',
];

/** Buttons that would change something. None may appear for a viewer. */
const MUTATING = /invite|create|add |new |save|delete|remove|activate|restore|run backup|duplicate/i;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) {
  console.error('no page target');
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const exceptions = [];

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  }
});

await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result?.result?.value;
};

await send('Runtime.enable');

const heading = () => evaluate("document.querySelector('h1')?.textContent ?? ''");
const hash = () => evaluate('location.hash');

async function signIn(username, password) {
  await evaluate('location.hash = "#/login"');
  await wait(SETTLE);
  await evaluate(`(() => {
    const set = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const user = document.querySelector('input[name="username"], input#username')
      ?? [...document.querySelectorAll('input')].find((el) => el.type === 'text');
    const pass = document.querySelector('input[type="password"]');
    if (!user || !pass) return false;
    set(user, ${JSON.stringify(username)});
    set(pass, ${JSON.stringify(password)});
    [...document.querySelectorAll('button')].find((b) => /sign in|log in/i.test(b.textContent || ''))?.click();
    return true;
  })()`);
  await wait(SETTLE + 600);
  return hash();
}

const problems = [];
const results = [];

// ── 1. create a viewer as the owner ─────────────────────────────────────────
// Start from a known signed-out state: a previous run may have left the viewer
// signed in, in which case `#/login` would simply redirect and the form fill
// would be a no-op.
await evaluate(`window.nexus.invoke('auth.logout', {})`).catch(() => undefined);
await wait(300);
await evaluate('location.reload()');
await wait(2500);

const ownerHash = await signIn(...OWNER.split(':'));
if (ownerHash.startsWith('#/login')) {
  console.error(`could not sign in as ${OWNER.split(':')[0]} — check the password`);
  process.exit(1);
}

// `window.nexus.invoke` resolves to the transport envelope `{ok, data}`; the
// renderer's own helper unwraps it, a raw CDP call has to do it here.
const viewerRole = await evaluate(`(async () => {
  const envelope = await window.nexus.invoke('entity.list', { entity: 'roles', limit: 100 });
  const page = envelope?.data ?? envelope;
  const rows = page?.rows ?? [];
  const role = rows.find((row) => row.name === 'Viewer') ?? rows.find((row) => /viewer/i.test(row.name));
  return role ? role.id : '';
})()`);

if (viewerRole === '') {
  console.error('no Viewer role in this database — run this against a freshly onboarded profile');
  process.exit(1);
}

const created = await evaluate(`(async () => {
  try {
    const envelope = await window.nexus.invoke('users.create', {
      username: ${JSON.stringify(VIEWER.username)},
      fullName: ${JSON.stringify(VIEWER.fullName)},
      password: ${JSON.stringify(VIEWER.password)},
      roleIds: [${JSON.stringify(viewerRole)}],
    });
    return { ok: true, id: envelope?.data?.id ?? 'created' };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
})()`);

if (!created.ok && !/already exists|unique/i.test(created.message ?? '')) {
  console.error(`could not create the viewer: ${created.message}`);
  process.exit(1);
}

// ── 2. sign in as the viewer and try every admin route ──────────────────────
// The channel drops the session in the main process; the renderer only learns
// that by re-bootstrapping, which is what the Sign out button does. Calling the
// channel alone would leave stale React state behind and every later assertion
// would be measuring that, not the guard.
await evaluate(`window.nexus.invoke('auth.logout', {})`).catch(() => undefined);
await wait(400);
await evaluate('location.reload()');
await wait(2500);
await signIn(VIEWER.username, VIEWER.password);

const viewerHash = await hash();
results.push({ check: 'viewer signs in', detail: viewerHash });
if (!viewerHash.startsWith('#/dashboard')) {
  problems.push(`a viewer did not land on the dashboard (${viewerHash})`);
}

for (const route of MANAGE_ONLY) {
  await evaluate(`location.hash = ${JSON.stringify(route)}`);
  await wait(SETTLE);
  const title = await heading();
  const refused = /do not have access/i.test(title);
  results.push({ check: `viewer → ${route}`, detail: `"${title}" ${refused ? '(refused)' : '(REACHED)'}` });
  if (!refused) problems.push(`a viewer was not refused ${route} — the permission gate did not fire`);
}

for (const route of READ_ONLY_VISIBLE) {
  await evaluate(`location.hash = ${JSON.stringify(route)}`);
  await wait(SETTLE);
  const title = await heading();
  const buttons = await evaluate(`[...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean)`);
  // The button labels come back as a plain array, so the filter runs here.
  const offered = buttons.filter((label) => MUTATING.test(label));
  results.push({
    check: `viewer → ${route}`,
    detail: `"${title}" · ${String(buttons.length)} buttons, ${String(offered.length)} mutating`,
  });
  if (offered.length > 0) problems.push(`a viewer was offered "${offered[0]}" on ${route}`);
}

// ── 3. the module gate follows the preset, not the role ────────────────────
// The bootstrap payload carries the enabled modules, so the check is "a route
// whose module is not enabled renders the disabled panel", whatever the preset.
const modules = await evaluate(`(async () => {
  const envelope = await window.nexus.invoke('app.bootstrap', {});
  const data = envelope?.data ?? envelope;
  return JSON.stringify((data?.modules ?? []).map((module) => module.id));
})()`);
results.push({ check: 'enabled modules', detail: modules });

const disabledRoute = await evaluate(`(async () => {
  const envelope = await window.nexus.invoke('app.bootstrap', {});
  const data = envelope?.data ?? envelope;
  const enabled = new Set((data?.modules ?? []).map((module) => module.id));
  const candidates = [
    ['inventory', '#/inventory/stock'],
    ['crm', '#/crm/deals'],
    ['purchasing', '#/purchasing/orders'],
  ];
  const missing = candidates.find(([id]) => !enabled.has(id));
  return missing ? missing[1] : '';
})()`);

if (disabledRoute === '') {
  results.push({ check: 'module gate', detail: 'every module is enabled for this preset — nothing to disable' });
} else {
  await evaluate(`location.hash = ${JSON.stringify(disabledRoute)}`);
  await wait(SETTLE);
  const title = await heading();
  const text = await evaluate("document.body.innerText.slice(0, 400)");
  const shownDisabled = /not (available|included|enabled)|module/i.test(text);
  results.push({
    check: `module disabled → ${disabledRoute}`,
    detail: `"${title}" ${shownDisabled ? '(disabled panel)' : '(RENDERED ANYWAY)'}`,
  });
  if (!shownDisabled) problems.push(`${disabledRoute} rendered although its module is not enabled`);
}

socket.close();

console.log('');
for (const row of results) console.log(`  ${row.check.padEnd(34)} ${row.detail}`);
if (exceptions.length > 0) {
  console.log(`\n  ${String(exceptions.length)} uncaught exception(s):`);
  for (const entry of exceptions.slice(0, 3)) console.log(`    ${entry.split('\n')[0]}`);
}

if (problems.length > 0) {
  console.error(`\nFAIL — ${String(problems.length)} problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS — ${String(results.length)} checks: manage-only screens refused, no mutating control offered`);
}
