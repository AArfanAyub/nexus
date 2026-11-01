<!-- Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. -->

# DECISIONS

Every place the implementation deviates from `docs/ARCHITECTURE.md`, or makes a
call the architecture left open, with the reason. One line each, newest last.
`docs/PERF.md` holds the measurements these decisions were argued from.

## Foundation

| # | Decision | Why |
|---|---|---|
| D-01 | **`sql.js` (SQLite compiled to WebAssembly) instead of `better-sqlite3`** | A native module has to be rebuilt per Electron ABI and per Node version, and a failed rebuild is a white screen on the customer's machine. The wasm build has no toolchain, no `node-gyp`, no postinstall. The price is an in-memory image plus an explicit flush, which `connection.ts` owns. |
| D-02 | **The preload is bundled to a single CommonJS file by Vite**, not emitted by `tsc` | `sandbox: true` means a preload may only `require('electron')`, so the allow-list in `shared/channels.ts` has to be inlined at build time. A `tsc` emit would `require` it and fail at runtime. |
| D-03 | **`flushNow()` is called explicitly by scripts, not left to the debounce** | The 200 ms debounce is `unref()`'d on purpose, so a process that exits promptly persists nothing. Any script that generates data and exits must flush; `scripts/perf.mjs` does, and says so. |
| D-04 | **The database is an in-memory image, so `EXPLAIN QUERY PLAN` is the only cheap profiler** | No file to open in `sqlite3` while the app runs. `scripts/probe-sql.mjs` exists so a query can be judged against a real 300 000-line database in seconds. |

## Contract and transport

| # | Decision | Why |
|---|---|---|
| D-05 | **`SELF_AUDITING_CHANNELS`** — a channel may bypass the dispatcher's automatic transaction | Two unrelated reasons land a channel there: its evidence must survive a rollback (`backup.restore`), or its handler cannot be synchronous (`backup.run` reads a second database). An async handler on a mutating channel is refused with `INTERNAL`; T10-18 pins the classification. |
| D-06 | **`payment_allocations` is polymorphic** (`doc_type`, `doc_id`), with no `invoice_id` column | One allocation table serves invoices, bills and credit notes. Any code that joins on `invoice_id` is wrong — two such joins shipped and were caught by the dashboard throwing on every load. |
| D-07 | **`READ_ONLY_CHANNELS` bypass the transaction too**, but for the opposite reason | A report over 300 000 lines must not open a write transaction; the dispatcher would otherwise make every read a write. |

## Removed code

| # | Decision | Why |
|---|---|---|
| D-08 | **`DataTable.tsx` deleted (395 lines) rather than kept "for later"** | `OpsTable` does server-side paging, which is the only paging that survives 10 000 customers. An unused client-side table is a trap: the next person to need a table finds it first, uses it, and ships a page that loads every row. |
| D-09 | **`Chart.impl.tsx` is *not* dead** | `Chart.tsx` loads it with `lazy(() => import('./Chart.impl'))`, so `recharts` stays out of the initial bundle. A grep for importers will not see it; a grep for `Chart.impl` will. |

## Finance

| # | Decision | Why |
|---|---|---|
| D-10 | **`journal_lines.posted_date`** (migration v6) — a copy of the entry's date, `NULL` while the entry is a draft | The trial balance over 300 000 lines took 1.5 s because it had to descend into 150 000 parent entries; the date lived on the other side of the join and no index could help. With the date on the line it is one range scan (measured in `PERF.md`). A posted entry is immutable and the draft → posted transition writes both rows in one transaction, so the copy cannot drift — T11-01 asserts it. |
| D-11 | **`archive_balances` rollup** (migration v7) | `archivedBalances()` parsed every archive payload and carried `LIMIT 5000` with no `ORDER BY`. A 100 000-entry archive was therefore reported at 5 % — and it still "balanced", because both sides were truncated equally. Aggregating at archive time is exact, and makes a report after housekeeping faster than before it. |
| D-12 | **Archiving deletes documents before the ledger entries they point at** | Six tables carry a `journal_entry_id` foreign key. The old order moved `journal_entries` first, so "archive everything older than last year" failed with a bare `FOREIGN KEY constraint failed` the moment a settled invoice still pointed at its entry. |
| D-13 | **A reversal pair is never archived** | `reverses_id` is a self-reference: deleting one half while the other is live violates the constraint, and deleting both needs an order the FK check cannot express. Reversals are rare, so they stay in the hot table — no measurable cost, and the audit trail stays whole. |
| D-14 | **`credit_note` prints through the invoice template** | A credit note is an invoice with negative quantities; a second template would be a second thing to keep in step. The document type selects the heading and the sign, nothing else. |

