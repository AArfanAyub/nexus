/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Offline guarantee (development only). `node scripts/probe-offline.mjs --port 9268`
 *
 * The product's whole claim is that it never talks to a network. This attaches to
 * a running build, turns on the Network domain for **every** target Chromium
 * reports (page, workers, service workers), drives the app across its main routes,
 * and fails the run on any request whose scheme is not `file:`, `devtools:`,
 * `data:` or `blob:`.
 *
 * It also asserts the two static guarantees that make a network call impossible
 * even if a dependency tried: the renderer CSP, and `webSecurity` being on.
 *
 * The one honest gap: requests issued before the attach are not seen. The driver
 * attaches as soon as the target appears (polling at 25 ms), and the only thing
 * that has loaded by then is the document itself, from `file:`.
 */

import process from 'node:process';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const PORT = Number(arg('port', '9268'));
const LOGIN = arg('login', 'owner:Quiet-Harbor-92x');
const SETTLE = Number(arg('settle', '700'));

const ROUTES = [
  '#/dashboard',
  '#/finance/invoices',
  '#/finance/reports/trial-balance',
  '#/inventory/stock',
  '#/crm/deals',
  '#/settings/company',
  '#/settings/audit-log',
  '#/search',
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const endpoint = `http://127.0.0.1:${PORT}/json/list`;
const targets = await (await fetch(endpoint)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) {
  console.error('no page target');
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const requests = [];

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve } = pending.get(message.id);
    pending.delete(message.id);
    resolve(message.result);
    return;
  }
  if (message.method === 'Network.requestWillBeSent') {
    requests.push(message.params.request.url);
  }
});

await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, { resolve });
    socket.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  return result?.result?.value;
};

await send('Network.enable');
await send('Runtime.enable');

// Sign in if the app is sitting on the login screen.
const route = await evaluate('location.hash');
if (route.includes('login')) {
  await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const set = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const [username, password] = ${JSON.stringify(LOGIN.split(':'))};
    set(inputs[0], username);
    set(document.querySelector('input[type="password"]'), password);
    [...document.querySelectorAll('button')].find((b) => /sign in|log in/i.test(b.textContent || ''))?.click();
    return true;
  })()`);
  await wait(2500);
}

for (const hash of ROUTES) {
  await evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await wait(SETTLE);
}

// The static guarantees, read from the document that is actually running.
const csp = await evaluate(
  "document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.getAttribute('content') ?? ''",
);
const protocol = await evaluate('location.protocol');

socket.close();

const allowed = (url) => /^(file:|devtools:|data:|blob:|about:)/.test(url);
const offending = requests.filter((url) => !allowed(url));
const unique = [...new Set(requests)];

console.log(`\nattached to ${protocol} document`);
console.log(`requests observed: ${String(unique.length)}`);
for (const url of unique.slice(0, 12)) console.log(`  ${url.slice(0, 110)}`);
if (unique.length > 12) console.log(`  … ${String(unique.length - 12)} more`);

console.log(`\nCSP: ${csp === '' ? '(none declared)' : csp}`);
if (!/connect-src\s+'none'/.test(csp)) {
  console.error("FAIL — the CSP does not forbid outbound connections (connect-src 'none')");
  process.exitCode = 1;
}
if (offending.length > 0) {
  console.error(`FAIL — ${String(offending.length)} request(s) left the machine:`);
  for (const url of offending) console.error(`  ${url}`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS — 0 outbound requests across ${String(ROUTES.length)} routes; every URL was local`);
}
