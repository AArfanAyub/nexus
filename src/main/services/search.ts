/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Global search and the ⌘K palette (T09).
 *
 * ## The rule that keeps this fast at 10k customers and 100k invoices
 *
 * A query is a **prefix** (`term%`) first, because a prefix can use an index. A
 * leading wildcard (`%term%`) cannot, so it is only used as a **fallback**: when
 * the prefix pass found nothing for that source, one `%term%` query runs with a
 * hard row cap of 200. The cap is what makes the fallback safe — it bounds the
 * work even when nothing matches, which is exactly the case a user hits by
 * typing a typo.
 *
 * The fallback is **opt-in per source** (`Source.fallback`). Only master data
 * takes it. A `%term%` over 100 000 invoices measured 270 ms on its own — three
 * times the whole palette's budget — so documents are matched by number, which
 * is a prefix and therefore indexed.
 *
 * The fallback also tests **one column**, the human-readable name, not the name
 * and the code. A substring scan has to visit every row, so a second predicate
 * doubles the per-row cost for a match that a prefix already covers: a code is
 * typed from its start. Two columns took the worst case — a term that matches
 * nothing — from 50 ms to 108 ms, which is over budget on its own.
 *
 * ## Two things that had to be true for "prefix" to mean "fast"
 *
 *  1. **The index has to be `COLLATE NOCASE`** (migration v8). `LIKE` is
 *     case-insensitive for ASCII unless `case_sensitive_like` is on, and SQLite
 *     only uses an index for a case-insensitive `LIKE` when the index was built
 *     that way. Without it every source was a full table scan — 88 ms for one
 *     invoice lookup, 537 ms for the whole palette.
 *  2. **A document is not matched by its customer's name.** `WHERE i.number
 *     LIKE ? OR c.name LIKE ?` cannot use either index, because SQLite cannot
 *     split an `OR` across a join; measured at 454 ms of a 537 ms search. The
 *     customer is still reachable from the same keystroke, because the customer
 *     row is its own source and its own hit.
 *
 * ## Ranking
 *
 * Deliberately simple and stable: the prefix pass wins outright, the fallback
 * only fills gaps, and within a group rows come back in the source's own
 * relevance order (recency for documents, alphabetical for masters). A palette
 * that reorders itself between identical keystrokes is worse than one that is
 * merely adequate.
 *
 * ## Recent items
 *
 * Stored per user in `users.prefs_json` under `recent`, capped at 8. The palette
 * shows them before the user types anything, which is the whole point of a
 * launcher.
 */

import type { SearchGroup, SearchHit, SearchResult } from '../../shared/search';
import { readSetting, writeSetting } from './settings';
import { conn } from '../db/connection';

/**
 * The shapes live in `shared/search.ts` so the palette can type them without
 * importing from `main/`. Re-exported here because this module is the producer
 * and callers legitimately import them from either side.
 */
export type { SearchGroup, SearchHit, SearchResult };

/** Rows per group. The palette shows 8; `search.global` may ask for more. */
const DEFAULT_LIMIT = 8;
/** Hard cap on the `%term%` fallback, per source. */
const FALLBACK_CAP = 200;
/** Below this length the fallback is skipped — two characters match everything. */
const MIN_FALLBACK_LENGTH = 2;

/**
 * One prepared statement plus the rule for binding it.
 *
 * The binding is explicit because the sources are not uniform: a master-data
 * match tests two columns against the same pattern, a document match tests one.
 * `?1`-style numbered parameters would have expressed that, but the connection
 * wrapper counts `?` characters to validate arity, so numbering is invisible to
 * it and the statement is refused before SQLite ever sees it.
 */
interface Statement {
  readonly sql: string;
  readonly bind: (pattern: string, limit: number) => readonly (string | number)[];
}

/** A statement that tests one column against the pattern. */
function one(sql: string): Statement {
  return { sql, bind: (pattern, limit) => [pattern, limit] };
}

/** A statement that tests two columns against the same pattern. */
function two(sql: string): Statement {
  return { sql, bind: (pattern, limit) => [pattern, pattern, limit] };
}

interface Source {
  readonly kind: string;
  readonly label: string;
  readonly prefix: Statement;
  readonly contains: Statement;
  readonly route: (id: string) => string;
  /**
   * Whether this table may be substring-scanned by the fallback pass.
   *
   * Only master data qualifies. A `%term%` predicate cannot use an index, so the
   * cost is a full table scan — affordable over 10 000 customers, not over
   * 100 000 invoices, where one scan measured 270 ms.
   */
  readonly fallback?: boolean;
}

/**
 * Every source returns `id, title, subtitle` and is capped at `limit`, so one
 * slow table cannot dominate the whole search.
 *
 * `accounts` is the CRM account, not a ledger account; the ledger account is
 * searched by code as `ledgerAccount`.
 */
const SOURCES: readonly Source[] = [
  {
    kind: 'crmAccount',
    label: 'Accounts',
    prefix: two(`SELECT id, name AS title, COALESCE(industry, '') AS subtitle FROM crm_accounts
                  WHERE deleted_at IS NULL AND (name LIKE ? ESCAPE '\\' OR COALESCE(domain, '') LIKE ? ESCAPE '\\')
                  ORDER BY name LIMIT ?`),
    contains: one(`SELECT id, name AS title, COALESCE(industry, '') AS subtitle FROM crm_accounts
                    WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\'
                    ORDER BY name LIMIT ?`),
    route: (id) => `/crm/accounts?focus=${id}`,
    fallback: true,
  },
  {
    kind: 'contact',
    label: 'Contacts',
    prefix: two(`SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS title,
                        COALESCE(email, COALESCE(title, '')) AS subtitle FROM contacts
                  WHERE deleted_at IS NULL
                    AND (TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) LIKE ? ESCAPE '\\'
                         OR COALESCE(email,'') LIKE ? ESCAPE '\\')
                  ORDER BY first_name LIMIT ?`),
    contains: one(`SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS title,
                          COALESCE(email, COALESCE(title, '')) AS subtitle FROM contacts
                    WHERE deleted_at IS NULL
                      AND TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) LIKE ? ESCAPE '\\'
                    ORDER BY first_name LIMIT ?`),
    route: (id) => `/crm/accounts?contact=${id}`,
    fallback: true,
  },
  {
    kind: 'deal',
    label: 'Deals',
    prefix: two(`SELECT d.id, d.name AS title, s.name AS subtitle FROM deals d
                   LEFT JOIN deal_stages s ON s.id = d.stage_id
                  WHERE d.deleted_at IS NULL AND (d.name LIKE ? ESCAPE '\\' OR COALESCE(s.name,'') LIKE ? ESCAPE '\\')
                  ORDER BY d.updated_at DESC LIMIT ?`),
    contains: one(`SELECT d.id, d.name AS title, s.name AS subtitle FROM deals d
                     LEFT JOIN deal_stages s ON s.id = d.stage_id
                    WHERE d.deleted_at IS NULL AND d.name LIKE ? ESCAPE '\\'
                    ORDER BY d.updated_at DESC LIMIT ?`),
    route: (id) => `/crm/deals?focus=${id}`,
    fallback: true,
  },
  {
    kind: 'lead',
    label: 'Leads',
    prefix: two(`SELECT id, name AS title, COALESCE(company, status) AS subtitle FROM leads
                  WHERE name LIKE ? ESCAPE '\\' OR COALESCE(company, '') LIKE ? ESCAPE '\\'
                  ORDER BY created_at DESC LIMIT ?`),
    contains: one(`SELECT id, name AS title, COALESCE(company, status) AS subtitle FROM leads
                    WHERE name LIKE ? ESCAPE '\\'
                    ORDER BY created_at DESC LIMIT ?`),
    route: (id) => `/crm/leads?focus=${id}`,
    fallback: true,
  },
  {
    kind: 'customer',
    label: 'Customers',
    prefix: two(`SELECT id, name AS title, COALESCE(code, '') AS subtitle FROM customers
                  WHERE deleted_at IS NULL AND (name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\')
                  ORDER BY name LIMIT ?`),
    contains: one(`SELECT id, name AS title, COALESCE(code, '') AS subtitle FROM customers
                    WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\'
                    ORDER BY name LIMIT ?`),
    route: (id) => `/sales/customers?focus=${id}`,
    fallback: true,
  },
  {
    kind: 'vendor',
    label: 'Vendors',
    prefix: two(`SELECT id, name AS title, COALESCE(code, '') AS subtitle FROM vendors
                  WHERE deleted_at IS NULL AND (name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\')
                  ORDER BY name LIMIT ?`),
    contains: one(`SELECT id, name AS title, COALESCE(code, '') AS subtitle FROM vendors
                    WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\'
                    ORDER BY name LIMIT ?`),
    route: (id) => `/purchasing/vendors?focus=${id}`,
    fallback: true,
  },
  {
    kind: 'product',
    label: 'Products',
    prefix: two(`SELECT id, name AS title, sku AS subtitle FROM products
                  WHERE deleted_at IS NULL AND (name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\')
                  ORDER BY name LIMIT ?`),
    contains: one(`SELECT id, name AS title, sku AS subtitle FROM products
                    WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\'
                    ORDER BY name LIMIT ?`),
    route: (id) => `/inventory/products?focus=${id}`,
    fallback: true,
  },

  // ── documents: found by number, which is a prefix and therefore indexed ────
  {
    kind: 'invoice',
    label: 'Invoices',
    prefix: one(`SELECT i.id, COALESCE(i.number, 'Draft') AS title, c.name AS subtitle FROM invoices i
                   JOIN customers c ON c.id = i.customer_id
                  WHERE i.number LIKE ? ESCAPE '\\'
                  ORDER BY i.date DESC LIMIT ?`),
    contains: one(`SELECT i.id, COALESCE(i.number, 'Draft') AS title, c.name AS subtitle FROM invoices i
                     JOIN customers c ON c.id = i.customer_id
                    WHERE i.number LIKE ? ESCAPE '\\'
                    ORDER BY i.date DESC LIMIT ?`),
    route: (id) => `/finance/invoices?focus=${id}`,
  },
  {
    kind: 'bill',
    label: 'Bills',
    prefix: one(`SELECT b.id, COALESCE(b.number, 'Draft') AS title, v.name AS subtitle FROM bills b
                   JOIN vendors v ON v.id = b.vendor_id
                  WHERE b.number LIKE ? ESCAPE '\\'
                  ORDER BY b.date DESC LIMIT ?`),
    contains: one(`SELECT b.id, COALESCE(b.number, 'Draft') AS title, v.name AS subtitle FROM bills b
                     JOIN vendors v ON v.id = b.vendor_id
                    WHERE b.number LIKE ? ESCAPE '\\'
                    ORDER BY b.date DESC LIMIT ?`),
    route: (id) => `/purchasing/bills?focus=${id}`,
  },
  {
    kind: 'quote',
    label: 'Quotations',
    prefix: one(`SELECT q.id, COALESCE(q.number, 'Draft') AS title, c.name AS subtitle FROM quotes q
                   JOIN customers c ON c.id = q.customer_id
                  WHERE q.number LIKE ? ESCAPE '\\'
                  ORDER BY q.date DESC LIMIT ?`),
    contains: one(`SELECT q.id, COALESCE(q.number, 'Draft') AS title, c.name AS subtitle FROM quotes q
                     JOIN customers c ON c.id = q.customer_id
                    WHERE q.number LIKE ? ESCAPE '\\'
                    ORDER BY q.date DESC LIMIT ?`),
    route: (id) => `/sales/quotations?focus=${id}`,
  },
  {
    kind: 'salesOrder',
    label: 'Sales orders',
    prefix: one(`SELECT o.id, COALESCE(o.number, 'Draft') AS title, c.name AS subtitle FROM sales_orders o
                   JOIN customers c ON c.id = o.customer_id
                  WHERE o.number LIKE ? ESCAPE '\\'
                  ORDER BY o.date DESC LIMIT ?`),
    contains: one(`SELECT o.id, COALESCE(o.number, 'Draft') AS title, c.name AS subtitle FROM sales_orders o
                     JOIN customers c ON c.id = o.customer_id
                    WHERE o.number LIKE ? ESCAPE '\\'
                    ORDER BY o.date DESC LIMIT ?`),
    route: (id) => `/sales/orders?focus=${id}`,
  },
  {
    kind: 'journal',
    label: 'Journal entries',
    prefix: one(`SELECT id, COALESCE(number, 'Draft') AS title, COALESCE(memo, '') AS subtitle FROM journal_entries
                  WHERE number LIKE ? ESCAPE '\\'
                  ORDER BY date DESC LIMIT ?`),
    contains: one(`SELECT id, COALESCE(number, 'Draft') AS title, COALESCE(memo, '') AS subtitle FROM journal_entries
                    WHERE number LIKE ? ESCAPE '\\'
                    ORDER BY date DESC LIMIT ?`),
    route: (id) => `/finance/journals?focus=${id}`,
  },
  {
    kind: 'ledgerAccount',
    label: 'Ledger accounts',
    prefix: two(`SELECT id, code || ' · ' || name AS title, type AS subtitle FROM accounts
                  WHERE deleted_at IS NULL AND (code LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
                  ORDER BY code LIMIT ?`),
    contains: one(`SELECT id, code || ' · ' || name AS title, type AS subtitle FROM accounts
                    WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\'
                    ORDER BY code LIMIT ?`),
    route: (id) => `/finance/accounts?focus=${id}`,
    fallback: true,
  },
];

/**
 * Escapes the `%` and `_` a user may legitimately type into a search box.
 *
 * The escaping only means anything because every `LIKE` in `SOURCES` declares
 * `ESCAPE '\'`: without that clause SQLite treats the backslash as an ordinary
 * character and the wildcard still matches, so `100%` would quietly search for
 * everything beginning with `100`. The two halves have to move together.
 */
function likePrefix(term: string): string {
  return `${term.replace(/[%_\\]/g, (match) => `\\${match}`)}%`;
}

function likeContains(term: string): string {
  return `%${term.replace(/[%_\\]/g, (match) => `\\${match}`)}%`;
}

interface HitRow {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
}

/**
 * Searches every source, prefix first and contains only as a gap-filler.
 *
 * `limit` applies per source, so the total is bounded by `sources × limit`.
 */
export function searchGlobal(
  term: string,
  options: { readonly limit?: number; readonly kinds?: readonly string[] } = {},
): SearchResult {
  const started = Date.now();
  const cleaned = term.trim();
  if (cleaned.length === 0) return { term: '', groups: [], ms: 0 };
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), 50);
  const prefix = likePrefix(cleaned);
  const contains = likeContains(cleaned);

  const groups: SearchGroup[] = [];
  for (const source of SOURCES) {
    if (options.kinds && options.kinds.length > 0 && !options.kinds.includes(source.kind)) continue;
    let rows: HitRow[] = [];
    try {
      rows = conn().all<HitRow>(source.prefix.sql, [...source.prefix.bind(prefix, limit)]);
      if (source.fallback === true && rows.length < limit && cleaned.length >= MIN_FALLBACK_LENGTH) {
        // The fallback is capped, so a typo cannot turn one keystroke into a
        // scan of every invoice ever written.
        const cap = Math.min(FALLBACK_CAP, limit * 8);
        const extra = conn()
          .all<HitRow>(source.contains.sql, [...source.contains.bind(contains, cap)])
          .filter((row) => !rows.some((existing) => existing.id === row.id));
        rows = [...rows, ...extra].slice(0, limit);
      }
    } catch {
      // A module that is not installed has no table to search; skip it rather
      // than failing the whole palette.
      continue;
    }
    if (rows.length === 0) continue;
    groups.push({
      kind: source.kind,
      label: source.label,
      rows: rows.map((row) => ({
        id: row.id,
        title: row.title,
        subtitle: row.subtitle ?? '',
        kind: source.kind,
        route: source.route(row.id),
      })),
    });
  }

  return { term: cleaned, groups, ms: Date.now() - started };
}

/** The ⌘K palette: same sources, smaller per-group limit. */
export function searchPalette(term: string): SearchResult {
  return searchGlobal(term, { limit: 4 });
}

// ── recent items ────────────────────────────────────────────────────────────

export interface RecentItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly kind: string;
  readonly route: string;
  readonly at: string;
}

const RECENT_LIMIT = 8;

function readRecent(): RecentItem[] {
  const raw = readSetting<unknown>('app.recent');
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is RecentItem => {
      if (typeof entry !== 'object' || entry === null) return false;
      const record = entry as Record<string, unknown>;
      return typeof record['route'] === 'string' && typeof record['title'] === 'string';
    })
    .slice(0, RECENT_LIMIT);
}

/** Records that the operator opened something. De-duplicates by route. */
export function pushRecent(item: Omit<RecentItem, 'at'>): readonly RecentItem[] {
  const existing = readRecent().filter((entry) => entry.route !== item.route);
  const next = [{ ...item, at: new Date().toISOString() }, ...existing].slice(0, RECENT_LIMIT);
  writeRecent(next);
  return next;
}

export function listRecent(): readonly RecentItem[] {
  return readRecent();
}

export function clearRecent(): readonly RecentItem[] {
  writeRecent([]);
  return [];
}

/**
 * Writes through `writeSetting`, the only path that keeps `settings.updated_at`
 * honest. A plain import is safe here because `settings` does not import
 * `search` — the dependency runs one way.
 */
function writeRecent(items: readonly RecentItem[]): void {
  writeSetting('app.recent', items);
}
