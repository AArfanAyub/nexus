/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * QA probe for the Settings tab-routing bugfix (T11-4 regression).
 *
 * Deliberately adversarial and independent of `probe-all.mjs`, which only asks
 * "is the page not blank". This asks the three questions that bug actually
 * failed:
 *
 *   1. does a *direct* navigation to each of the 12 settings routes render that
 *      route's own heading, in a random order and in reverse? A `useState(tab)`
 *      seed passes one direction and fails the other, so both are run.
 *   2. does Back after a tab click restore the previous tab and its hash?
 *   3. does `/settings/roles` render a permission matrix with labels instead of
 *      React error #31?
 *
 * It also drives the three "don't work" panels end to end (taxes, custom
 * fields, currencies) because a panel that renders but cannot save is broken.
 *
 *   node scripts/qa-settings.mjs --port 9270 --login owner:Quiet-Harbor-92x
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const PORT = Number(arg('port', '9270'));
const LOGIN = arg('login', '');
const OUT = arg('out', 'tmp/qa-settings');
const SETTLE = Number(arg('settle', '900'));

/** route → the tab label the page must show. This is the contract under test. */
const SETTINGS = [
  ['/settings/numbering', 'Numbering'],
  ['/settings/taxes', 'Tax rates'],
  ['/settings/currencies', 'Currencies'],
  ['/settings/custom-fields', 'Custom fields'],
  ['/settings/import', 'Import'],
  ['/settings/users', 'Users'],
  ['/settings/roles', 'Roles'],
  ['/settings/license', 'Licence'],
  ['/settings/audit-log', 'Audit log'],
  ['/settings/backup', 'Backup'],
  ['/settings/security', 'Security'],
  ['/settings/appearance', 'Appearance'],
];

const expectedHeadings = new Map(SETTINGS);

fs.mkdirSync(OUT, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page =
  targets.find((target) => target.type === 'page' && target.url.includes('index.html')) ??
  targets.find((target) => target.type === 'page');
if (!page) {
  console.error('NO PAGE TARGET');
  process.exit(2);
}

let ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const consoleErrors = [];
const exceptions = [];

function onMessage(event) {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((entry) => entry.value ?? entry.description ?? '').join(' '));
  }
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(
      message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text,
    );
  }
}

ws.addEventListener('message', onMessage);

await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

const send = (method, params = {}) => {
  seq += 1;
  const id = seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `Page.reload` destroys the execution context, and CDP then never answers the
 * in-flight `Runtime.evaluate` — the promise hangs rather than rejecting. Every
 * call is therefore bounded, and a timeout is treated as "the context went away"
 * so the caller can re-attach instead of the whole probe wedging.
 */
async function evaluate(expression, timeoutMs = 12_000) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('CDP_EVALUATE_TIMEOUT')), timeoutMs);
  });
  try {
    const result = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      timeout,
    ]);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  } finally {
    clearTimeout(timer);
  }
}

/** Re-attach after a reload replaced the page target. */
async function attach() {
  try {
    ws.close();
  } catch {
    /* already gone */
  }
  pending.clear();
  const fresh = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target =
    fresh.find((entry) => entry.type === 'page' && entry.url.includes('index.html')) ??
    fresh.find((entry) => entry.type === 'page');
  if (!target) throw new Error('NO PAGE TARGET AFTER RELOAD');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('message', onMessage);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  await send('Runtime.enable');
  await send('Page.enable');
}

await send('Runtime.enable');
await send('Page.enable');

const drain = () => {
  const all = [...exceptions, ...consoleErrors];
  exceptions.length = 0;
  consoleErrors.length = 0;
  return all;
};

// ── sign in ──────────────────────────────────────────────────────────────────

if (LOGIN) {
  const [username, password] = LOGIN.split(':');
  await evaluate(`(async () => {
    const set = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    location.hash = '#/login';
    await new Promise((r) => setTimeout(r, 900));
    const inputs = [...document.querySelectorAll('input')];
    if (inputs.length >= 2) {
      set(inputs[0], ${JSON.stringify(username)});
      set(inputs[1], ${JSON.stringify(password)});
      await new Promise((r) => setTimeout(r, 150));
      document.querySelector('form')?.requestSubmit();
    }
    return 'ok';
  })()`);
  await sleep(2600);
}

const signedIn = await evaluate(`Boolean(location.hash && location.hash !== '#/login')`);
drain();

// ── item 1: direct navigation, random order then reverse ─────────────────────

