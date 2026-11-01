<!-- Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. -->

# NEXUS — Scale & Performance Proof

| Field | Value |
|---|---|
| **Requirement** | 10,000+ customers, 10,000+ products, 100,000 invoices must stay interactive |
| **Harness** | `node scripts/perf.mjs` (drives the real services against a throwaway SQLite image) |
| **Reproduce** | `npm run build:main && node scripts/perf.mjs` — deterministic (`mulberry32`, fixed seed) |
| **Verdict** | **PASS** — every budget met |

> Every figure below was re-measured on the shipping code after migrations v5–v9.
> An earlier edition of this document quoted 5.4 ms / 132.4 ms / 12.6 ms from the
> pre-v6 build; those numbers were not reproducible on the current code and are
> replaced rather than kept alongside.

## 1. Test machine

| | |
|---|---|
| OS | Windows 11 x64 |
| CPU | Intel Core i7-10750H @ 2.60 GHz — 12 threads |
| RAM | 15.8 GB |
| Runtime | Node v22.22.2 · Electron 33.4.11 |
| Storage engine | sql.js 1.11.0 (SQLite compiled to WebAssembly, in-memory image, atomic file persist) |

This is a five-year-old laptop CPU, not a benchmark rig. The wasm build is also
the slowest plausible engine for this workload — roughly 5–10× native SQLite per
row visited — so these numbers are a floor for the hardware class, not a ceiling.

## 2. Dataset generated

| Entity | Rows |
|---|---|
| Customers | 10 000 |
| Products | 10 000 |
| Invoices (+ lines) | 100 000 (three years, 90 000 settled) |
| Journal entries | 150 000 |
| Journal lines | **300 000** |
| Database file | ~242 MB |
| **Total generation** | **131.5 s** (single transaction) |

Generation is a one-time operation behind `settings.perf.generate` (owner-only).
It is not part of normal use; it exists so a customer can prove the product scales
on their own hardware before importing real data. The figure is up from 89 s
before v9 — that is the write cost of the indexes, and it is discussed in §6.

## 3. Measured latency

Budgets are from `ARCHITECTURE.md §G` and the customer requirement. Each figure is
a warm query. The verdict is **strict**: the budget has to hold on the whole
300 000-line dataset *and* after archiving, so a regression cannot hide behind the
smaller post-archive number.

| Operation | Budget | Before archive | After archive | Verdict |
|---|---|---|---|---|
| Customer list, page 1 (200 rows) | ≤ 120 ms | **6.2 ms** | **1.6 ms** | PASS |
| Customer list, page 900 (`OFFSET 179 800`) | ≤ 120 ms | **1.8 ms** | **0.9 ms** | PASS¹ |
| Invoice KPI — `SUM(total_cents)` over 100k invoices | ≤ 150 ms | **19.0 ms** | **7.1 ms** | PASS |
| Trial balance over 300k journal lines | ≤ 600 ms | **166.2 ms** | **108.0 ms** | PASS |
| Global search, worst case (no match) | ≤ 80 ms | **17.5 ms** | **10.4 ms** | PASS |
| Global search, hit (`Ada` prefix) | ≤ 80 ms | **15.8 ms** | **8.5 ms** | PASS |
| Archive round trip (archive 1 invoice → restore) | ≤ 200 ms | **21.0 ms** | **12.8 ms** | PASS |
| Cold start, packaged, to first paint | ≤ 3 000 ms | **2 168 / 2 435 ms** | — | PASS |

¹ Honest caveat: the customer table holds 10 000 rows, so page 900 is past the end
and returns 0 rows. The measurement prices the `OFFSET 179 800` scan, not a deep
page of real data. Deep paging over a large table is covered by the KPI probe,
which scans the 100 000-row invoice table without a limit.

**Trial balance correctness is asserted, not assumed:** the harness reports
`balanced=true` at both 300 000 and 200 992 lines, and `T11-02` asserts that the
per-account totals are byte-identical before archiving and after a restore. A fast
wrong number is worthless.

## 4. Archive actually shrinks the hot path

The requirement was "compress the data so the system stays fast". Compression alone
is not the win — *moving cold rows out of the hot tables* is.

| | Before archive | After archive | Change |
|---|---|---|---|
| Hot invoices | 100 000 | 66 876 | −33 % |
| Hot journal lines | 300 000 | 200 992 | −33 % |
| Customer page 1 | 6.2 ms | 1.6 ms | −74 % |
| Invoice KPI | 19.0 ms | 7.1 ms | −63 % |
| Trial balance | 166.2 ms | 108.0 ms | −35 % |
| Global search | 17.5 ms | 10.4 ms | −40 % |

