/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Development-only visual capture.
 *
 * Connects to a running NEXUS instance over the Chrome DevTools Protocol, walks a
 * list of routes, and writes one PNG per route. Used to review the UI as a whole
 * instead of page by page in code review.
 *
 *   node scripts/capture.mjs --port 9333 --out tmp/shots --routes /login,/dashboard
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const PORT = Number(arg('port', '9333'));
const OUT = arg('out', 'tmp/shots');
const ROUTES = arg('routes', '/login').split(',').filter(Boolean);
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '900'));

fs.mkdirSync(OUT, { recursive: true });

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: ok, reject: fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message));
        else ok(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          id += 1;
          const current = id;
          return new Promise((ok, fail) => {
            pending.set(current, { resolve: ok, reject: fail });
            ws.send(JSON.stringify({ id: current, method, params }));
          });
        },
        close() {
          ws.close();
        },
      }),
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await targets();
const page =
  list.find((t) => t.type === 'page' && t.url.includes('index.html')) ??
  list.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target');
  process.exit(1);
}

const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
});

/**
 * React tracks input values on the DOM node, so assigning `.value` alone does not
 * reach the component state. The native setter + `input` event is the documented
 * way to drive a controlled input from outside React.
 */
const LOGIN = arg('login', '');
if (LOGIN) {
  const [username, password] = LOGIN.split(':');
  await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const set = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      location.hash = '#/login';
      await new Promise((r) => setTimeout(r, 900));
      const inputs = [...document.querySelectorAll('input')];
      if (inputs.length < 2) return 'no-form';
      set(inputs[0], ${JSON.stringify(username)});
      set(inputs[1], ${JSON.stringify(password)});
      await new Promise((r) => setTimeout(r, 200));
      const form = document.querySelector('form');
      if (form) form.requestSubmit();
      else [...document.querySelectorAll('button')].find((b) => /sign in/i.test(b.textContent))?.click();
      return 'submitted';
    })()`,
    awaitPromise: true,
  });
  await sleep(2200);
}


for (const rawRoute of ROUTES) {
  // Git Bash rewrites a bare `/path` argument into a Windows path; normalise it back.
  const route = rawRoute.includes(':') ? `/${rawRoute.split(/[\\/]/).pop() ?? ''}` : rawRoute.startsWith('/') ? rawRoute : `/${rawRoute}`;
  const hash = `#${route}`;
  await cdp.send('Runtime.evaluate', {
    expression: `location.hash = ${JSON.stringify(hash)}`,
    awaitPromise: false,
  });
  await sleep(1400);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const name = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(file);
}

cdp.close();
process.exit(0);