async function visit(route) {
  exceptions.length = 0;
  consoleErrors.length = 0;
  await evaluate(`location.hash = ${JSON.stringify(`#${route}`)}`);
  await sleep(SETTLE);
  const state = await evaluate(`(() => {
    const main = document.querySelector('main');
    return {
      hash: location.hash,
      heading: (document.querySelector('h1')?.textContent ?? '').trim(),
      chars: (main?.innerText ?? '').trim().length,
      objectChild: /\\[object Object\\]/.test(main?.innerText ?? ''),
      selectedTab: [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map((el) => el.textContent.trim()),
    };
  })()`);
  return { route, ...state, errors: drain() };
}

/** Deterministic shuffle so a failure is reproducible from the log. */
function shuffled(list, seed) {
  const copy = [...list];
  let state = seed;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const swap = state % (index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

const forwardOrder = shuffled(SETTINGS, 20261101);
const reverseOrder = [...forwardOrder].reverse();

const forward = [];
for (const [route] of forwardOrder) forward.push(await visit(route));

const backward = [];
for (const [route] of reverseOrder) backward.push(await visit(route));

// ── item 1b: a true cold-start deep link (reload with the hash already set) ───

const coldStart = [];
for (const [route] of shuffled(SETTINGS, 7717)) {
  try {
    await evaluate(`location.hash = ${JSON.stringify(`#${route}`)}`);
    await Promise.race([send('Page.reload', { ignoreCache: false }), sleep(4000)]);
  } catch {
    /* the reload tears the execution context down; that is the point */
  }
  await sleep(3600);
  exceptions.length = 0;
  consoleErrors.length = 0;
  const readState = () =>
    evaluate(
      `(() => ({
        hash: location.hash,
        heading: (document.querySelector('h1')?.textContent ?? '').trim(),
        chars: (document.querySelector('main')?.innerText ?? '').trim().length,
      }))()`,
      8000,
    );
  let state;
  try {
    state = await readState();
  } catch {
    await attach();
    await sleep(1200);
    state = await readState();
  }
  coldStart.push({ route, ...state, errors: drain() });
}

// ── item 2: back / forward through tabs ─────────────────────────────────────

/**
 * Tab label and page heading are deliberately not the same string: the tab for
 * `/settings/taxes` says "Taxes" but its heading says "Tax rates". Asserting the
 * tab label against the heading produced a false failure on the first run, so
 * the expected heading is looked up from SETTINGS instead.
 */
const headingFor = (slug) => expectedHeadings.get(`/settings/${slug}`);

const PAIRS = [
  [['taxes', 'Taxes'], ['currencies', 'Currencies']],
  [['users', 'Users'], ['roles', 'Roles']],
  [['license', 'Licence'], ['audit-log', 'Audit log']],
  [['backup', 'Backup'], ['security', 'Security']],
];

const clickTab = async (label) =>
  evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent.trim() === ${JSON.stringify(label)});
    if (!tab) return 'NO_TAB';
    tab.click();
    return 'clicked';
  })()`);

const backForward = [];
for (const [[routeA, labelA], [routeB, labelB]] of PAIRS) {
  const expectA = headingFor(routeA);
  const expectB = headingFor(routeB);
  await evaluate(`location.hash = ${JSON.stringify(`#/settings/${routeA}`)}`);
  await sleep(SETTLE);
  const startHeading = await evaluate(`(document.querySelector('h1')?.textContent ?? '').trim()`);
  const clickedB = await clickTab(labelB);
  await sleep(SETTLE);
  const afterB = await evaluate(`(document.querySelector('h1')?.textContent ?? '').trim()`);
  const hashB = await evaluate('location.hash');
  await evaluate('history.back()');
  await sleep(SETTLE);
  const afterBack = await evaluate(`(document.querySelector('h1')?.textContent ?? '').trim()`);
  const hashBack = await evaluate('location.hash');
  await evaluate('history.forward()');
  await sleep(SETTLE);
  const afterForward = await evaluate(`(document.querySelector('h1')?.textContent ?? '').trim()`);
  backForward.push({
    pair: `${routeA} <-> ${routeB}`,
    expectA,
    expectB,
    tabLabels: `${labelA}/${labelB}`,
    startHeading,
    clickedB,
    afterB,
    hashB,
    afterBack,
    hashBack,
    afterForward,
    errors: drain(),
  });
}

// ── item 3: the roles panel specifically ────────────────────────────────────

await evaluate(`location.hash = '#/settings/roles'`);
await sleep(1800);
const rolesProbe = await evaluate(`(async () => {
  const main = document.querySelector('main');
  const text = main?.innerText ?? '';
  const checkboxes = [...document.querySelectorAll('main input[type="checkbox"]')];
  const roleButtons = [...document.querySelectorAll('main ul button')];
  const firstLabel = checkboxes.length > 0 ? checkboxes[0].closest('label')?.innerText ?? '' : '';
  const before = roleButtons.map((b) => b.getAttribute('aria-current'));
  // Click the second role, if there is one, and see whether it becomes selected.
  if (roleButtons.length > 1) {
    roleButtons[1].click();
    await new Promise((r) => setTimeout(r, 500));
  }
  const after = [...document.querySelectorAll('main ul button')].map((b) => b.getAttribute('aria-current'));
  return {
    hash: location.hash,
    heading: (document.querySelector('h1')?.textContent ?? '').trim(),
    chars: text.trim().length,
    checkboxCount: checkboxes.length,
    roleCount: roleButtons.length,
    roleNames: roleButtons.map((b) => b.innerText.trim()),
    objectObject: /\\[object Object\\]/.test(text),
    firstPermissionLabel: firstLabel.split('\\n')[0],
    react31: /Minified React error #31|Objects are not valid as a React child/i.test(text),
    ariaCurrentBefore: before,
    ariaCurrentAfter: after,
  };
})()`);
rolesProbe.errors = drain();

// ── item 4: real user paths ─────────────────────────────────────────────────

const fill = async (selectorExpression, value) =>
  evaluate(`(() => {
    const el = ${selectorExpression};
    if (!el) return 'MISSING';
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);

const clickButtonByText = async (text, scope = 'document') =>
  evaluate(`(() => {
    const root = ${scope === 'document' ? 'document' : `document.querySelector(${JSON.stringify(scope)})`};
    if (!root) return 'NO_ROOT';
    const button = [...root.querySelectorAll('button')].find((el) => el.textContent.trim() === ${JSON.stringify(text)});
    if (!button) return 'NO_BUTTON';
    if (button.disabled) return 'DISABLED';
    button.click();
    return 'clicked';
  })()`);

const modalText = () =>
  evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog ? dialog.innerText.slice(0, 400) : 'NO_DIALOG';
  })()`);

const userPaths = {};

// — taxes: Add rate → fill → save → row appears
await evaluate(`location.hash = '#/settings/taxes'`);
await sleep(1500);
const stamp = Date.now().toString().slice(-6);
const taxName = `QA VAT ${stamp}`;
userPaths.taxes = { name: taxName, steps: [] };
userPaths.taxes.steps.push(['open', await clickButtonByText('Add rate')]);
await sleep(700);
userPaths.taxes.steps.push(['dialog', await modalText()]);
userPaths.taxes.steps.push([
  'fillName',
  await fill(`document.querySelector('[role="dialog"] input')`, taxName),
]);
userPaths.taxes.steps.push([
  'fillRate',
  await fill(`document.querySelectorAll('[role="dialog"] input')[1]`, '7.5'),
]);
await sleep(200);
userPaths.taxes.steps.push(['save', await clickButtonByText('Add rate', '[role="dialog"]')]);
await sleep(2200);
userPaths.taxes.tableContains = await evaluate(
  `(document.querySelector('main')?.innerText ?? '').includes(${JSON.stringify(taxName)})`,
);
userPaths.taxes.rateShown = await evaluate(
  `(() => {
    const row = [...document.querySelectorAll('main tbody tr')].find((tr) => tr.innerText.includes(${JSON.stringify(taxName)}));
    return row ? row.innerText.replace(/\\s+/g, ' ').trim() : 'NO_ROW';
  })()`,
);
userPaths.taxes.errors = drain();

// — custom fields: Add field → fill → save → row appears
await evaluate(`location.hash = '#/settings/custom-fields'`);
await sleep(1500);
const fieldKey = `QAKEY${stamp}`;
userPaths.fields = { key: fieldKey, steps: [] };
userPaths.fields.steps.push(['open', await clickButtonByText('Add field')]);
await sleep(700);
userPaths.fields.steps.push([
  'fillKey',
  await fill(`document.querySelectorAll('[role="dialog"] input')[0]`, fieldKey),
]);
userPaths.fields.steps.push([
  'fillLabel',
  await fill(`document.querySelectorAll('[role="dialog"] input')[1]`, `QA label ${stamp}`),
]);
await sleep(200);
userPaths.fields.steps.push(['save', await clickButtonByText('Add field', '[role="dialog"]')]);
await sleep(2200);
userPaths.fields.tableContains = await evaluate(
  `(document.querySelector('main')?.innerText ?? '').includes(${JSON.stringify(fieldKey)})`,
);
userPaths.fields.errors = drain();

// — currencies: is there any way to add one at all?
await evaluate(`location.hash = '#/settings/currencies'`);
await sleep(1500);
userPaths.currencies = await evaluate(`(() => {
  const main = document.querySelector('main');
  const buttons = [...(main?.querySelectorAll('button') ?? [])].map((el) => el.textContent.trim());
  return {
    buttons,
    hasAddAffordance: buttons.some((label) => /add|new|create/i.test(label)),
    rowCount: (main?.querySelectorAll('tbody tr') ?? []).length,
    chars: (main?.innerText ?? '').trim().length,
  };
})()`);
userPaths.currencies.errors = drain();

/**
 * The UI has no "add currency" affordance. Before calling that a defect, prove
 * the backend *can* do it — otherwise the finding is "unsupported" rather than
 * "unreachable from the screen", and those are different bug reports.
 */
userPaths.currencyBackend = await evaluate(`(async () => {
  const call = async (channel, payload) => {
    const envelope = await window.nexus.invoke(channel, payload);
    if (!envelope?.ok) throw new Error(envelope?.error?.message ?? 'IPC refused');
    return envelope.data;
  };
  try {
    const saved = await call('entity.save', {
      entity: 'currencies',
      values: { code: 'QAX', name: 'QA probe currency', symbol: 'Q', decimals: 2, rate_bp: 12345, is_base: 0 },
    });
    const page = await call('entity.list', { entity: 'currencies', limit: 100 });
    return {
      saved: true,
      id: saved?.id ?? null,
      visible: Array.isArray(page?.rows) && page.rows.some((row) => row.code === 'QAX'),
      rowCount: Array.isArray(page?.rows) ? page.rows.length : null,
    };
  } catch (caught) {
    return { saved: false, message: caught?.message ?? String(caught) };
  }
})()`);

// Re-read the two rows we created through the UI, straight from the database.
userPaths.persisted = await evaluate(`(async () => {
  const call = async (channel, payload) => {
    const envelope = await window.nexus.invoke(channel, payload);
    if (!envelope?.ok) throw new Error(envelope?.error?.message ?? 'IPC refused');
    return envelope.data;
  };
  const taxes = await call('entity.list', { entity: 'taxes', limit: 100 });
  const fields = await call('entity.list', { entity: 'customFields', limit: 100 });
  const taxRows = Array.isArray(taxes?.rows) ? taxes.rows : [];
  const fieldRows = Array.isArray(fields?.rows) ? fields.rows : [];
  return {
    taxTotal: taxes?.total ?? null,
    taxRow: taxRows.find((row) => row.name === ${JSON.stringify(taxName)}) ?? null,
    fieldRow: fieldRows.find((row) => row.key === ${JSON.stringify(fieldKey)}) ?? null,
  };
})()`);

// ── report ──────────────────────────────────────────────────────────────────

const expected = new Map(SETTINGS);
const check = (rows) =>
  rows.map((row) => ({
    route: row.route,
    expected: expected.get(row.route),
    heading: row.heading,
    ok: row.heading === expected.get(row.route) && row.errors.length === 0 && !row.objectChild,
    hash: row.hash,
    chars: row.chars,
    errors: row.errors,
  }));

const results = {
  signedIn,
  forward: check(forward),
  backward: check(backward),
  coldStart: check(coldStart),
  backForward,
  rolesProbe,
  userPaths,
};

fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));

const line = (label, ok, detail = '') =>
  `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`;

process.stdout.write('\n=== ITEM 1: direct navigation, random order ===\n');
for (const row of results.forward) {
  process.stdout.write(`${line(row.route, row.ok, `h1="${row.heading}" hash="${row.hash}"`)}\n`);
  for (const error of row.errors) process.stdout.write(`        ! ${String(error).slice(0, 200)}\n`);
}

process.stdout.write('\n=== ITEM 1: direct navigation, reverse order ===\n');
for (const row of results.backward) {
  process.stdout.write(`${line(row.route, row.ok, `h1="${row.heading}" hash="${row.hash}"`)}\n`);
  for (const error of row.errors) process.stdout.write(`        ! ${String(error).slice(0, 200)}\n`);
}

process.stdout.write('\n=== ITEM 1b: cold-start deep link (reload with hash set) ===\n');
for (const row of results.coldStart) {
  process.stdout.write(`${line(row.route, row.ok, `h1="${row.heading}" hash="${row.hash}"`)}\n`);
  for (const error of row.errors) process.stdout.write(`        ! ${String(error).slice(0, 200)}\n`);
}

process.stdout.write('\n=== ITEM 2: tab click + Back + Forward ===\n');
for (const row of results.backForward) {
  const ok =
    row.afterB === row.expectB &&
    row.afterBack === row.expectA &&
    row.hashBack === `#/settings/${row.pair.split(' <-> ')[0]}` &&
    row.afterForward === row.expectB;
  process.stdout.write(
    `${line(row.pair, ok, `B="${row.afterB}" back="${row.afterBack}"(${row.hashBack}) fwd="${row.afterForward}"`)}${
      row.clickedB === 'NO_TAB' ? '  [TAB NOT FOUND]' : ''
    }\n`,
  );
  for (const error of row.errors) process.stdout.write(`        ! ${String(error).slice(0, 200)}\n`);
}

