<!-- Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. -->

# Changelog

All notable changes to NEXUS. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version numbers are
`MAJOR.MINOR.PATCH` and this project has not yet had a 1.x-breaking change.

## [1.0.0] — 2026-10-31

First release. Offline-first ERP + CRM for a small business: one Windows
application, one SQLite file, no server, no network access at runtime.

### Branding

- **NEXUS identity** — the supplied hexagon/node-network mark ships as inline SVG
  (`NexusMark`, `NexusLogo`): gradient in `--brand-from`/`--brand-to`, wordmark in
  `currentColor` so it is indigo-black on light and off-white on dark. Used in the
  sidebar, the login card (with the "Where your business connects" tagline) and the
  window/taskbar icon.
- **Generated icon set** — `scripts/make-icon.cjs` renders `build/icon.svg` through
  Chromium and writes a 7-resolution `icon.ico` plus `icon.png`, with no image
  dependency added to the bundle.

### Finance

- **Chart of accounts** with the six account types, hierarchical codes, and a
  per-preset default chart.
- **Journals** — manual entries, drafts, posting, and reversal. An entry posts
  only if it balances (BR-01); a posted entry is immutable and is corrected by a
  reversing entry that links back through `reverses_id` (BR-02, BR-03).
- **Fiscal years and periods**, with per-period locks that refuse a posting and
  name the lock (BR-04).
- **Invoices, bills, credit notes and payments**, with line-level tax, per-line
  half-even rounding and half-up document totals (BR-06, BR-07).
- **Payment allocation** across invoices and bills, refusing to over-allocate
  and naming the available figure (BR-19).
- **Reports**: trial balance, profit and loss, balance sheet, general ledger with
  a running balance, and a cash-flow view. All are computed in SQL over posted
  lines and are balanced as a check, not an assumption.
- **Gapless document numbering** per type per fiscal year, allocated at posting
  so a deleted draft burns nothing (BR-08, BR-09).

### Inventory

- **Products, units of measure and warehouses**, with quantities held as
  milli-units so 0.001 of a unit is exact.
- **Stock moves** — receipt, issue, transfer, adjustment — as the only writer of
  quantity. On-hand is derived, never stored (BR-10).
- **Negative-stock control** with a permissioned, reasoned override that is
  audited (BR-11); transfers are two-sided and conserve quantity (BR-12).
- **FIFO valuation** with cost layers, and a valuation report that is identical
  before and after a quant rebuild.

### Purchasing

- **Vendors, purchase orders and goods receipts**, with partial receipts.
- **Three-way match** on quantity and price, with both a percentage and an
  absolute tolerance, producing an exception rather than a silent pass (BR-13).
- **Exception approval** behind a permission and a mandatory reason (BR-14).

### Sales

- **Customers, quotations, sales orders, deliveries and price lists.**
- **Price resolution** contract → customer list → default list → base price,
  skipping expired lists (BR-17).
- **Quotation expiry** with a permissioned override (BR-18).
- **Credit-limit check** on order confirmation, with a permissioned override.
- **Delivery → invoice** billing only what was delivered, posting COGS from the
  FIFO layers.

### CRM

- **Accounts, contacts, leads, deals, pipelines, stages and activities.**
- **Lead conversion** in one transaction — account, contact and deal all commit
  or none do — with a preview that promises exactly what the commit creates
  (BR-15).
- **Kanban pipeline** with per-column aggregates that equal the sum of the cards
  beneath them, and a `perColumn` cap that never distorts the totals.
- **Lost reasons** from a configured list (BR-16); won-stage closure sets
  `won_at` and the deal's probability follows its stage.
- **Analytics** — win rate, average cycle (null, not zero, when nothing has been
  won), leaderboard and loss reasons — over a period whose boundaries are
  inclusive at both ends.

### Data and documents

- **Import wizard** — template, parse, validate, preview, commit — with
  per-row errors, duplicate detection inside the file and against the database,
  and a refusal to commit the same batch twice.
- **Export** of any list to CSV.
- **Custom fields** on master data, with a required-field rule (BR-23-adjacent).
- **PDF documents** rendered offscreen with `printToPDF`, and a print route that
  shows the same document the PDF contains.
- **Backup and restore** with a manifest carrying a SHA-256 of the file, a
  schema-version guard, and a pre-restore copy so a restore can be undone.
- **Archive** of closed history into a compressed cold store, restorable
  record-by-record and verifiable by hash.

### System

- **Users and roles** with six presets, scrypt password hashing, account lockout
  after five failures, and permissions enforced in the main process (BR-20).
- **Audit log** — append-only and hash-chained, so a deleted or edited row is
  detectable, with a filterable viewer and a field-level diff (BR-21).
- **Licence activation** offline with Ed25519 keys, machine binding checked only
  after the signature, and a clock-rollback warning that never blocks (BR-24).
  The community edition is complete for its module set and has no expiry path
  (BR-25).
- **Industry presets** — seven of them — as data: a preset writes a chart of
  accounts, taxes, a pipeline and a module set, and no business logic branches on
  an industry string.
- **Dashboard** with KPIs, sparklines, period comparison and a warm cache.
- **Global search and a ⌘K palette** over thirteen sources, prefix-first with a
  capped substring fallback.

### Performance

- A 10 000-customer, 10 000-product, 100 000-invoice, 300 000-line company is
  the reference dataset. Every list query, the trial balance, global search and
  cold start are measured against it in `docs/PERF.md`, and the budgets are met.

