"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MASTER_KEY = void 0;
exports.encodeBase32 = encodeBase32;
exports.decodeBase32 = decodeBase32;
exports.parseKey = parseKey;
exports.verifySignature = verifySignature;
exports.assertMachine = assertMachine;
exports.hashKey = hashKey;
exports.isMasterKey = isMasterKey;
exports.verifyKey = verifyKey;
exports.isKeyFailure = isKeyFailure;
/**
 * Offline licence verification (ARCHITECTURE §F.1 T3, risk R6).
 *
 * Key format:
 *   NEXUS-<EDITION>-<base32url(payload json)>-<base32url(ed25519 signature)>
 *
 * The payload JSON contains `-`, so the key is NEVER split on `-`: it is parsed
 * with an anchored regex and validated by decodability, not by position.
 * base32 has no Node decoder, so encode/decode are ~15 lines of bit shifting
 * here — no dependency, no supply-chain surface.
 *
 * Order matters: signature first, machine binding second. A tampered key must
 * fail as VALIDATION before anyone learns whether the machine matches.
 */
const node_crypto_1 = require("node:crypto");
const errors_1 = require("../errors");
const log_1 = require("../log");
const pubkey_1 = require("./pubkey");
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]));
const KEY_PATTERN = /^NEXUS-(COMMUNITY|PRO|ENTERPRISE)-([A-Z2-7]+)-([A-Z2-7]+)$/;
const EDITION_BY_LABEL = {
    COMMUNITY: 'community',
    PRO: 'pro',
    ENTERPRISE: 'enterprise',
};
/** RFC 4648 base32 without padding. */
function encodeBase32(bytes) {
    let output = '';
    let buffer = 0;
    let bits = 0;
    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += ALPHABET[(buffer >>> (bits - 5)) & 31];
            bits -= 5;
        }
        buffer &= (1 << bits) - 1;
    }
    if (bits > 0)
        output += ALPHABET[(buffer << (5 - bits)) & 31];
    return output;
}
/** RFC 4648 base32 without padding. Throws on an illegal character. */
function decodeBase32(input) {
    const bytes = [];
    let buffer = 0;
    let bits = 0;
    for (const char of input.toUpperCase()) {
        const value = LOOKUP.get(char);
        if (value === undefined)
            throw new Error(`Illegal base32 character: ${char}`);
        buffer = (buffer << 5) | value;
        bits += 5;
        if (bits >= 8) {
            bytes.push((buffer >>> (bits - 8)) & 0xff);
            bits -= 8;
            buffer &= (1 << bits) - 1;
        }
    }
    return new Uint8Array(bytes);
}
function isPayloadShape(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    return (typeof candidate.v === 'number' &&
        typeof candidate.edition === 'string' &&
        typeof candidate.licensee === 'string' &&
        typeof candidate.seats === 'number' &&
        typeof candidate.machine_id === 'string' &&
        typeof candidate.issued_at === 'string');
}
/**
 * Parses a key without verifying it. Any structural problem is a `VALIDATION`
 * error with a sentence a support person can act on.
 */
function parseKey(key) {
    const trimmed = key.trim().toUpperCase().replace(/\s+/g, '');
    const match = KEY_PATTERN.exec(trimmed);
    if (!match) {
        throw (0, errors_1.validation)('key', 'That does not look like a NEXUS licence key. Copy the whole line, starting with NEXUS-.');
    }
    const [, editionLabel = '', payloadPart = '', signaturePart = ''] = match;
    const edition = EDITION_BY_LABEL[editionLabel];
    if (!edition)
        throw (0, errors_1.validation)('key', 'Unknown licence edition in the key.');
    let payloadBytes;
    let signature;
    try {
        payloadBytes = decodeBase32(payloadPart);
        signature = decodeBase32(signaturePart);
    }
    catch {
        throw (0, errors_1.validation)('key', 'The licence key is damaged — some characters are not valid. Copy it again.');
    }
    if (signature.byteLength !== 64) {
        throw (0, errors_1.validation)('key', 'The licence key is incomplete. Copy the whole line and try again.');
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(payloadBytes).toString('utf8'));
    }
    catch {
        throw (0, errors_1.validation)('key', 'The licence key is damaged and cannot be read.');
    }
    if (!isPayloadShape(parsed))
        throw (0, errors_1.validation)('key', 'The licence key is missing required details.');
    return {
        payload: { ...parsed, edition },
        payloadText: Buffer.from(payloadBytes).toString('utf8'),
        signature,
        edition,
    };
}
/**
 * Ed25519 verification. Wrapped so a malformed key can never surface as
 * INTERNAL — every failure is a `VALIDATION` sentence.
 */
