/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * T02 acceptance #9 — the licence key round trip.
 *
 * Issues a key with the real private key (skipped when `keys/private.pem` is
 * absent, which is the normal state of a fresh clone), then proves:
 *   - a valid key for this machine verifies
 *   - a flipped signature character fails as VALIDATION
 *   - a key bound to another machine fails as LICENSE
 *   - a truncated key fails as VALIDATION
 */

const assert = require('node:assert/strict');
const { createPrivateKey, sign } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const verify = require('../dist/main/main/license/verify.js');
const machine = require('../dist/main/main/license/machine.js');

const PRIVATE_KEY_PATH = path.join(__dirname, '..', 'keys', 'private.pem');
const hasKey = fs.existsSync(PRIVATE_KEY_PATH);

function issue(payload) {
  const privatePem = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  const payloadText = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(payloadText, 'utf8'), createPrivateKey(privatePem));
  return `NEXUS-${payload.edition.toUpperCase()}-${verify.encodeBase32(
    Buffer.from(payloadText, 'utf8'),
  )}-${verify.encodeBase32(signature)}`;
}

const thisMachine = machine.machineId();

test('machine id is 16 lowercase hex characters', () => {
  assert.match(thisMachine, /^[0-9a-f]{16}$/);
});

test('base32 round trips arbitrary bytes', () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const encoded = verify.encodeBase32(bytes);
  assert.match(encoded, /^[A-Z2-7]+$/);
  assert.deepEqual(Buffer.from(verify.decodeBase32(encoded)), bytes);
});

test('a valid key for this machine verifies', { skip: !hasKey }, () => {
  const key = issue({
    v: 1,
    edition: 'pro',
    licensee: 'Test Co',
    email: 'ops@test.test',
    seats: 5,
    machine_id: thisMachine,
    issued_at: new Date().toISOString(),
  });
  const payload = verify.verifyKey(key, thisMachine);
  assert.equal(payload.edition, 'pro');
  assert.equal(payload.licensee, 'Test Co');
  assert.equal(payload.seats, 5);
});

test('a flipped signature character fails as VALIDATION', { skip: !hasKey }, () => {
  const key = issue({
    v: 1,
    edition: 'pro',
    licensee: 'Test Co',
    email: '',
    seats: 1,
    machine_id: thisMachine,
    issued_at: new Date().toISOString(),
  });
  const parts = key.split('-');
  const signature = parts[3];
  const flippedChar = signature[10] === 'A' ? 'B' : 'A';
  const tampered = `${parts[0]}-${parts[1]}-${parts[2]}-${signature.slice(0, 10)}${flippedChar}${signature.slice(11)}`;

  assert.throws(
    () => verify.verifyKey(tampered, thisMachine),
    (error) => error.code === 'VALIDATION',
  );
});

test('a key bound to another machine fails as LICENSE', { skip: !hasKey }, () => {
  const key = issue({
    v: 1,
    edition: 'enterprise',
    licensee: 'Other Co',
    email: '',
    seats: 1,
    machine_id: '0123456789abcdef',
    issued_at: new Date().toISOString(),
  });
  assert.throws(
    () => verify.verifyKey(key, thisMachine),
    (error) => error.code === 'LICENSE',
  );
});

test('an unbound key activates anywhere', { skip: !hasKey }, () => {
  const key = issue({
    v: 1,
    edition: 'community',
    licensee: 'Trial',
    email: '',
    seats: 1,
    machine_id: '*',
    issued_at: new Date().toISOString(),
  });
  assert.equal(verify.verifyKey(key, thisMachine).licensee, 'Trial');
});

test('a truncated key fails as VALIDATION', { skip: !hasKey }, () => {
  const key = issue({
    v: 1,
    edition: 'pro',
    licensee: 'Test Co',
    email: '',
    seats: 1,
    machine_id: thisMachine,
    issued_at: new Date().toISOString(),
  });
  const truncated = key.slice(0, key.length - 20);
  assert.throws(
    () => verify.verifyKey(truncated, thisMachine),
    (error) => error.code === 'VALIDATION',
  );
});

test('garbage is rejected without throwing an internal error', () => {
  for (const candidate of ['', 'hello', 'NEXUS-PRO-!!!-???', 'NEXUS-BASIC-AAAA-BBBB']) {
    assert.throws(
      () => verify.verifyKey(candidate, thisMachine),
      (error) => error.code === 'VALIDATION',
      `expected VALIDATION for ${candidate}`,
    );
  }
});

// ── the owner's perpetual code ───────────────────────────────────────────────

test('the owner code activates Enterprise, perpetually, on any machine', () => {
  const payload = verify.verifyKey('arfanayub0', thisMachine);
  assert.equal(payload.edition, 'enterprise');
  assert.equal(payload.licensee, 'arfanayub0');
  assert.equal(payload.machine_id, '*', 'an unbound key is what lets it work everywhere');
  assert.ok(payload.seats >= 1);
  // No expiry field exists in the payload at all — perpetual by construction.
  assert.equal('expires_at' in payload, false);
});

test('the owner code is forgiving about case and stray spaces', () => {
  for (const spelling of ['arfanayub0', 'ARFANAYUB0', ' ArfanAyub0 ', 'arfan ayub0']) {
    assert.equal(verify.verifyKey(spelling, thisMachine).edition, 'enterprise', spelling);
    assert.equal(verify.isMasterKey(spelling), true, spelling);
  }
});

test('the owner code is accepted from another machine too', () => {
  // The signed keys are machine-bound; the owner code deliberately is not.
  const elsewhere = verify.verifyKey('arfanayub0', 'aaaaaaaaaaaaaaaa');
  assert.equal(elsewhere.edition, 'enterprise');
});

test('a near-miss of the owner code is still rejected', () => {
  for (const candidate of ['arfanayub', 'arfanayub01', 'arfanayubO', 'arfanayub0x']) {
    assert.throws(
      () => verify.verifyKey(candidate, thisMachine),
      (error) => error.code === 'VALIDATION',
      `expected VALIDATION for ${candidate}`,
    );
    assert.equal(verify.isMasterKey(candidate), false, candidate);
  }
});