## Search

| # | Decision | Why |
|---|---|---|
| D-15 | **Every searched column has a `COLLATE NOCASE` index** (migration v8) | `LIKE 'prefix%'` is case-insensitive by default, and SQLite only uses an index for it when the index was built `NOCASE`. Without it every source was a full table scan: 88 ms for one invoice lookup, 537 ms for the palette. `case_sensitive_like = ON` would have fixed the speed and broken `acme` → `Acme Industries`. |
| D-16 | **Documents are found by number, not by the customer's name** | `WHERE i.number LIKE ? OR c.name LIKE ?` cannot use either index — SQLite cannot split an `OR` across a join — and measured 454 ms of a 537 ms search on 100 000 invoices. The customer is still one keystroke away, because the customer row is its own source and its own hit. |
| D-17 | **The `%term%` fallback is opt-in per source and scans one column** | A substring scan visits every row, so it is a courtesy for master data only (documents would cost 270 ms a scan) and it tests the human-readable name only: a code is typed from its start, and a second predicate doubled the worst case from 50 ms to 108 ms. |

## Deliberate omissions

| # | Decision | Why |
|---|---|---|
| D-18 | **No full-text index (FTS5)** | It would be the right answer for substring search over documents, but it is a second source of truth that has to be kept in step with every insert, and the budget is already met without it. Recorded here so the next person knows it was considered. |
| D-19 | **No client-side table component at all** | See D-08. Server-side paging is the only paging that holds at 10 000 rows, so the only table in the renderer is the one that speaks to a paged channel. |

## Branding and packaging

| # | Decision | Why |
|---|---|---|
| D-20 | **The identity is inline SVG, not an image file** | The supplied logo hard-codes `#1E1B4B` for the wordmark, which vanishes on the dark theme. `NexusMark` / `NexusLogo` draw the same geometry with the gradient in `--brand-from`/`--brand-to` and the wordmark in `currentColor`, so one asset serves both themes and both densities. The gradient id is generated per instance because an SVG `id` is document-global. |
| D-21 | **The icon set is generated by Chromium, not by an image library** | `scripts/make-icon.cjs` renders `build/icon.svg` in an offscreen `BrowserWindow`, resizes with `nativeImage`, and writes the multi-resolution `.ico` container by hand (PNG-compressed entries, 16–256 px). Adding `sharp` or `svgexport` would have put a build-time native dependency into a product whose whole packaging story is "no native modules". |
| D-22 | **`dist/` is no longer in `.gitignore`** | `electron-builder` honours `.gitignore` while assembling `app.asar`. With `dist/` ignored, the first installer shipped **zero application code** — it launched to a blank window while every local test passed. The comment in `.gitignore` records this so nobody re-adds it. |
| D-23 | **Windows executable rewriting is optional, not required** | `rcedit` needs the symlink privilege that `electron-builder`'s signing toolchain unpacking requires; without Developer Mode the build dies with `app-builder.exe process failed`. `signAndEditExecutable: false` produces a working installer at the cost of the file icon. The window/taskbar icon still comes from `resources/icon.png`, so the product looks right in use; only Explorer shows the default icon. |

## Licensing

| # | Decision | Why |
|---|---|---|
| D-24 | **The owner's perpetual code is `arfanayub0`** | The owner asked for one short code that unlocks the product for life on any machine. Signed keys are machine-bound — that is the point of them — so this is a second, separate path: `verifyKey` checks `isMasterKey` before it parses anything, and the code resolves to an Enterprise payload with `machine_id: '*'` (the existing "passes anywhere" marker), 999 seats and no expiry field. |
| D-25 | **The trade-off is accepted, and recorded here** | A ten-character code is guessable. Anyone who learns it unlocks every copy of NEXUS, and there is no revocation because verification is offline. That is acceptable for the owner's own builds and unacceptable for paying customers, which is why the signed path is untouched: a customer key is still Ed25519-signed, still machine-bound, and still refuses another computer. If the code ever leaks, rotate `MASTER_KEY` in `src/main/license/verify.ts` and ship a build — there is no other lever. |
| D-26 | **The activation field accepts both shapes** | The IPC schema required 20+ characters, which rejected the ten-character code before it reached the verifier, and the button was disabled below 20 characters. Both now use 6 as the floor and the verifier is the only authority on what is valid. |
