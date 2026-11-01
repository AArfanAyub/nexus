<!-- Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. -->

# QA RULES — the twenty-five business rules and what proves them

Each rule from `docs/PRD.md` §"Business rules", the artefact that proves it, and
how to re-run that proof. A rule is only listed as covered by a test if a failing
implementation would make that test fail — a test that passes for the wrong
reason is worse than no test.

## How to run the proofs

```bash
npm test                  # 130 assertions: money, dates, contracts, finance, ops,
                          # CRM, dashboard, admin, licence. No Electron needed.
node scripts/gates.mjs    # the four grep gates (hex colours, industry strings,
                          # copyright headers, console.log)
node scripts/e2e-crm.mjs  # 15 steps over the real IPC bridge, real UI
node scripts/e2e-admin.mjs# 14 steps: import → backup → restore → audit
node scripts/probe-all.mjs --port 9260 --login owner:pass   # 39 routes, signed in as owner
node scripts/probe-offline.mjs --port 9260 --login owner:pass  # the offline guarantee
node scripts/perf.mjs     # the scale proof (docs/PERF.md)
```

The E2E drivers need a running Electron with a debugging port:

```bash
env -u ELECTRON_RUN_AS_NODE npx electron . --remote-debugging-port=9224 --user-data-dir=/tmp/nexus-e2e
```

`env -u ELECTRON_RUN_AS_NODE` matters: this shell exports
`ELECTRON_RUN_AS_NODE=1`, and an Electron launched under it runs as plain Node,
where `app.requestSingleInstanceLock` is `undefined` and no window ever appears.

## The rules

