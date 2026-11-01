/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Server-state cache (ARCHITECTURE §E.5).
 *
 * One `Map<key, entry>` for the whole renderer. Guarantees that matter:
 *   - **dedupe**: two components asking for the same key while a call is in
 *     flight share that one promise (T03 acceptance #8);
 *   - **stale-while-revalidate**: a fresh-enough value is served immediately and
 *     refreshed in the background, so navigation never blanks a table;
 *   - **invalidate(prefix)** refetches only keys that start with the tag, which
 *     is how `invalidate('invoices')` avoids a full reload.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, isApiError } from './api';

interface Entry {
  data: unknown;
  at: number;
  error: ApiError | null;
  promise: Promise<unknown> | null;
  version: number;
}

const cache = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

const DEFAULT_STALE_MS = 30_000;

function entryFor(key: string): Entry {
  const existing = cache.get(key);
  if (existing) return existing;
  const created: Entry = { data: undefined, at: 0, error: null, promise: null, version: 0 };
  cache.set(key, created);
  return created;
}

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

function subscribe(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** Starts (or joins) the fetch for `key`. Never rejects — errors land on the entry. */
function load<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const entry = entryFor(key);
  if (entry.promise) return entry.promise as Promise<T>;

  const promise = fetcher()
    .then((data) => {
      const current = entryFor(key);
      current.data = data;
      current.at = Date.now();
      current.error = null;
      current.promise = null;
      current.version += 1;
      notify(key);
      return data;
    })
    .catch((error: unknown) => {
      const current = entryFor(key);
      current.error = isApiError(error)
        ? error
        : new ApiError({ code: 'INTERNAL', message: 'That request failed. Try again.' });
      current.promise = null;
      current.version += 1;
      notify(key);
      throw current.error;
    });

  entry.promise = promise;
  return promise;
}

export interface QueryResult<T> {
  readonly data: T | undefined;
  readonly error: ApiError | null;
  readonly loading: boolean;
  readonly stale: boolean;
  readonly refresh: () => void;
}

export interface QueryOptions {
  /** How long a value is served without a background refresh. */
  readonly staleMs?: number;
  /** When false the query is not started (e.g. no id yet). */
  readonly enabled?: boolean;
}

/**
 * Reads `key` from the cache, starting a fetch when needed.
 * The fetcher identity is intentionally ignored: the key is the contract.
 */
export function useQuery<T>(key: string, fetcher: () => Promise<T>, options: QueryOptions = {}): QueryResult<T> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const enabled = options.enabled ?? true;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [version, setVersion] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribe(key, () => setVersion((value) => value + 1));
  }, [key, enabled]);

  // Registered so `invalidate` can re-run a query that still has a subscriber.
  useEffect(() => {
    if (!enabled) return;
    rememberFetcher(key, () => fetcherRef.current());
  }, [key, enabled]);

  void version;

  useEffect(() => {
    if (!enabled) return;
    const entry = cache.get(key);
    const fresh = entry && Date.now() - entry.at < staleMs && entry.error === null;
    if (entry && (entry.promise || fresh)) return;
    void load(key, () => fetcherRef.current()).catch(() => undefined);
  }, [key, enabled, staleMs, tick]);

  const refresh = useCallback(() => {
    const entry = cache.get(key);
    if (entry) {
      entry.at = 0;
      entry.promise = null;
    }
    setTick((value) => value + 1);
  }, [key]);

  const entry = cache.get(key);
  const data = entry?.data as T | undefined;
  const error = entry?.error ?? null;
  const loading = enabled && !entry?.data && !error && Boolean(entry?.promise);

  return {
    data,
    error,
    loading: loading || (enabled && !entry),
    stale: Boolean(entry && entry.at > 0 && Date.now() - entry.at > staleMs),
    refresh,
  };
}

/**
 * Marks every key starting with `prefix` as stale and refetches the ones that
 * still have a mounted subscriber. Returns how many keys were touched.
 */
export function invalidate(prefix: string): number {
  let touched = 0;
  for (const [key, entry] of cache) {
    if (key !== prefix && !key.startsWith(`${prefix}:`) && !key.startsWith(prefix)) continue;
    entry.at = 0;
    entry.promise = null;
    touched += 1;
    if (listeners.has(key)) {
      const fetcher = refetchers.get(key);
      if (fetcher) void load(key, fetcher).catch(() => undefined);
      notify(key);
    }
  }
  return touched;
}

/** Remembers how to refetch a key so `invalidate` can refresh live views. */
const refetchers = new Map<string, () => Promise<unknown>>();

/** Writes a value straight into the cache (optimistic patch). */
export function setQueryData<T>(key: string, updater: T | ((current: T | undefined) => T)): void {
  const entry = entryFor(key);
  entry.data = typeof updater === 'function' ? (updater as (c: T | undefined) => T)(entry.data as T | undefined) : updater;
  entry.at = Date.now();
  entry.error = null;
  entry.version += 1;
  notify(key);
}

/** Reads a cached value without subscribing (used by event handlers). */
export function getQueryData<T>(key: string): T | undefined {
  return cache.get(key)?.data as T | undefined;
}

/** Clears everything. Called on logout so the next user sees no stale rows. */
export function clearQueryCache(): void {
  cache.clear();
  refetchers.clear();
  for (const [key] of listeners) notify(key);
}

/** Registers the fetcher for a key so `invalidate` can re-run it. Internal. */
export function rememberFetcher(key: string, fetcher: () => Promise<unknown>): void {
  refetchers.set(key, fetcher);
}

/** Test hook: the number of keys currently cached. */
export function cacheSize(): number {
  return cache.size;
}
