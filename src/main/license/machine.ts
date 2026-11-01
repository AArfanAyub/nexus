/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Machine identity for licence binding (ARCHITECTURE §F.1 T3).
 *
 * `sha256(hostname | platform | arch | first non-internal MAC)`, first 16 hex
 * characters. Deliberately stable across reboots and application upgrades, and
 * deliberately not a hardware serial: a NIC swap must not brick a perpetual
 * licence (decision D-05).
 */

import { createHash } from 'node:crypto';
import { arch, hostname, networkInterfaces, platform } from 'node:os';

/** The first usable MAC address, or `null` when the machine has none. */
function firstMacAddress(): string | null {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces).sort()) {
    const entries = interfaces[name];
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.internal) continue;
      if (!entry.mac || entry.mac === '00:00:00:00:00:00') continue;
      return entry.mac.toLowerCase();
    }
  }
  return null;
}

/** 16 lowercase hex characters identifying this machine. */
export function machineId(): string {
  const seed = `${hostname()}|${platform()}|${arch()}|${firstMacAddress() ?? 'no-mac'}`;
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
}

/** Diagnostic view of what the id was derived from (never leaves the machine). */
export function machineFingerprint(): {
  readonly id: string;
  readonly hostname: string;
  readonly platform: string;
  readonly arch: string;
  readonly hasMac: boolean;
} {
  return {
    id: machineId(),
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    hasMac: firstMacAddress() !== null,
  };
}
