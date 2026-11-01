<!-- Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. -->

# NEXUS

Offline-first ERP + CRM for a small business: accounting, inventory, purchasing,
sales, CRM and reporting in one Windows application, backed by a single SQLite
file. **No server, no cloud, no network access at runtime.**

Electron 33 · React 18 · TypeScript 5 (strict) · `sql.js` (SQLite compiled to
WebAssembly — no native modules, no rebuild step, ever).

---

## What it is

One desktop app that replaces the spreadsheet a small business actually runs on:

| Area | What you get |
|---|---|
| Finance | Chart of accounts, journals, invoices, bills, credit notes, payments, trial balance, P&L, balance sheet, general ledger, fiscal periods |
| Inventory | Products, units of measure, warehouses, stock moves, FIFO cost layers, valuation |
| Purchasing | Vendors, purchase orders, goods receipts, three-way match with tolerances |
| Sales | Customers, quotations, sales orders, deliveries, price lists, credit limits |
| CRM | Accounts, contacts, leads (with one-click conversion), deals, kanban pipeline, activities, analytics |
| Data | Import wizard, CSV export, custom fields, numbering, taxes, currencies, backup/restore, archive |
| System | Users, roles and permissions, hash-chained audit log, offline licence |

The rules it enforces are the ones an accountant would check first: nothing posts
unbalanced, posted documents are immutable, numbers are gapless, stock is derived
from moves, and every mutation is in the audit log. `docs/QA-RULES.md` lists all
twenty-five with the test that proves each.

## Install

Download from the release page and run one of:

- **`NEXUS Setup 1.0.0.exe`** — NSIS installer. Installs per user, creates a Start
  menu entry and a desktop shortcut.
- **`NEXUS 1.0.0.exe`** — portable. No installation; copy it anywhere and run it.
  Data still goes to `%APPDATA%\nexus`, so the portable build and the installed
  build see the same company if you use both.

Windows 10/11 x64. There is no code signing certificate, so SmartScreen will warn
on first run: **More info → Run anyway**.

## First run

1. The **setup wizard** asks for your company name, tax id, base currency, fiscal
   year start and your own administrator account. Nothing is written until you
   finish the last step — a failure anywhere rolls the whole thing back.
2. Pick an **industry preset**. A preset writes a chart of accounts, a tax set, a
   CRM pipeline and a module set. It is data, not code: you can change every part
   of it afterwards, and switching preset later never rewrites history.
3. Optionally tick **load demo data**. It creates a small, coherent company —
   customers, products, invoices, a pipeline — that you can explore and then
   remove in one action from **Settings → Company**. Nothing else is touched.

## Demo data

Demo data is for evaluation, not for production. It is marked so it can be removed
in isolation, and removing it does not touch anything you created yourself. If you
want to start clean, do not load it — an empty company is a first-class state, not
a broken one.

## Licence activation

The application runs as the **community edition** out of the box: complete for its
module set, with no expiry and no nag screen. A **pro** or **enterprise** key adds
the modules listed on **Settings → License**.

Keys are Ed25519-signed strings that look like:

```
NEXUS-PRO-<payload>-<signature>
```

Paste one into **Settings → License → Activate**. Verification is entirely
offline — there is no licence server to be down, and a failed verification never
touches your data. A key can be bound to one machine; the binding is checked
*after* the signature, so a wrong-machine key reports the machine, not a corrupt
key. If the system clock jumps backwards by more than a day the app shows a
warning banner and keeps working (BR-24).

## Where the data lives

```
%APPDATA%\nexus\nexus.db            the company — one SQLite file
%APPDATA%\nexus\nexus.db.tmp        transient, only during a write
%APPDATA%\nexus\logs\               application log
%APPDATA%\nexus\.stamp              clock-rollback stamp for the licence check
```

Writes are atomic: the database image is exported to `.tmp`, `fsync`ed, then
renamed over `nexus.db`. Killing the process mid-write leaves the previous file
byte-identical. Writes are debounced by 200 ms and flushed on quit.

