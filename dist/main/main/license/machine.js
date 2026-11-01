"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.machineId = machineId;
exports.machineFingerprint = machineFingerprint;
/**
 * Machine identity for licence binding (ARCHITECTURE §F.1 T3).
 *
 * `sha256(hostname | platform | arch | first non-internal MAC)`, first 16 hex
 * characters. Deliberately stable across reboots and application upgrades, and
 * deliberately not a hardware serial: a NIC swap must not brick a perpetual
 * licence (decision D-05).
 */
const node_crypto_1 = require("node:crypto");
const node_os_1 = require("node:os");
/** The first usable MAC address, or `null` when the machine has none. */
function firstMacAddress() {
    const interfaces = (0, node_os_1.networkInterfaces)();
    for (const name of Object.keys(interfaces).sort()) {
        const entries = interfaces[name];
        if (!entries)
            continue;
        for (const entry of entries) {
            if (entry.internal)
                continue;
            if (!entry.mac || entry.mac === '00:00:00:00:00:00')
                continue;
            return entry.mac.toLowerCase();
        }
    }
    return null;
}
/** 16 lowercase hex characters identifying this machine. */
function machineId() {
    const seed = `${(0, node_os_1.hostname)()}|${(0, node_os_1.platform)()}|${(0, node_os_1.arch)()}|${firstMacAddress() ?? 'no-mac'}`;
    return (0, node_crypto_1.createHash)('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
}
/** Diagnostic view of what the id was derived from (never leaves the machine). */
function machineFingerprint() {
    return {
        id: machineId(),
        hostname: (0, node_os_1.hostname)(),
        platform: (0, node_os_1.platform)(),
        arch: (0, node_os_1.arch)(),
        hasMac: firstMacAddress() !== null,
    };
}
//# sourceMappingURL=machine.js.map