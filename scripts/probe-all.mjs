/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Development-only: walk every route in a running build and report what rendered.
 *
 * A page can fail in three ways that look identical to a user and different to a
 * probe: it throws (console error + empty body), it stays on a skeleton forever
 * (IPC never answered), or it renders an empty state because the query returned
 * nothing. This script separates them.
 *
 *   node scripts/probe-all.mjs --port 9333 --login owner:pass
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const PORT = Number(arg('port', '9333'));
const LOGIN = arg('login', '');
const OUT = arg('out', 'tmp/probe');
const SETTLE = Number(arg('settle', '1100'));

const ROUTES = [
  '/dashboard',
  '/search',
  '/finance/invoices',
  '/finance/bills',
  '/finance/payments',
  '/finance/journal-entries',
  '/finance/accounts',
  '/finance/periods',
  '/finance/reports',
  '/inventory/products',
  '/inventory/stock',
  '/inventory/moves',
  '/inventory/warehouses',
  '/purchasing/vendors',
  '/purchasing/orders',
  '/purchasing/receipts',
  '/purchasing/bills',
  '/sales/customers',
  '/sales/quotations',
  '/sales/orders',
  '/sales/price-lists',
  '/crm/deals',
  '/crm/accounts',
  '/crm/leads',
  '/crm/activities',
  '/crm/analytics',
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
const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'))
  ?? targets.find((target) => target.type === 'page');
if (!page) {
  console.error('no page target');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const consoleErrors = [];
const exceptions = [];

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
    consoleErrors.push(message.params.args.map((entry) => entry.value ?? entry.description ?? '').join(' '));
  }
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
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
/**
 * Every CDP call is bounded.
 *
 * An unanswered `Runtime.evaluate` (a renderer that is busy, crashed, or blocked
 * on a modal) used to hang the whole run with no output — a verifier that hangs
 * is worse than one that fails, because the release looks "still in progress".
 */
const CALL_TIMEOUT_MS = Number(arg('call-timeout', '15000'));

const evaluate = async (expression) => {
  const result = await Promise.race([
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Runtime.evaluate timed out after ${CALL_TIMEOUT_MS} ms`)), CALL_TIMEOUT_MS),
    ),
  ]);
  return result.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');

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
  exceptions.length = 0;
  await evaluate(`location.hash = ${JSON.stringify(`#${route}`)}`);
  await sleep(SETTLE);
  const state = await evaluate(`(() => {
    const main = document.querySelector('main');
    const heading = document.querySelector('h1');
    const text = (main?.innerText ?? document.body.innerText ?? '').trim();
    const skeletons = document.querySelectorAll('[class*="skeleton"], [class*="Skeleton"]').length;
    const tables = document.querySelectorAll('table').length;
    const inputs = document.querySelectorAll('input, select, textarea').length;
    return {
      hash: location.hash,
      heading: heading?.textContent?.trim() ?? '',
      chars: text.length,
      skeletons,
      tables,
      inputs,
      empty: /nothing (here|yet)|no .* yet|nothing on hand/i.test(text),
    };
  })()`);
  rows.push({
    route,
    ...state,
    errors: [...exceptions, ...consoleErrors].slice(0, 3),
  });
  const slug = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
  fs.writeFileSync(path.join(OUT, `${slug}.txt`), (await evaluate('document.querySelector("main")?.innerText ?? ""')) ?? '');
}

const failed = rows.filter((row) => row.chars < 40 || row.errors.length > 0);
const blank = rows.filter((row) => row.chars < 40);

process.stdout.write(`\n${rows.length} routes probed — ${failed.length} with problems, ${blank.length} blank\n\n`);
for (const row of rows) {
  const flag = row.chars < 40 ? 'BLANK' : row.errors.length > 0 ? 'ERROR' : row.skeletons > 0 ? 'STUCK' : 'ok   ';
  process.stdout.write(
    `${flag} ${row.route.padEnd(28)} chars=${String(row.chars).padStart(4)} tables=${row.tables} ` +
      `inputs=${row.inputs} heading="${row.heading.slice(0, 40)}"\n`,
  );
  if (row.errors.length > 0) {
    for (const error of row.errors) process.stdout.write(`      ! ${String(error).slice(0, 160)}\n`);
  }
}

fs.writeFileSync(path.join(OUT, 'routes.json'), JSON.stringify(rows, null, 2));
ws.close();
process.exit(failed.length > 0 ? 1 : 0);