function verifySignature(payloadText, signature) {
    try {
        return (0, node_crypto_1.verify)(null, Buffer.from(payloadText, 'utf8'), pubkey_1.LICENSE_PUBLIC_KEY_PEM, Buffer.from(signature));
    }
    catch (error) {
        (0, log_1.logWarn)('license.verify', `signature check failed to run: ${String(error)}`);
        return false;
    }
}
/**
 * Machine binding, checked only AFTER the signature is known good.
 * `'*'` means an unbound evaluation key and passes anywhere.
 */
function assertMachine(payload, machine) {
    if (payload.machine_id === '*')
        return;
    if (payload.machine_id !== machine) {
        throw (0, errors_1.licenseError)('This key was issued for a different computer. Ask for a key for this machine ID, or re-activate the original key on the original machine.');
    }
}
/** `sha256(key)` — stored in `license_state.key_hash` so re-activation is idempotent. */
function hashKey(key) {
    return (0, node_crypto_1.createHash)('sha256').update(key.trim().toUpperCase(), 'utf8').digest('hex');
}
/**
 * The owner's perpetual key.
 *
 * A signed key is machine-bound by design — that is what stops one customer's
 * key from unlocking a thousand installs. The product owner asked for a single
 * short code that activates any machine, for life, and that is a legitimate
 * business decision: this is their own product, and they would rather type ten
 * characters than paste 400.
 *
 * The trade-off is deliberate and documented in `DECISIONS.md`: this code is
 * guessable, so anyone who learns it unlocks every copy. The signed path is
 * untouched and remains the way customer keys work — the two coexist, and a
 * machine-bound key still fails on the wrong machine.
 */
exports.MASTER_KEY = 'arfanayub0';
/** True when the text is the owner's perpetual key (case and spacing ignored). */
function isMasterKey(key) {
    return key.trim().toLowerCase().replace(/\s+/g, '') === exports.MASTER_KEY;
}
/**
 * The payload the master key stands for: Enterprise, unlimited seats, no expiry
 * and no machine binding. `machine_id: '*'` is the existing "passes anywhere"
 * marker, so nothing downstream needs a special case.
 */
function masterPayload(key) {
    if (!isMasterKey(key))
        return null;
    return {
        v: 1,
        edition: 'enterprise',
        licensee: 'arfanayub0',
        email: 'arfanayub0',
        seats: 999,
        machine_id: '*',
        issued_at: new Date().toISOString(),
    };
}
/** Parse → verify signature → bind to machine. Returns the trusted payload. */
function verifyKey(key, machine) {
    const master = masterPayload(key);
    if (master)
        return master;
    const parsed = parseKey(key);
    if (!verifySignature(parsed.payloadText, parsed.signature)) {
        throw (0, errors_1.validation)('key', 'This licence key is not valid — its signature does not match. Check for a typo.');
    }
    assertMachine(parsed.payload, machine);
    if (parsed.payload.edition !== parsed.edition) {
        // Defensive: the label and the signed payload must agree.
        throw (0, errors_1.licenseError)('The licence key edition does not match its signed contents.');
    }
    return parsed.payload;
}
/** True when `error` is a licence/validation failure rather than a crash. */
function isKeyFailure(error) {
    return (0, errors_1.isAppError)(error);
}
//# sourceMappingURL=verify.js.map