### Notes

- The database is a single file at `%APPDATA%\nexus\nexus.db`, written
  atomically (export → tmp → fsync → rename).
- The application makes **no network request at runtime**. There is no updater,
  no telemetry and no remote licence check.

## [1.0.1] — 2026-10-31

### Added

- **MYR (Malaysian ringgit) and 19 other currencies** ship in the box, and
  migration **v10** backfills the catalogue into companies created before it
  existed (their base currency and rates are untouched). The
  catalogue lives in `src/shared/currencies.ts` (code, name, symbol, decimals) and
  is seeded on every install, so a company can quote in MYR from the first
  invoice. MYR is the default base currency in onboarding; `RM` and 2 decimals are
  recorded on the currency row rather than inferred from the code.
- **"Your books are empty" card on the dashboard.** When a company has no
  invoices, bills, entries, stock moves, deals or customers, the dashboard says so
  and offers *Load demo data* or *Create an invoice*. Before this, an empty
  install (or one where demo data had been removed) showed six zeroes and every
  list empty, which reads as a broken application rather than an empty ledger.

### Fixed

- **Currency rows had no name or symbol.** The base currency was inserted with
  its code in all three columns, so Settings → Currencies showed `MYR / MYR / MYR`
  instead of `Malaysian ringgit / RM`.
- **A duplicate "Select page" control** sat next to the density toggle in the
  invoice and bill toolbars, duplicating the header checkbox and reading like a
  label when disabled.
- **A flat KPI delta rendered as a filled square and "0.0 %"** — it now reads
  "no change".
- **The invoice toolbar's date filters had no visible labels** (only `aria-label`),
  so two bare date inputs appeared stacked under the header.

### Tooling

- `scripts/probe-all.mjs` — walks every route over CDP and reports blank, stuck
  or erroring pages separately, with the page text dumped per route.
- `scripts/capture.mjs` — screenshots routes after signing in.
- `scripts/video-frames.cjs` — samples frames from a screen recording through
  Chromium, for reviewing a bug report without ffmpeg.

## [1.0.2] — 2026-11-01

Three create flows were dead and one settings panel could not save. All four are
fixed, with the root cause addressed rather than the symptom.

### Fixed

- **Stock moves, goods receipts and price-list lines could not be created.** The
  three screens asked `entity.list` for `limit: 500`, the validator caps a page at
  `200`, and the rejection was swallowed by the query hook — so the location and
  product dropdowns rendered empty and the only feedback was "a destination
  location is required" on submit. The cap now lives in one exported constant
  (`MAX_PAGE_SIZE` in `src/shared/types.ts`) used by both the validator and every
  caller, a failed lookup renders an inline error instead of an empty select, and
  `tests/page-size.test.cjs` scans the renderer so a literal above the cap fails
  the suite.
- **A currency could not be added.** `entity.save` hardcoded `id` for the
  existence check, the `UPDATE … WHERE` and the INSERT column list, but
  `currencies` is keyed by `code`, so every save failed with
  `table currencies has no column named id`. The save path now reads the real
  primary key from `PRAGMA table_info`, and a natural key makes the call an upsert.
  `Settings → Currencies` gained the missing **Add currency** form (code, name,
  symbol, decimals, rate) — previously the panel offered only "Make base".
- **Settings sub-tabs ignored the route.** `/settings/currencies` and
  `/settings/import` rendered the tax panel because the tab was seeded into
  `useState` from a prop that React only read on mount. The route is now the single
  source of truth and the heading names the tab.
- **`/settings/roles` crashed on a direct load.** `entity.list` returns raw
  snake_case rows (`permissions_json`) but was cast to `Role`, so
  `selected.permissions.length` threw, and the permission catalogue's
  `{key,label,risk}` objects were rendered as React children (error #31).
- **A crashed renderer left a blank window with an empty log.** `render-process-gone`,
  `unresponsive` and `child-process-gone` are now handled: each writes to
  `logs/main.log` and offers Reload/Quit; GPU and utility-process crashes rebuild
  the window once behind a 30-second cooldown.
- **The shipped build carried the development CSP.** `connect-src` still permitted
  `ws://localhost:5173` because `onHeadersReceived` never fires for a `file://`
  load and the meta tag was the dev one. The policy now lives in
  `src/shared/csp.ts`, a Vite plugin rewrites it at build time and throws if the tag
  is missing; verified `connect-src 'none'` with zero outbound requests.

### Verification

`npm test` **151/151** · typecheck clean · `probe-all` **39 routes, 0 problems** ·
stock move posts and moves on-hand 30 000 → 35 000 milli-units with a matching
`stock_moves` row · `TWD` added through the UI and read back from `currencies`.

## [1.0.3] — 2026-11-01

### Added

- **Owner perpetual code.** `arfanayub0` (any case, spaces ignored) activates
  Enterprise on any machine, with no expiry. It is checked before key parsing and
  resolves to `machine_id: '*'`, so it is not bound to a computer the way customer
  keys are. Signed customer keys are unchanged and still machine-bound.
- `tests/license.test.cjs` covers the code: correct edition, perpetual payload,
  case/space tolerance, acceptance on a different machine, and rejection of
  near-misses (`arfanayub`, `arfanayub01`, `arfanayubO`, `arfanayub0x`).

### Fixed

- The activation field rejected anything under 20 characters and disabled the
  button below that, which would have blocked the owner code before the verifier
  ever saw it. The floor is now 6 and the verifier decides.
