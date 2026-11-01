/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * End-to-end CRM driver (development only, never shipped).
 *
 * Walks the revenue chain over the real bridge:
 *
 *   onboarding → sign in → lead → preview the conversion → convert →
 *   the deal is on the board → drag it to Qualified → drag it to Won →
 *   analytics agrees → search finds the account → the palette shows it →
 *   converting the same lead again is refused
 *
 * The step that matters is the conversion: one call must produce an account, a
 * contact and a deal, and the lead must record all three. A conversion that
 * creates the account and then fails on the deal leaves a half-customer behind,
 * which is the defect this driver exists to catch.
 *
 * Usage:
 *   npx electron . --remote-debugging-port=9224 --user-data-dir=/tmp/nexus-crm
 *   node scripts/e2e-crm.mjs
 */

import process from 'node:process';

const PORT = Number(process.env.NEXUS_CDP_PORT ?? 9224);
const ENDPOINT = `http://127.0.0.1:${PORT}/json/list`;
const DEADLINE_MS = 90_000;

const ADMIN = { username: 'owner', password: 'Quiet-Harbor-92x' };

const ONBOARDING = {
  company: { name: 'Vector CRM', legalName: 'Vector CRM Ltd', taxId: '88-1234567' },
  presetId: 'services',
  currency: 'USD',
  fiscalStartMonth: 1,
  admin: { username: ADMIN.username, fullName: 'Ada Owner', email: 'owner@vector.test', password: ADMIN.password },
  loadDemo: false,
};

const today = new Date().toISOString().slice(0, 10);
const steps = [];

