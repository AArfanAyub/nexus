/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Issue a customer licence key.
 *
 *   node scripts/keygen.mjs --licensee "Acme Ltd" --email ops@acme.test \
 *        --edition pro --seats 5 --machine auto
 *
 * `--machine auto` binds the key to THIS machine (same derivation as
 * `src/main/license/machine.ts`). Pass an explicit 16-hex id to bind a key to a
 * customer's machine, or `--machine any` for an unbound evaluation key.
 *
 * Output is a single copy-paste line. The private key never leaves `keys/`.
 */

import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname, networkInterfaces, arch, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const EDITIONS = ['community', 'pro', 'enterprise'];

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const privatePath = path.join(root, 'keys', 'private.pem');

/** RFC4648 base32 without padding (the key alphabet has no `-`, so parsing is unambiguous). */
function encodeBase32(bytes) {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string' || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (typeof next === 'string' && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

/** Mirrors `src/main/license/machine.ts` exactly — change both or neither. */
function machineId() {
  const interfaces = networkInterfaces();
  let firstMac = null;
  // Same iteration order as the app: interface names sorted, entries in order.
  for (const name of Object.keys(interfaces).sort()) {
    for (const entry of interfaces[name] ?? []) {
      if (entry.internal) continue;
      if (!entry.mac || entry.mac === '00:00:00:00:00:00') continue;
      firstMac = entry.mac.toLowerCase();
      break;
    }
    if (firstMac !== null) break;
  }
  const seed = `${hostname()}|${platform()}|${arch()}|${firstMac ?? 'no-mac'}`;
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
}

const args = parseArgs(process.argv.slice(2));
const licensee = args.licensee;
const edition = (args.edition ?? 'pro').toLowerCase();
const seats = Number.parseInt(args.seats ?? '1', 10);
const email = args.email ?? '';
const machineArg = args.machine ?? 'auto';

if (!licensee) {
  process.stderr.write('missing --licensee "Company Name"\n');
  process.exit(1);
}
if (!EDITIONS.includes(edition)) {
  process.stderr.write(`--edition must be one of ${EDITIONS.join(', ')}\n`);
  process.exit(1);
}
if (!Number.isInteger(seats) || seats < 1) {
  process.stderr.write('--seats must be a positive integer\n');
  process.exit(1);
}

let boundMachine = machineId();
if (machineArg !== 'auto') {
  boundMachine = machineArg === 'any' ? '*' : machineArg;
}
if (boundMachine !== '*' && !/^[0-9a-f]{16}$/.test(boundMachine)) {
  process.stderr.write('--machine must be "auto", "any" or a 16-char lowercase hex id\n');
  process.exit(1);
}

let privatePem;
try {
  privatePem = readFileSync(privatePath, 'utf8');
} catch {
  process.stderr.write(
    `cannot read ${privatePath}\nrun \`node scripts/gen-license-keys.mjs\` first\n`,
  );
  process.exit(1);
}

const payload = {
  v: 1,
  edition,
  licensee,
  email,
  seats,
  machine_id: boundMachine,
  issued_at: new Date().toISOString(),
};

const payloadText = JSON.stringify(payload);
const signature = sign(null, Buffer.from(payloadText, 'utf8'), createPrivateKey(privatePem));

const key = `NEXUS-${edition.toUpperCase()}-${encodeBase32(Buffer.from(payloadText, 'utf8'))}-${encodeBase32(signature)}`;

process.stdout.write(`licensee : ${licensee}\nedition  : ${edition}\nseats    : ${seats}\nmachine  : ${boundMachine}\n\n${key}\n`);
