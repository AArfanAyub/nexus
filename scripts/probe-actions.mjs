/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Development-only: press the primary button on every screen and report what
 * happened.
 *
 * Rendering a panel proves nothing about whether it works — a "Add rate" button
 * that opens nothing still renders. This walks the app, clicks the first
 * create-style button on each page, and records whether a dialog appeared, which
 * console errors were raised, and what toast the user would have seen.
 *
 *   node scripts/probe-actions.mjs --port 9251 --login owner:pass
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const PORT = Number(arg('port', '9251'));
const LOGIN = arg('login', '');
const OUT = arg('out', 'tmp/actions');
const SETTLE = Number(arg('settle', '900'));

const ROUTES = [
  '/dashboard',
  '/finance/invoices',
  '/finance/bills',
  '/finance/payments',
  '/finance/journal-entries',
  '/finance/accounts',
  '/finance/periods',
  '/inventory/products',
  '/inventory/stock',
  '/inventory/warehouses',
  '/purchasing/vendors',
  '/purchasing/orders',
  '/purchasing/receipts',
  '/sales/customers',
  '/sales/quotations',
  '/sales/orders',
  '/sales/price-lists',
  '/crm/deals',
  '/crm/accounts',
  '/crm/leads',
  '/crm/activities',
  '/settings/company',
  '/settings/users',
  '/settings/roles',
  '/settings/custom-fields',
  '/settings/numbering',
  '/settings/taxes',
  '/settings/currencies',
  '/settings/import',
  '/settings/license',
  '/settings/audit-log',
  '/settings/backup',
  '/settings/security',
  '/settings/appearance',
];

fs.mkdirSync(OUT, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page =
  targets.find((target) => target.type === 'page' && target.url.includes('index.html')) ??
  targets.find((target) => target.type === 'page');
if (!page) {
  console.error('no page target');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const consoleErrors = [];

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  }
});

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
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) return { __error: result.exceptionDetails.text };
  return result.result?.value;
};

await send('Runtime.enable');

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
  await sleep(2200);
}

const rows = [];
for (const route of ROUTES) {
  consoleErrors.length = 0;
  await evaluate(`location.hash = ${JSON.stringify(`#${route}`)}`);
  await sleep(SETTLE);

  const before = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean);
    return { buttons, dialogs: document.querySelectorAll('[role="dialog"]').length };
  })()`);

  // The first create-style button: "New invoice", "Add rate", "+ New move", "Invite".
  const target = await evaluate(`(() => {
    const wanted = /^(new\\b|add\\b|invite\\b|create\\b|\\+\\s)/i;
    const button = [...document.querySelectorAll('button')].find(
      (b) => wanted.test(b.textContent.trim()) && !b.disabled,
    );
    if (!button) return null;
    button.click();
    return button.textContent.trim();
  })()`);

  await sleep(700);
  const after = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const toast = [...document.querySelectorAll('[class*="toast" i], [role="status"], [role="alert"]')]
      .map((n) => n.textContent.trim())
      .filter(Boolean)
      .slice(0, 2);
    return {
      dialog: dialog ? (dialog.textContent ?? '').trim().slice(0, 90) : null,
      fields: document.querySelectorAll('[role="dialog"] input, [role="dialog"] select, [role="dialog"] textarea').length,
      toast,
    };
  })()`);

  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(250);

  rows.push({
    route,
    clicked: target,
    dialog: after?.dialog ?? null,
    fields: after?.fields ?? 0,
    toast: after?.toast ?? [],
    errors: [...consoleErrors].slice(0, 2),
    buttons: before?.buttons?.length ?? 0,
  });
}

const problems = rows.filter(
  (row) =>
    row.errors.length > 0 ||
    (row.clicked && !row.dialog && (row.toast.length === 0 || row.toast.every((t) => /could not|failed|error/i.test(t)))),
);

process.stdout.write(`\n${rows.length} screens, ${problems.length} problems\n\n`);
for (const row of rows) {
  const flag = row.errors.length > 0 ? 'ERROR' : row.clicked && !row.dialog ? 'NOUI ' : 'ok   ';
  process.stdout.write(
    `${flag} ${row.route.padEnd(26)} clicked="${String(row.clicked).slice(0, 22)}" dialog=${row.dialog ? `yes(${row.fields}f)` : 'no'}\n`,
  );
  for (const toast of row.toast) process.stdout.write(`      toast: ${String(toast).slice(0, 110)}\n`);
  for (const error of row.errors) process.stdout.write(`      ! ${String(error).slice(0, 150)}\n`);
}

fs.writeFileSync(path.join(OUT, 'actions.json'), JSON.stringify(rows, null, 2));
ws.close();
process.exit(problems.length > 0 ? 1 : 0);
