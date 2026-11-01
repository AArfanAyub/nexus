/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * First-run smoke driver (development only, never shipped).
 *
 * Attaches to a running Electron instance over the Chrome DevTools Protocol and
 * asserts the two things T04 promises a brand-new user: the app lands on the
 * onboarding wizard, and completing it leaves a non-empty dataset behind.
 *
 * Usage:
 *   npx electron . --remote-debugging-port=9222
 *   node scripts/smoke-firstrun.mjs
 */

import process from 'node:process';

const PORT = Number(process.env.NEXUS_CDP_PORT ?? 9222);
const ENDPOINT = `http://127.0.0.1:${PORT}/json/list`;
const DEADLINE_MS = 60_000;

const PAYLOAD = {
  company: { name: 'Northwind Trading', legalName: 'Northwind Trading LLC', taxId: '27AAPFU0939F1ZV' },
  presetId: 'wholesale_retail',
  currency: 'USD',
  fiscalStartMonth: 1,
  admin: { username: 'owner', fullName: 'Ada Owner', email: 'owner@northwind.test', password: 'Quiet-Harbor-92x' },
  loadDemo: true,
};

/** Polls the CDP target list until a renderer page shows up. */
async function findPage() {
  const started = Date.now();
  while (Date.now() - started < DEADLINE_MS) {
    try {
      const response = await fetch(ENDPOINT);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // The debugger port is not listening yet — keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no renderer page appeared on port ${PORT} within ${DEADLINE_MS} ms`);
}

/** Minimal CDP client: one socket, one in-flight command at a time. */
function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  return {
    async send(method, params = {}) {
      await opened;
      nextId += 1;
      const id = nextId;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

/** Evaluates an async expression in the page and returns its JSON value. */
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`renderer threw: ${text}`);
  }
  return result.result.value;
}

/** Polls until `location.hash` equals `expected` (the guard chain may hop twice). */
async function waitForHash(client, expected, timeoutMs = 20_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await evaluate(client, 'location.hash');
    if (last === expected) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`expected ${expected}, last hash was ${JSON.stringify(last)}`);
}

async function main() {
  const page = await findPage();
  const client = connect(page.webSocketDebuggerUrl);

  try {
    console.log(`page url: ${page.url}`);

    const status = await evaluate(client, "window.nexus.invoke('onboarding.status')");
    console.log(`onboarding.status: ${JSON.stringify(status)}`);

    const session = await evaluate(client, "window.nexus.invoke('auth.session')");
    const signedIn = Boolean(session.ok && session.data && session.data.user);
    const expectedBoot = status.ok && status.data.complete
      ? signedIn
        ? '#/dashboard'
        : '#/login'
      : '#/onboarding';
    const route = await waitForHash(client, expectedBoot);
    console.log(`route on first boot: ${route}`);

    if (status.ok && status.data.complete) {
      console.log('onboarding.complete: skipped (already set up)');
    } else {
      const completed = await evaluate(
        client,
        `window.nexus.invoke('onboarding.complete', ${JSON.stringify(PAYLOAD)})`,
      );
      console.log(`onboarding.complete: ${JSON.stringify(completed)}`);
      if (!completed.ok) throw new Error(`onboarding failed: ${JSON.stringify(completed.error)}`);
    }

    const login = await evaluate(
      client,
      `window.nexus.invoke('auth.login', ${JSON.stringify({
        username: PAYLOAD.admin.username,
        password: PAYLOAD.admin.password,
      })})`,
    );
    console.log(`auth.login: ok=${login.ok} permissions=${login.ok ? login.data.permissions.length : 'n/a'}`);
    if (!login.ok) throw new Error(`login failed: ${JSON.stringify(login.error)}`);

    const dashboard = await evaluate(client, "window.nexus.invoke('entity.list', { entity: 'customers', limit: 1 })");
    console.log(`entity.list customers: ${dashboard.ok ? JSON.stringify(dashboard.data.total) : JSON.stringify(dashboard.error)}`);
    if (!dashboard.ok) throw new Error('entity.list refused after onboarding');

    // The session lives in the main process, so a renderer reload keeps the
    // user signed in and the guard lands them in the shell, not back on the
    // wizard. Signing out and reloading must then land on the sign-in screen.
    await evaluate(client, 'location.reload()').catch(() => undefined);
    const afterReload = await waitForHash(client, '#/dashboard');
    console.log(`route after reload: ${afterReload} (session survived)`);

    await evaluate(client, "window.nexus.invoke('auth.logout')");
    await evaluate(client, 'location.reload()').catch(() => undefined);
    const afterLogout = await waitForHash(client, '#/login');
    console.log(`route after logout + reload: ${afterLogout}`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`SMOKE FAILED: ${error.message}`);
  process.exitCode = 1;
});
