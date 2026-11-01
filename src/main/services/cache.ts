/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * A tiny report cache (requirement R1): an in-main LRU backed by `report_cache`.
 *
 * The dashboard and the trial balance are recomputed on every navigation today,
 * which is fine at 200 rows and not fine at 50 000. Two layers:
 *
 *   - **L1**, a bounded LRU in memory (default 200 entries) — sub-millisecond
 *   - **L2**, `report_cache` with a gzipped payload, so a cold start does not
 *     re-aggregate the ledger before the first paint
 *
 * Invalidation is by **prefix**, and every posting calls
 * `invalidateCache('report:')` from `writeJournal`, so a stale trial balance is
 * impossible rather than merely unlikely. Anything that changes money must
 * invalidate; nothing else needs to.
 */

import zlib from 'node:zlib';

import { nowIso } from '../../shared/dates';
import { conn } from '../db/connection';

interface Entry {
  readonly value: unknown;
  readonly at: number;
  hits: number;
}

const MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 60_000;

/** Insertion-ordered map: the first key is the least recently used. */
const lru = new Map<string, Entry>();
let hits = 0;
let misses = 0;

function trim(): void {
  while (lru.size > MAX_ENTRIES) {
    const oldest = lru.keys().next();
    if (oldest.done) return;
    lru.delete(oldest.value);
  }
}

function readPersisted<T>(key: string): T | undefined {
  const row = conn().one<{ payload_gz: Uint8Array; computed_at: string }>(
    'SELECT payload_gz, computed_at FROM report_cache WHERE key = ?',
    [key],
  );
  if (!row) return undefined;
  const age = Date.now() - new Date(row.computed_at).getTime();
  if (age > DEFAULT_TTL_MS * 10) return undefined;
  try {
    return JSON.parse(zlib.gunzipSync(Buffer.from(row.payload_gz)).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

function writePersisted(key: string, value: unknown): void {
  try {
    const payload = zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
    conn().run(
      `INSERT INTO report_cache (key, payload_gz, computed_at, hits) VALUES (?, ?, ?, 0)
       ON CONFLICT(key) DO UPDATE SET payload_gz = excluded.payload_gz, computed_at = excluded.computed_at`,
      [key, payload, nowIso()],
    );
  } catch {
    // A cache that cannot persist is still a working cache.
  }
}

/** Returns the cached value, computing and storing it on a miss. */
export function cached<T>(key: string, ttlMs: number, compute: () => T): T {
  const now = Date.now();
  const entry = lru.get(key);
  if (entry && now - entry.at < ttlMs) {
    hits += 1;
    entry.hits += 1;
    // Refresh recency.
    lru.delete(key);
    lru.set(key, entry);
    return entry.value as T;
  }

  const persisted = entry ? undefined : readPersisted<T>(key);
  if (persisted !== undefined) {
    hits += 1;
    lru.set(key, { value: persisted, at: now, hits: 1 });
    trim();
    return persisted;
  }

  misses += 1;
  const value = compute();
  lru.delete(key);
  lru.set(key, { value, at: now, hits: 0 });
  trim();
  writePersisted(key, value);
  return value;
}

/** Drops every entry whose key starts with `prefix`. Returns how many. */
export function invalidateCache(prefix: string): number {
  let dropped = 0;
  for (const key of [...lru.keys()]) {
    if (key.startsWith(prefix)) {
      lru.delete(key);
      dropped += 1;
    }
  }
  const rows = conn().all<{ key: string }>('SELECT key FROM report_cache');
  for (const row of rows) {
    if (!row.key.startsWith(prefix)) continue;
    conn().run('DELETE FROM report_cache WHERE key = ?', [row.key]);
    dropped += 1;
  }
  return dropped;
}

export function cacheStats(): { readonly entries: number; readonly hits: number; readonly misses: number } {
  return { entries: lru.size, hits, misses };
}

/** Test hook: forget everything, including the counters. */
export function resetCache(): void {
  lru.clear();
  hits = 0;
  misses = 0;
}