**Copy that file and you have a backup** — but prefer **Settings → Backup**, which
also writes a manifest with a SHA-256 and the schema version, and refuses to
restore a file that fails either check.

## Backup and restore

- **Backup** writes `nexus-YYYY-MM-DD-HHmmss.db` plus `.manifest.json` to the
  folder you choose.
- **Restore** verifies the checksum and the schema version first, keeps a
  pre-restore copy of the current file, then replaces it. Everyone is signed out.
- **Archive** moves closed history (paid invoices, posted entries, settled
  payments) into a compressed cold store inside the same file. Reports read it
  back transparently, so a trial balance is identical before and after a
  housekeeping run. Anything still referenced by a live document stays put.

## Build from source

```bash
npm install          # zero native compilation
npm run dev          # vite + tsc watch + bundled preload + electron
npm run typecheck    # three tsconfigs, no emit
npm test             # 128 assertions, no Electron needed
npm run dist         # NSIS installer + portable exe into release/
```

**If `npm run dist` fails on your machine** with
`ERROR: Cannot create symbolic link : A required privilege is not held by the client`
or `app-builder.exe process failed`, the cause is Windows symlink privilege, not
the app: `electron-builder` unpacks a signing toolchain that contains symlinks.
Either enable Developer Mode (Settings → For developers) or build without the
executable rewrite:

```bash
npx electron-builder --win nsis portable -c.win.signAndEditExecutable=false
```

The trade-off is honest: the installer and portable exe then carry Electron's
default file icon. The application window, taskbar entry and Start-menu shortcut
still show the NEXUS icon, because the runtime icon is loaded from
`resources/icon.png`. Build on a machine with Developer Mode (or with a code
signing certificate) to get the icon inside the `.exe` as well.

Regenerate the icon set after editing `build/icon.svg`:

```bash
npx electron scripts/make-icon.cjs   # → build/icon.ico (16…256) + build/icon.png
```

`npm run dev` waits for Vite on port 5173 and for the first
`dist/main/main/index.js` before launching Electron. Renderer edits hot-reload;
main-process edits need the app restarted.

The one packaging subtlety: `sql.js` loads `sql-wasm.wasm` at runtime, from
`require.resolve` in development and from `process.resourcesPath` in a packaged
build (copied there by `electron-builder.yml` → `extraResources`). If the file is
missing you get a dialog naming the resolved path, not a white screen — see
`docs/PERF.md` and the packaging section of `docs/TASKS.md`.

## Forgot the password

NEXUS is offline, so there is no email reset. Whoever holds the database file already
holds the business, so recovery is a local command rather than a support ticket — and
it is **audited**: the reset appends a hash-chained `password_reset` entry, so it shows
in Settings → Audit log and the chain still verifies.

```bash
cd nexus
node scripts/reset-password.mjs --list                 # who exists, who is locked
node scripts/reset-password.mjs --username owner       # generates a strong password
node scripts/reset-password.mjs --username owner --password "My-New-Pass-1"
```

It also clears the failed-attempt counter and any lockout, so a locked account is
recoverable without waiting. Stop NEXUS first: the running app holds the database in
memory and would overwrite the change when it next saves.
## Known limitations

- **Windows x64 only.** The build targets NSIS and portable; macOS and Linux run
  from source but are not tested.
- **No code signing.** SmartScreen warns on first run.
- **Single user at a time.** The app takes a single-instance lock and refuses to
  run twice; it is a desktop product, not a shared server. Two people cannot work
  in the same file at once.
- **Archived records cannot be searched.** The cold store is read by reports, not
  by global search.
- **A reversal pair is never archived** (it would break the `reverses_id`
  foreign key), so a handful of old entries stay in the hot table.
- **No multi-currency revaluation.** Documents carry a currency and a rate;
  unrealised gains and losses are not computed.
- **Reports are cached for 30 seconds** and invalidated by posting. A direct
  database edit outside the app is not noticed until the cache expires.
- **Import is CSV only**, one entity per file, with a fixed template per entity.

---

Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS
Proprietary Perpetual License — see `LICENSE` and `EULA.md`.