Archiving **181 636 rows takes 92.8 s**. That is a maintenance action run from
Settings with a date cutoff, not an interactive one, and it runs inside one
transaction so a failure leaves the database untouched.

Archived rows are gzip-compressed JSON blobs with a SHA-256 of the original row, in
`archive_records`. 33 124 invoices compress to **11.2 MB** and 49 504 journal
entries to **24.7 MB** — roughly 4–5× smaller than the live rows plus their
indexes. A restore round-trip is verified byte-identical in `tests/t10.test.cjs`
(R1-02), and `T11-02` verifies that archiving and restoring leave the trial
balance totals untouched.

## 5. Why it stays fast

1. **No table is ever read whole into the renderer.** Every list channel takes
   `{page, pageSize ≤ 200, sort, filters}` and returns `Paged<T>` with `total`. The
   renderer holds one page.
2. **Indexes match the filters people actually use** — status + due date, customer
   + date, account + entry, stage + owner, activity due/done, SKU, move date, audit
   time (v2, extended in v3/v4), plus the scale indexes in v5 and the foreign-key
   indexes in v9 that make deletion proportional to what a row references.
3. **Search is prefix-first on a `COLLATE NOCASE` index** (v8), with a `%q%`
   fallback capped at 200 rows and limited to master data, `ESCAPE '\'` declared on
   every clause, and a 300 ms debounce.
4. **Documents are searched by number, not by customer name.** An `OR` across a
   join cannot use either index; it was 454 ms of a 537 ms search on 100 000
   invoices.
5. **The ledger line carries its posting date** (v6), so a dated report is one
   range scan instead of one b-tree descent per entry.
6. **Reports are cached** (`report_cache` + in-main LRU) and invalidated by prefix
   on every posting, so navigation between reports does not re-aggregate 300k lines.
7. **Money and quantities are integers** (cents, milli-units) — no float formatting
   or rounding in the hot path.
8. **Persistence is debounced** (200 ms) and atomic (`export()` → temp file →
   `renameSync`), so a burst of writes costs one file write, not one per row.

## 6. What the indexes cost, and what the migrations cost

Indexes are not free on write. Generating the full dataset went from 89 s (v5) to
131 s (v9): about 1.5× the insert cost for 25× faster reads. A user posting 100
documents a day will never notice; the read path is what they look at all day.

Migrations are the slowest thing the product ever does, so the cost is recorded
rather than discovered by a customer:

| Migration | On | Time |
|---|---|---|
| v6 `ledger-line-posted-date` (backfill of every line) | 300 000 lines | **5.0 s** |
| v7 + v8 (rollup table + 18 `NOCASE` indexes) | 300 000 lines | **2.3 s** |
| v9 (7 foreign-key indexes) | 300 000 lines | < 1 s |

The v6 backfill is one `UPDATE` over every line and is the most expensive
migration this product ships. On a 10 000-line company it is imperceptible.

## 7. Reproducing this table

```bash
cd nexus
npm run build:main
node scripts/perf.mjs --json > perf.json
```

To keep the generated dataset between runs (so an index change can be measured
without rebuilding):

```bash
NEXUS_PERF_DB=/path/to/nexus-perf.db node scripts/perf.mjs
```

Three probes exist because a single number is not actionable:

| Script | Answers |
|---|---|
| `scripts/perf.mjs` | *that* a query is too slow |
| `scripts/probe-sql.mjs <db> <file.sql>` | *why* — plan plus timings, per statement |
| `scripts/probe-search.mjs <db> <term>` | which of the thirteen search sources costs what |
| `scripts/probe-archive.mjs <db>` | per-table archive time (how the foreign-key scans were found) |

## 8. What is not measured here

| Area | Status |
|---|---|
| Concurrent writers | There are none: the app takes a single-instance lock and is one process with one database file |
| A 1 000 000-line ledger | 300 000 is the stated budget. Extrapolation from a covering-index range scan is linear, but it has not been run |
| Windows filesystem variance | The database is written `export → tmp → fsync → rename`; on a slow or network drive that write dominates every number here, and none of these figures include it |
| Cold start after a fresh install | Windows Defender scans the executable once; the 2.2–2.4 s above is a warm-disk launch |
| Renderer frame rate while scrolling | Lists are paginated at 200 rows, so the 10k-row scroll problem the original spec anticipated does not arise. Server-side paging replaced hand-rolled virtualisation (see `DECISIONS.md`) |
| PDF generation | ~400–700 ms per A4 document (Chromium print pipeline); batch printing is sequential by design to bound memory |
| Import of 10k rows | Batched at 500 rows per transaction with `job:progress` events; the UI stays responsive, wall clock ~6–9 s |