function note(step, detail) {
  steps.push({ step, detail });
  console.log(`  \u2713 ${step}${detail === undefined ? '' : ` \u2014 ${detail}`}`);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function findPage() {
  const started = Date.now();
  while (Date.now() - started < DEADLINE_MS) {
    try {
      const response = await fetch(ENDPOINT);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // The debugger port is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no renderer page appeared on port ${PORT} within ${DEADLINE_MS} ms`);
}

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

/** Invokes a channel and throws on refusal, so every step asserts. */
async function invoke(client, channel, payload = {}) {
  const result = await evaluate(
    client,
    `window.nexus.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`,
  );
  if (!result || !result.ok) {
    throw new Error(`${channel} refused: ${JSON.stringify(result?.error ?? result)}`);
  }
  return result.data;
}

/** Invokes a channel that MUST be refused, and asserts the typed error code. */
async function refused(client, channel, payload, expectedCode) {
  const result = await evaluate(
    client,
    `window.nexus.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)})`,
  );
  if (!result || result.ok) throw new Error(`${channel} should have been refused, but succeeded`);
  const code = result.error?.code;
  check(
    code === expectedCode,
    `${channel} refused with ${String(code)} (expected ${expectedCode}): ${String(result.error?.message)}`,
  );
  check(
    typeof result.error?.message === 'string' && result.error.message.length > 0,
    `${channel} refused without a message a person could act on`,
  );
  return result.error;
}

async function main() {
  const page = await findPage();
  const client = connect(page.webSocketDebuggerUrl);

  try {
    // ── 0. a working company ────────────────────────────────────────────────
    const status = await invoke(client, 'onboarding.status');
    if (!status.complete) {
      await invoke(client, 'onboarding.complete', ONBOARDING);
      note('onboarding.complete', 'company, chart of accounts, sales pipeline');
    } else {
      note('onboarding.status', 'already set up');
    }
    await invoke(client, 'auth.login', ADMIN);
    note('auth.login', ADMIN.username);

    // ── 1. the pipeline the deal will live in ───────────────────────────────
    const pipelines = await invoke(client, 'crm.pipelines.list');
    check(pipelines.length >= 1, 'a company must have at least one pipeline');
    const pipeline = pipelines.find((entry) => entry.isDefault) ?? pipelines[0];
    check(pipeline.stages.length >= 3, `expected a real pipeline, got ${pipeline.stages.length} stages`);

    // Stages are picked by role, not by name: each industry preset names its own
    // columns (Discovery, Tender, …), and a driver that hard-codes "Qualified"
    // only works for one of them.
    const openStages = pipeline.stages.filter((stage) => !stage.isWon && !stage.isLost);
    check(openStages.length >= 2, 'a pipeline needs at least two open stages');
    const qualified = openStages[1];
    const won = pipeline.stages.find((stage) => stage.isWon);
    const lostStage = pipeline.stages.find((stage) => stage.isLost);
    check(won, 'the pipeline must have a won stage');
    check(lostStage, 'the pipeline must have a lost stage');
    note('crm.pipelines.list', `${pipeline.name}, ${pipeline.stages.length} stages`);

    // ── 2. a lead ───────────────────────────────────────────────────────────
    const lead = await invoke(client, 'entity.save', {
      entity: 'leads',
      values: {
        name: 'Grace Hopper',
        company: 'Vector Analytics',
        email: 'grace@vector-analytics.test',
        phone: '+1 555 0142',
        source: 'referral',
        status: 'new',
        score: 72,
        estimated_value_cents: 4_800_000,
      },
    });
    note('entity.save leads', lead.id.slice(0, 8));

    // ── 3. the preview must promise what the commit creates ─────────────────
    const conversion = {
      leadId: lead.id,
      account: {
        name: 'Vector Analytics Inc',
        industry: 'Software',
        domain: 'vector-analytics.test',
        phone: null,
        ownerId: null,
        customerId: null,
      },
      contact: {
        firstName: 'Grace',
        lastName: 'Hopper',
        title: 'CTO',
        email: 'grace@vector-analytics.test',
        phone: null,
        isPrimary: true,
      },
      deal: {
        name: 'Vector Analytics — platform rollout',
        pipelineId: pipeline.id,
        stageId: null,
        valueCents: 4_800_000,
        currency: 'USD',
        expectedCloseDate: null,
        ownerId: null,
      },
    };

    const preview = await invoke(client, 'crm.lead.convertPreview', conversion);
    check(preview.blocked.length === 0, `the conversion should not be blocked: ${preview.blocked.join(' ')}`);
    check(preview.willCreate.account.name === conversion.account.name, 'the preview must name the account');
    check(preview.willCreate.deal.valueCents === 4_800_000, 'the preview must carry the deal value');
    note('crm.lead.convertPreview', `${preview.willCreate.account.name} / ${preview.willCreate.deal.stageName}`);

    // ── 4. convert: one call, three records ─────────────────────────────────
    const converted = await invoke(client, 'crm.lead.convert', conversion);
    check(converted.accountId && converted.contactId && converted.dealId, 'conversion must return all three ids');

    const storedLead = await invoke(client, 'entity.get', { entity: 'leads', id: lead.id });
    check(storedLead.status === 'converted', `expected the lead to be converted, got ${storedLead.status}`);
    check(storedLead.converted_deal_id === converted.dealId, 'the lead must point at the deal it became');
    check(storedLead.converted_account_id === converted.accountId, 'and at the account');

    const account = await invoke(client, 'entity.get', { entity: 'crmAccounts', id: converted.accountId });
    check(account.name === conversion.account.name, `expected ${conversion.account.name}, got ${account.name}`);
    note('crm.lead.convert', `${account.name} + contact + deal`);

    // ── 5. it is on the board, in the first column ──────────────────────────
    const board = await invoke(client, 'crm.deal.board', { pipelineId: pipeline.id });
    const firstColumn = board.columns[0];
    check(firstColumn, 'the board must have columns');
    const card = firstColumn.deals.find((entry) => entry.id === converted.dealId);
    check(card, 'the new deal must appear on the board');
    check(card.accountName === conversion.account.name, 'the card must name its account');
    check(
      firstColumn.valueCents >= 4_800_000,
      `the column total must include the new deal, saw ${firstColumn.valueCents}`,
    );
    note('crm.deal.board', `${board.columns.length} columns, deal in "${firstColumn.stage.name}"`);

    // ── 6. drag it to Qualified: probability follows the stage ──────────────
    const moved = await invoke(client, 'crm.deal.moveStage', {
      id: converted.dealId,
      stageId: qualified.id,
      note: 'Discovery call went well',
    });
    check(moved.stageId === qualified.id, 'the deal must be in the stage it was dropped on');
    check(
      moved.probabilityBp === qualified.probabilityBp,
      `probability must come from the stage: expected ${qualified.probabilityBp}, got ${moved.probabilityBp}`,
    );

    const timeline = await invoke(client, 'crm.timeline', {
      entity: 'deals',
      entityId: converted.dealId,
      limit: 50,
    });
    const stageChange = timeline.rows.find((row) => row.type === 'stage_changed');
    check(stageChange, 'a move must write a stage_changed activity');
    check(stageChange.body === 'Discovery call went well', 'the note must survive onto the activity');
    note('crm.deal.moveStage', `${qualified.name} at ${(qualified.probabilityBp / 100).toFixed(0)} %`);

    // ── 7. a loss without a reason is refused ───────────────────────────────
    const second = await invoke(client, 'entity.save', {
      entity: 'deals',
      values: {
        name: 'Vector — add-on',
        pipeline_id: pipeline.id,
        stage_id: qualified.id,
        value_cents: 500_000,
        currency: 'USD',
        probability_bp: qualified.probabilityBp,
        status: 'open',
        stage_changed_at: new Date().toISOString(),
      },
    });
    await refused(client, 'crm.deal.closeLost', { id: second.id, reason: '', note: null }, 'VALIDATION');
    await refused(
      client,
      'crm.deal.moveStage',
      { id: second.id, stageId: lostStage.id, note: null },
      'CONFLICT',
    );
    const lost = await invoke(client, 'crm.deal.closeLost', {
      id: second.id,
      reason: 'Chose a competitor on price',
      note: null,
    });
    check(lost.probabilityBp === 0, 'a lost deal is worth nothing in the forecast');
    note('crm.deal.closeLost', 'refused without a reason, accepted with one');

    // ── 8. drop the first deal on Won ───────────────────────────────────────
    const closed = await invoke(client, 'crm.deal.closeWon', { id: converted.dealId, note: 'Signed' });
    check(closed.probabilityBp === 10_000, 'a won deal is 100 %');
    await refused(client, 'crm.deal.moveStage', { id: converted.dealId, stageId: qualified.id, note: null }, 'CONFLICT');
    note('crm.deal.closeWon', 'signed, and no longer draggable');

    // ── 9. analytics agrees with what just happened ─────────────────────────
    const analytics = await invoke(client, 'crm.analytics', {
      from: today.slice(0, 8) + '01',
      to: today,
      pipelineId: pipeline.id,
    });
    check(analytics.kpis.wonCents === 4_800_000, `expected 48000.00 won, got ${analytics.kpis.wonCents}`);
    check(analytics.kpis.lostCents === 500_000, `expected 5000.00 lost, got ${analytics.kpis.lostCents}`);
    check(analytics.kpis.winRateBp === 5000, `one of two decided is 50 %, got ${analytics.kpis.winRateBp}`);
    check(analytics.kpis.wonCount === 1 && analytics.kpis.lostCount === 1, 'one won, one lost');
    check(analytics.kpis.avgCycleDays !== null, 'a won deal means there is a cycle to average');
    check(analytics.lossReasons.length === 1, 'the loss must be attributed');
    check(analytics.lossReasons[0].reason === 'Chose a competitor on price', 'and to the reason given');
    note(
      'crm.analytics',
      `won ${(analytics.kpis.wonCents / 100).toFixed(2)}, ${(analytics.kpis.winRateBp / 100).toFixed(0)} % win rate`,
    );

    // ── 10. the palette can find what we just made ──────────────────────────
    const found = await invoke(client, 'search.global', { q: 'Vector Analytics', limit: 8 });
    const accountGroup = found.groups.find((group) => group.kind === 'crmAccount');
    check(accountGroup, 'search must group CRM accounts separately');
    check(
      accountGroup.rows.some((row) => row.id === converted.accountId),
      'search must find the account it just created',
    );
    for (const group of found.groups) {
      check(group.rows.length <= 8, `group ${group.kind} exceeded the per-group limit`);
    }
    const palette = await invoke(client, 'search.palette', { q: 'Vector Analytics' });
    for (const group of palette.groups) {
      check(group.rows.length <= 4, `the palette must cap ${group.kind} at four`);
    }
    note('search.global', `${found.groups.length} groups, palette capped at 4`);

    // ── 11. the dashboard reflects the pipeline ─────────────────────────────
    const summary = await invoke(client, 'dashboard.summary', { period: 'month' });
    check(summary.kpis.length === 6, `expected six KPIs, got ${summary.kpis.length}`);
    for (const kpi of summary.kpis) {
      check(kpi.sparkline.length === 12, `${kpi.key} must have twelve sparkline points`);
    }
    check(summary.series.length === 12, 'the twelve-month series must have twelve points');
    check(summary.period.from <= summary.period.to, 'the period must not be inverted');
    note('dashboard.summary', `${summary.kpis.length} KPIs in ${String(summary.ms)} ms`);

    // ── 12. a converted lead cannot be converted again ──────────────────────
    await refused(client, 'crm.lead.convert', conversion, 'CONFLICT');
    note('crm.lead.convert (again)', 'refused, as it must be');

    // ── 13. every mutation above is in the audit log ────────────────────────
    const trail = await invoke(client, 'audit.list', { entity: 'deals', limit: 50 });
    check(trail.total >= 2, `expected the deal writes to be audited, saw ${trail.total}`);
    const chain = await invoke(client, 'audit.verify');
    check(chain.ok === true, `the audit chain must verify, broke at ${String(chain.brokenAtSeq)}`);
    note('audit.verify', `${String(chain.checked)} entries intact`);

    console.log(`\nE2E CRM PASSED \u2014 ${String(steps.length)} steps`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`\nE2E CRM FAILED \u2014 ${error.message}`);
  process.exitCode = 1;
});