process.stdout.write('\n=== ITEM 3: roles panel ===\n');
const rolesOk =
  results.rolesProbe.heading === 'Roles' &&
  results.rolesProbe.checkboxCount > 0 &&
  !results.rolesProbe.objectObject &&
  !results.rolesProbe.react31 &&
  results.rolesProbe.ariaCurrentAfter.filter((value) => value === 'true').length === 1;
process.stdout.write(
  `${line('/settings/roles', rolesOk, `h1="${results.rolesProbe.heading}" perms=${results.rolesProbe.checkboxCount} roles=${results.rolesProbe.roleCount} [object Object]=${results.rolesProbe.objectObject}`)}\n`,
);
process.stdout.write(`      first permission label: "${results.rolesProbe.firstPermissionLabel}"\n`);
process.stdout.write(`      aria-current before=${JSON.stringify(results.rolesProbe.ariaCurrentBefore)}\n`);
process.stdout.write(`      aria-current after =${JSON.stringify(results.rolesProbe.ariaCurrentAfter)}\n`);
for (const error of results.rolesProbe.errors ?? []) process.stdout.write(`        ! ${String(error).slice(0, 200)}\n`);

process.stdout.write('\n=== ITEM 4: real user paths ===\n');
process.stdout.write(
  `${line('taxes: add rate persisted to table', Boolean(results.userPaths.taxes.tableContains), `row="${results.userPaths.taxes.rateShown}"`)}\n`,
);
for (const [step, value] of results.userPaths.taxes.steps) process.stdout.write(`      ${step}: ${String(value).slice(0, 90)}\n`);
for (const error of results.userPaths.taxes.errors) process.stdout.write(`        ! ${String(error).slice(0, 200)}\n`);
process.stdout.write(
  `${line('custom fields: add field persisted to table', Boolean(results.userPaths.fields.tableContains))}\n`,
);
for (const [step, value] of results.userPaths.fields.steps) process.stdout.write(`      ${step}: ${String(value).slice(0, 90)}\n`);
for (const error of results.userPaths.fields.errors) process.stdout.write(`        ! ${String(error).slice(0, 200)}\n`);
process.stdout.write(
  `${line('currencies: add affordance exists', Boolean(results.userPaths.currencies.hasAddAffordance), `buttons=${JSON.stringify(results.userPaths.currencies.buttons)}`)}\n`,
);
process.stdout.write(
  `      backend entity.save(currencies): ${JSON.stringify(results.userPaths.currencyBackend)}\n`,
);
process.stdout.write(
  `      DB tax row:   ${JSON.stringify(results.userPaths.persisted?.taxRow ?? null)}\n`,
);
process.stdout.write(
  `      DB field row: ${JSON.stringify(results.userPaths.persisted?.fieldRow ?? null)}\n`,
);

const failures = [
  ...results.forward,
  ...results.backward,
  ...results.coldStart,
].filter((row) => !row.ok);
const backFailures = results.backForward.filter(
  (row) => row.afterBack !== row.expectA || row.afterForward !== row.expectB,
);

process.stdout.write(
  `\nSUMMARY heading=${failures.length} backfail=${backFailures.length} roles=${rolesOk ? 'ok' : 'BROKEN'} ` +
    `taxes=${results.userPaths.taxes.tableContains ? 'ok' : 'FAIL'} ` +
    `fields=${results.userPaths.fields.tableContains ? 'ok' : 'FAIL'} ` +
    `currencies=${results.userPaths.currencies.hasAddAffordance ? 'ok' : 'NO-ADD-UI'}\n`,
);

ws.close();
process.exit(0);
