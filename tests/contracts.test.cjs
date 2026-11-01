/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * T01 acceptance #6 and #7 — the frozen contracts.
 *
 * The channel test is the one that keeps BR-20 honest: if somebody adds a
 * channel and forgets the permission map, this fails before the build does.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const channels = require('../dist/main/shared/channels.js');
const permissions = require('../dist/main/shared/permissions.js');
const presets = require('../dist/main/shared/industry-presets.js');
const modules = require('../dist/main/shared/modules.js');
const types = require('../dist/main/shared/types.js');

test('CHANNELS is a readonly literal array with no duplicates', () => {
  const unique = new Set(channels.CHANNELS);
  assert.equal(unique.size, channels.CHANNELS.length, 'duplicate channel name');
  // A change detector, not a limit: growing the catalogue is a deliberate act
  // that must update this number in the same commit. T05/T06/R1 added the
  // finance, document, search, archive, performance and the T07/T08 operations
  // channels (131 → 150 → 176). T09/T10 added the CRM board, lead conversion,
  // analytics, dashboard, global search, import, backup, audit-diff and
  // `entity.restore` channels (176 → 186). This is a change detector, not a
  // limit: adding a channel without updating this line is the mistake it exists
  // to catch.
  assert.equal(channels.CHANNELS.length, 186, 'the catalogue must stay at 186 channels');
  assert.equal(channels.CHANNEL_SET.size, channels.CHANNELS.length);
});

test('every channel has a permission requirement', () => {
  for (const channel of channels.CHANNELS) {
    const requirement = channels.CHANNEL_PERMISSIONS[channel];
    assert.ok(requirement !== undefined, `no permission mapped for ${channel}`);
    if (requirement === channels.PUBLIC) continue;
    if (requirement.startsWith('entity.')) continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(permissions.PERMISSIONS, requirement),
      `${channel} maps to unknown permission ${requirement}`,
    );
  }
});

test('the permission map has no stale entries', () => {
  const mapped = Object.keys(channels.CHANNEL_PERMISSIONS);
  assert.equal(mapped.length, channels.CHANNELS.length);
  for (const channel of mapped) {
    assert.ok(channels.CHANNEL_SET.has(channel), `${channel} is mapped but not in CHANNELS`);
  }
});

test('every permission is reachable from at least one channel or the entity registry', () => {
  const used = new Set();
  for (const requirement of Object.values(channels.CHANNEL_PERMISSIONS)) {
    if (requirement !== channels.PUBLIC && !requirement.startsWith('entity.')) used.add(requirement);
  }
  for (const meta of Object.values(types.ENTITIES)) {
    used.add(meta.read);
    used.add(meta.write);
    if (meta.remove) used.add(meta.remove);
  }
  // Permissions that only guard a route or a page action in ARCHITECTURE §E.1:
  // the purchase-order builder and the receipts list have no dedicated channel
  // because `entity.save` / `purchasing.receipt.post` cover them.
  const routeOnly = new Set([
    'purchasing.po.create',
    'purchasing.receipt.read',
    // In-handler escalations (T07/T08): the channel is guarded by the ordinary
    // write permission, and these are checked inside the service when a quantity
    // would go negative, a quote has expired, or an order breaches the credit
    // limit. They deliberately have no channel of their own.
    'inventory.stock.allow_negative',
    'sales.quotation.override_expiry',
    'sales.order.override_credit',
  ]);
  const unreachable = permissions.PERMISSION_KEYS.filter((key) => !used.has(key) && !routeOnly.has(key));
  assert.deepEqual(unreachable, [], `permissions with no channel and no entity: ${unreachable.join(', ')}`);
});

test('entity channels resolve through the entity registry', () => {
  for (const channel of channels.CHANNELS) {
    const requirement = channels.CHANNEL_PERMISSIONS[channel];
    if (!requirement.startsWith('entity.')) continue;
    const op = requirement.slice('entity.'.length);
    assert.ok(['read', 'write', 'delete', 'export'].includes(op), `${channel} has an odd entity op`);
  }
  assert.equal(Object.keys(types.ENTITIES).length, 24);
});

test('role presets only contain real permissions', () => {
  for (const preset of Object.values(permissions.ROLE_PRESETS)) {
    for (const key of preset.permissions) {
      assert.ok(permissions.isPermission(key), `${preset.id} references unknown permission ${key}`);
    }
    assert.ok(preset.permissions.length > 0, `${preset.id} grants nothing`);
  }
  assert.equal(permissions.ROLE_PRESETS.owner.permissions.length, permissions.PERMISSION_KEYS.length);
});

test('there are exactly seven industry presets, each complete (T01 #7)', () => {
  assert.equal(presets.INDUSTRY_PRESETS.length, 7);
  for (const preset of presets.INDUSTRY_PRESETS) {
    assert.ok(preset.modules.length > 0, `${preset.id} enables no modules`);
    assert.ok(preset.coaSeed.length >= 20 && preset.coaSeed.length <= 35, `${preset.id} chart size`);
    assert.ok(preset.taxes.length > 0, `${preset.id} seeds no taxes`);
    assert.ok(preset.numbering.length > 0, `${preset.id} seeds no numbering`);
    assert.ok(preset.customFields.length > 0, `${preset.id} seeds no custom fields`);
    assert.ok(preset.landingModule.length > 0, `${preset.id} has no landing module`);
  }
});

test('every preset chart is a valid hierarchy', () => {
  const problems = presets.validatePresets();
  assert.deepEqual(problems, []);
});

test('presets that do not stock goods have no inventory module', () => {
  for (const id of ['services', 'education', 'ngo']) {
    const preset = presets.presetById(id);
    assert.ok(preset, `${id} preset missing`);
    assert.equal(preset.modules.includes('inventory'), false, `${id} should not enable inventory`);
    assert.equal(
      preset.coaSeed.some((account) => account.code.startsWith('12')),
      false,
      `${id} should not seed stock accounts`,
    );
  }
});

test('preset preview is the wizard contract', () => {
  const preset = presets.presetById('manufacturing');
  const preview = presets.previewOf(preset);
  assert.equal(preview.id, 'manufacturing');
  assert.equal(preview.coa.count, preset.coaSeed.length);
  assert.ok(preview.coa.sample.length > 0);
  assert.equal(preview.landing, preset.landingModule);
});

test('module registry covers the eight modules and every route prefix', () => {
  assert.equal(modules.MODULES.length, 8);
  assert.equal(modules.moduleForRoute('/finance/invoices/42').id, 'finance');
  assert.equal(modules.moduleForRoute('/crm/deals').id, 'crm');
  assert.equal(modules.moduleForRoute('/print/invoice/1').id, 'documents');
  assert.equal(modules.moduleForRoute('/settings/company').id, 'settings');
  assert.equal(modules.moduleForRoute('/nowhere'), undefined);
});

test('module visibility respects both preset and permissions', () => {
  const financeOnly = new Set(['finance.invoice.read']);
  const visible = modules.visibleModules('services', financeOnly);
  assert.deepEqual(
    visible.map((module) => module.id),
    ['finance'],
  );
  const stockVisible = modules.visibleModules('wholesale_retail', new Set(['inventory.product.read']));
  assert.equal(stockVisible.some((module) => module.id === 'inventory'), true);
});