| Rule | Statement (short) | Proved by |
|---|---|---|
| **BR-01** | A journal entry posts only if Σ debits == Σ credits | `T05-01` — an unbalanced entry writes **zero** rows and the message names the difference (`Out of balance by 10.00`) |
| **BR-02** | Posted documents are immutable; corrections are reversing entries | `T06-04` — posting twice is idempotent and every field is frozen; `T05-04` — the original is byte-identical after a reversal |
| **BR-03** | A reversal mirrors the lines and links `reverses_id`; the original is untouched | `T05-04` — reversing twice yields two distinct entries, each pointing at the original |
| **BR-04** | Posting into a locked period is refused, naming the lock | `T05-02` — the message contains the lock date and who locked it |
| **BR-05** | Money is integer minor units; never float | `tests/money.test.cjs` — `0.1 + 0.2 === 0.3` exactly, `cents()` refuses a fractional input, `parseCents` never uses `Number` division |
| **BR-06** | Rounding is half-up at the document level only | `tests/money.test.cjs` — three lines of 33.335 total 100.01, not 100.02; `T06-02` — a half-cent boundary rounds up and the document still adds up |
| **BR-07** | A tax-inclusive document back-computes net so net + tax == gross | `T06-01` — net + tax === gross for a range of gross amounts; `tests/money.test.cjs` — the same property at the arithmetic layer |
| **BR-08** | Numbers are gapless per type per year; drafts reserve nothing | `T04-02` — a deleted draft leaves the next posted number unchanged; the preview never consumes |
| **BR-09** | A posted number is never reused or renumbered | `T04-02` (allocation), `T06-04` — the document is frozen, so no renumber path exists |
| **BR-10** | Stock on hand is derived from moves; no quantity write path | `T07-01` — a transfer keeps company-wide on-hand constant; `T07-06` — valuation is identical before and after a quant rebuild, so the quants are a cache, not a source |
| **BR-11** | Negative stock is blocked without the permission; the override is audited | `T07-02` — refused, naming the available quantity; `T07-03` — allowed with the permission **and** a reason, and an audit row is written |
| **BR-12** | Transfers are two-sided and conserve quantity | `T07-01` — total on-hand unchanged, per-location balances moved |
| **BR-13** | 3-way match: billed ≤ received ≤ ordered, price within both tolerances | `T08-03` — inside tolerance posts; outside becomes an exception; `T08-09` — the posted bill clears its accrual |
| **BR-14** | An exception posts only with the approval permission and a reason | `T08-04` — refused without both, audited with them |
| **BR-15** | Lead conversion is one transaction | `T09-01` (one account, one contact, one deal), `T09-03` (**forced** failure at the deal insert leaves no account or contact), `T09-04` (preview == commit) |
| **BR-16** | Closing a deal as Lost needs a reason from the list | `T09-08` — refused without a reason; with one, it lands on the deal and on the timeline |
| **BR-17** | Price resolution: contract → customer list → default list → base | `T08-05` — an expired customer list falls through to the default list |
| **BR-18** | An expired quotation needs the override permission to convert | `T08-06` — blocked, then allowed with the permission and an audit row |
| **BR-19** | An allocation may not exceed the open balance | `T06-03` — allocating 1200 to a 1000 invoice is refused and names the available figure |
| **BR-20** | Permissions are enforced in the main process, not the UI | `T02-07` — a viewer calling a user-management channel is rejected; `T02-11` — no session means `AUTH_REQUIRED`; `T10-17` — a viewer is never *offered* a mutating action either |
| **BR-21** | Every mutation writes an audit row; the log is append-only | `T02-10` — the hash chain verifies and tampering is pinpointed; `T10-13` — the viewer filters by entity and action; `T10-15` — the chain still verifies after every mutation in the suite |
| **BR-22** | Deleting a record with downstream documents or history is refused | `src/main/ipc.entity.ts` `deleteEntity` refuses once audit rows exist and points at archive/disable. **Manual step:** delete a customer that has an invoice — the UI shows the refusal, not a silent delete |
| **BR-23** | Base currency and fiscal-year start freeze once anything is posted | `T04-06` — the change is refused with an explanation |
| **BR-24** | Licence checks are offline; a bad signature never destroys data; a clock rollback only warns | `tests/license.test.cjs` — a valid key verifies, a flipped character fails as `VALIDATION`, a key for another machine fails as `LICENSE`; `src/main/services/license.ts` records `suspect_clock` from a `.stamp` file and never blocks. **Manual step:** set the clock back a year → banner, app fully usable |
| **BR-25** | Community is fully functional and never nags | `src/main/services/license.ts` — there is no expiry field and no expiry code path; the edition defaults to `community` with its full feature set. **Manual step:** run for 30 days → no nag |

## Gates that are not business rules but are still enforced

| Gate | Enforced by | Why it exists |
|---|---|---|
| No hex colour outside the token files | `scripts/gates.mjs` | A colour typed into a component bypasses the theme and breaks dark mode. The three allow-listed files are the token definitions, native window chrome (no document exists yet) and the PDF template (prints on white paper). |
| No `if (industry` | `scripts/gates.mjs` | Industry differences are data (presets), never branches. One branch and the next preset becomes a code change. |
| Copyright header on every `.ts/.tsx/.css` | `scripts/gates.mjs` | The licence is proprietary; a file without the header is a file whose terms are unstated. |
| No `console.log` in shipped code | `scripts/gates.mjs` | Logs go through `main/log.ts` so they land in a file the operator can send us. |
| No outbound request in the packaged app | `scripts/probe-offline.mjs` | Offline is the product. The driver attaches to every CDP target, walks eight routes, and fails the run on any request that is not `file:`, `devtools:`, `data:` or `blob:` — and on a document whose CSP is not `connect-src 'none'`. |

## Known gaps

- **BR-22 and BR-24 have manual steps, not automated proofs.** The code paths
  exist and are simple enough to read, but no test drives them; adding one is the
  first thing to do next.
- The licence tests that need a real key are `skip`ped when `keys/private.pem` is
  absent, which is the case in a fresh clone. `npm run genkeys` creates it.
