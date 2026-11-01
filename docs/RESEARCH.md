<!-- Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. -->

# NEXUS — Competitive & Design Research

**Author:** 许清楚 (Product Manager) · **Owner of IP:** arfanayub0 · **Status:** v1.0, input to PRD
**Method:** desk analysis of publicly documented product behaviour (docs, screenshots, product tours, open-source codebases read for *concepts only*). No code, assets, fonts, or data were copied from any source.

**Purpose:** decide what NEXUS v1 must match to be credible against Odoo / SAP B1 / Dynamics BC / ERPNext, and what it may safely ignore. Every row ends in a verdict: **MUST** (P0), **LATER** (P1/P2), **SKIP** (never, or out of scope for a single-machine offline product).

---

## 0. Reference set and what each one is actually good at

| Product | Category | The one thing worth stealing | Licence caution |
|---|---|---|---|
| **ERPNext / Frappe** | OSS ERP | Metadata-driven **DocType** — one schema definition generates list, form, filters, print, permissions, audit | GPLv3 — concepts only |
| **Odoo** | OSS+Commercial ERP | Module manifest registry; "app switcher" IA; configurable industry/localisation packs | LGPL/OPL — concepts only |
| **Dolibarr** | OSS ERP/CRM | Pragmatic breadth for SMEs; single flat menu that scales by module enable | GPLv3 — concepts only |
| **InvenTree** | OSS inventory | Stock-move ledger as the *only* source of on-hand truth | MIT — concepts only |
| **Akaunting** | OSS accounting | Small-business chart-of-accounts defaults; invoice-centric UX | GPLv3 — concepts only |
| **Invoice Ninja** | OSS invoicing | Document-numbering templates and recurring/expiry ergonomics | Elastic — concepts only |
| **Twenty CRM** | OSS CRM | Notion-grade **record page** + peek panel; custom fields as first-class | AGPL — concepts only |
| **Krayin** | OSS CRM | Lead → deal pipeline stages with per-stage value totals | MIT — concepts only |
| **NocoDB / Directus / Budibase** | Metadata platforms | Inline-editable grid; column/field type registry; saved views | AGPL/MIT mix — concepts only |
| **LedgerSMB** | OSS accounting | Strict double-entry discipline, period control, AR/AP ageing rigour | GPL — concepts only |
| **SAP Business One** | Commercial ERP | Master-data → document → journal traceability ("drill to source") | Proprietary — no assets |
| **Dynamics 365 BC** | Commercial ERP | Role-tailored home ("Role Center") dashboards per persona | Proprietary — no assets |
| **NetSuite** | Commercial ERP | Saved searches as a universal list primitive; custom segments | Proprietary — no assets |
| **Zoho One** | Suite | Cross-app object linking (lead ↔ deal ↔ invoice) without leaving the record | Proprietary — no assets |
| **Salesforce** | CRM | Pipeline forecasting + stage probability model; report folders | Proprietary — no assets |
| **HubSpot** | CRM | Activity timeline as the spine of the record; sequence of touches | Proprietary — no assets |
| **Pipedrive** | CRM | Kanban with **stage totals** and rotting-deal indicators | Proprietary — no assets |
| **Attio** | CRM | Inline-editable, keyboard-navigable record **grid**; column presets | Proprietary — no assets |
| **Xero** | Accounting | Split-view document builder (form left, live PDF right) | Proprietary — no assets |
| **QuickBooks** | Accounting | "Create from" document chain; reconciliation-style status chips | Proprietary — no assets |
| **Linear** | Work OS | Saved views + filter chips + command palette as the primary nav | Proprietary — no assets |
| **Notion** | Docs | ⌘K command palette with fuzzy ranking and recent items | Proprietary — no assets |

---

## (a) Module-by-module feature-parity checklist

Verdicts: **MUST** = NEXUS v1 P0 · **LATER** = P1/P2, explicitly deferred · **SKIP** = out of scope for offline single-machine v1.

### A1. Onboarding & setup
| Feature | Verdict | Inspired by | Note |
|---|---|---|---|
| Company profile (name, address, tax ID, logo) | MUST | Odoo | Drives every printed document |
| Industry preset selector | MUST | Odoo localisation packs | Config-only, no code branches |
| Currency + fiscal-year definition | MUST | QuickBooks | Fiscal year start month is config |
| First admin user creation | MUST | ERPNext | Admin is a role, not a special user |
| Demo data seeding (idempotent, wipeable) | MUST | Dolibarr | Required for "usable on day one" |
| License activation step | MUST | Invoice Ninja (self-hosted pro) | Offline Ed25519 verification |
| Guided multi-company setup | SKIP | SAP B1 | Single DB, single company in v1 |
| Cloud account signup | SKIP | Zoho | Contradicts offline mandate |

### A2. Identity, roles, security
| Feature | Verdict | Inspired by | Note |
|---|---|---|---|
| Local username/password login (Argon2id/scrypt) | MUST | ERPNext | No OAuth, no SSO offline |
| Lock screen on idle | MUST | Dynamics BC | Re-auth without losing route state |
| Role → permission matrix (`module.resource.action`) | MUST | Odoo groups + ERPNext roles | Union-of-roles evaluation |
| Per-record field-level restriction | LATER | Salesforce FLS | Deferred; needs field registry maturity |
| User management (create/disable/reset pw) | MUST | ERPNext | Cannot delete a user with audit rows |
| TOTP 2FA | LATER (P1) | Odoo | No QR provisioning offline → manual secret |
| Password policy + rotation | MUST | LedgerSMB | Length, history, lockout |
| Session list / force logout | LATER | NetSuite | Single machine → low value |

### A3. Licensing (offline perpetual)
| Feature | Verdict | Inspired by | Note |
|---|---|---|---|
| Community edition, no key required, never expires | MUST | Dolibarr | Must never nag-block |
| Ed25519-signed license payload | MUST | — | Public key embedded in app |
| Machine binding (hashed fingerprint) | MUST | JetBrains-style offline licences | Hash of host+MAC+install salt |
| Activate / deactivate (deactivate frees the seat locally) | MUST | Invoice Ninja | Deactivation writes an audit row |
| Clock-rollback detection → warn only | MUST | — | Never disable: user owns perpetual rights |
| Seat counting / floating licences | SKIP | NetSuite | Single machine by definition |
| Phone-home renewal | SKIP | Zoho | Explicitly prohibited |

### A4. Dashboard / analytics
| Feature | Verdict | Inspired by | Note |
|---|---|---|---|
| KPI cards with period-over-period delta | MUST | Stripe / Xero | Needs prior-period query helper |
| Revenue vs expense time series | MUST | Dynamics BC Role Center | 12-month window |
| Pipeline summary by stage with weighted value | MUST | Pipedrive | `value × probability` |
| "Needs attention" lists (overdue AR, low stock, expiring quotes, deals rotting) | MUST | HubSpot | Actionable, each row links to record |
| Recent activity feed | MUST | HubSpot | Union of audit + CRM activities |
| Drag-to-rearrange dashboard widgets | LATER | NetSuite | Persist layout JSON |
| Custom report builder | LATER (P2) | NetSuite | Large surface |
| Scheduled email digests | SKIP | Zoho | No SMTP in v1 |

### A5. Finance / accounting
| Feature | Verdict | Inspired by | Note |
|---|---|---|---|
| Hierarchical chart of accounts (tree, parent/child) | MUST | Akaunting / LedgerSMB | Type: asset/liability/equity/income/expense |
| Manual journal entries, balanced-or-reject | MUST | LedgerSMB | Hard invariant |
| Immutable posted entries (reverse, never edit) | MUST | SAP B1 | Append-only ledger |
| Customer invoices (AR) with line items, tax, discounts | MUST | Xero | |
| Vendor bills (AP) | MUST | QuickBooks | |
| Payments applied to invoices/bills (partial, multi) | MUST | Xero | Allocation table |
| Trial balance | MUST | LedgerSMB | Debits == credits check |
| Profit & loss | MUST | Akaunting | Date range, comparative toggle |
| Balance sheet | MUST | QuickBooks | As-of date |
| General ledger detail by account | MUST | SAP B1 | Drill from TB → GL → journal |
| Period locking (close a month) | MUST | LedgerSMB | Posting into locked period rejected |
| Multi-currency revaluation | LATER | NetSuite | Needs FX rate table + reval run |
| Bank feeds / reconciliation | SKIP | Xero | Requires network |
| Tax return filing formats | SKIP | QuickBooks | Jurisdiction-specific, out of scope |
| Recurring invoices | LATER (P1) | Invoice Ninja | Scheduler exists but deferred |

### A6. Inventory
| Feature | Verdict | Inspired by | Note |
|---|---|---|---|
| Products with SKU, barcode, UoM, cost method | MUST | InvenTree | FIFO/AVCO/moving-average |
| Warehouses + bin locations | MUST | InvenTree | Two-level hierarchy |
| Stock moves: receipt / issue / transfer / adjustment | MUST | InvenTree | Append-only move ledger |
| On-hand quants (product × location) | MUST | InvenTree | Derived, never hand-edited |
| Low-stock / reorder-point alerts | MUST | ERPNext | Feeds dashboard "needs attention" |
| Inventory valuation (stock value from moves) | MUST | ERPNext | Cost method dependent |
| Stock count / cycle count | LATER | InvenTree | Adjustment move covers v1 need |
| Lot / serial tracking | LATER | InvenTree | Large surface, defer |
| BOM / manufacturing orders | LATER (P1) | ERPNext | Explicitly deferred |
| Multi-step routing / putaway rules | SKIP | SAP B1 | Warehouse-logistics depth |

### A7. Purchasing
| Feature | Verdict | Inspired by | Note |
|---|---|---|---|
| Vendors (supplier master) | MUST | ERPNext | |
| Purchase orders with line items, taxes, terms | MUST | Odoo | |
| Goods receipt, **partial** receipts allowed | MUST | SAP B1 | Receipt status per line |
| Vendor bill from receipt/PO | MUST | QuickBooks "create from" | |
| 3-way match (PO ↔ receipt ↔ bill) with tolerance | MUST | SAP B1 | Tolerance % + absolute cap |
| Vendor price comparison / RFQ | LATER | Odoo | |
| Purchase requisition + approval chain | LATER (P1) | SAP B1 | Approvals deferred |

### A8. Sales
| Feature | Verdict | Inspired by | Note |
|---|---|---|---|
| Customers (with credit terms) | MUST | Xero | |
| Quotations with expiry date | MUST | Invoice Ninja | Expired → not convertible without override |
| Sales orders | MUST | Odoo | |
| Delivery / fulfilment status per line | MUST | ERPNext | Ordered vs delivered vs invoiced |
| Price lists (per customer/segment, validity window) | MUST | SAP B1 | Resolution order is a business rule |
| Quote → order → delivery → invoice chain | MUST | QuickBooks | "Create from" everywhere |
| Sales discounts (line + document) | MUST | Xero | |
| Backorders / split deliveries | LATER | SAP B1 | Partial delivery yes, backorder doc no |
| Sales commissions | SKIP | NetSuite | Payroll-adjacent |

### A9. CRM
| Feature | Verdict | Inspired by | Note |
|---|---|---|---|
| Accounts (companies) + contacts | MUST | Twenty | Contact belongs to account |
| Leads with source/status/owner | MUST | Krayin | |
| **Atomic** lead → account + contact + deal conversion | MUST | Zoho | Single transaction, rollback on failure |
| Deals pipeline, custom stages, kanban with drag-drop | MUST | Pipedrive | Column totals + weighted |
| Stage probability → weighted forecast | MUST | Salesforce | |
| Activities: call / email(logged) / meeting / task, timeline | MUST | HubSpot | Email is *logged*, not sent |
| Win/loss reasons (loss reason mandatory) | MUST | Pipedrive | Enforced on close-lost |
| CRM analytics: win rate, cycle length, forecast, leaderboard | MUST | Salesforce | Derived, read-only |
| Email sync / IMAP | SKIP | HubSpot | Network |
| Marketing automation / sequences | SKIP | HubSpot | Out of scope |
| Custom objects | LATER (P2) | Salesforce | Custom *fields* in v1, custom objects later |

### A10. Documents & data
| Feature | Verdict | Inspired by | Note |
|---|---|---|---|
| PDF for invoice / quote / PO / delivery note / statement | MUST | Xero | HTML → print-to-PDF via Electron |
| Print + "Save as PDF" | MUST | Invoice Ninja | Chromium print pipeline |
| XLSX/CSV export on every list | MUST | NocoDB | Generic exporter from table registry |
| XLSX/CSV import wizard with column mapping | MUST | ERPNext Data Import | Row-level validation report |
| Email documents | LATER (P1) | Odoo | Needs SMTP |
| E-invoice / UBL / PEPPOL | SKIP | Odoo | Jurisdiction + network |
| Document designer (drag-drop template) | LATER | Invoice Ninja | v1 = fixed, well-designed template |

### A11. Settings & administration
| Feature | Verdict | Inspired by | Note |
|---|---|---|---|
| Company settings | MUST | Odoo | |
| Users & roles UI | MUST | ERPNext | |
| Custom fields per entity (text/number/date/select/bool) | MUST | Twenty / Directus | Stored as JSON on record |
| Industry presets (apply/toggle) | MUST | Odoo | Enables modules, seeds COA |
| Document numbering schemes (prefix, padding, reset) | MUST | Invoice Ninja | Gapless enforcement |
| Taxes (rate, inclusive/exclusive, compound) | MUST | Xero | |
| Currencies + rates | MUST | Odoo | Base + foreign |
| Backup / restore (local file) | MUST | Dolibarr | SQLite copy + integrity check |
| Audit log viewer (filter, search) | MUST | SAP B1 | Append-only |
| Licence page | MUST | — | Edition, expiry=never, machine ID |
| Security: idle lock, password policy | MUST | Dynamics BC | |
| Workflow / approval builder | LATER (P1) | Odoo | |

### A12. UX shell
| Feature | Verdict | Inspired by | Note |
|---|---|---|---|
| Command palette (⌘/Ctrl+K) | MUST | Notion / Linear | Fuzzy, recent, action-first |
| Keyboard shortcuts + cheat sheet (`?`) | MUST | Linear | |
| Saved table views (filter/sort/columns) | MUST | Linear / NetSuite | Persisted per user |
| Toasts, empty states, error states | MUST | Linear | |
| Dark mode + density toggle | MUST | Linear | Semantic tokens only |
| Collapsible sidebar | MUST | Odoo | |
| Global search (cross-entity) | MUST | Twenty | |
| Record peek drawer | MUST | Twenty / Attio | Non-destructive inspection |
| Inline-editable grid | LATER | Attio / NocoDB | v1 tables are read+act, not bulk-edit |
| Offline update bundles | LATER (P1) | — | No auto-update phone-home |

---

## (b) Top 20 UX patterns worth copying

| # | Pattern | Source | Why it matters for NEXUS | Where it lands |
|---|---|---|---|---|
| 1 | **⌘K command palette** with fuzzy match, grouped results (Records / Actions / Navigation), and recent-first ordering | Notion, Linear | A 12-module ERP is unnavigable by menus alone; this is the primary nav | Global, every route |
| 2 | **Inline-editable record grid** with keyboard cell navigation and optimistic save | Attio | Makes list screens feel like a spreadsheet, which is how SME staff actually work | Deals table, products, contacts (P1 for full edit) |
| 3 | **Kanban with stage totals** in column headers (count + Σ value + weighted) | Pipedrive | Turns pipeline into a forecast, not a pretty board | Deals pipeline |
| 4 | **Period-comparison KPI cards** — big number, delta chip, sparkline, "vs prior 30d" | Stripe, Xero | Answers "am I doing better than last month" without a report | Dashboard |
| 5 | **Saved views + filter chips** — filters as removable chips, view name in URL | Linear | Accountants rebuild the same filter daily; chips make state legible | Every table |
| 6 | **Split-view document builder** — form left, live PDF preview right, updates as you type | Xero | Removes the "save → print → check → fix" loop | Invoice, quote, PO |
| 7 | **"Create from" document chain** — every downstream doc remembers its source, with a breadcrumb | QuickBooks | Traceability is the whole point of an ERP; one click from invoice to PO to receipt | All transactional docs |
| 8 | **Peek panel** — side drawer showing a linked record without losing your place | Twenty | Clicking a customer inside an invoice must not destroy the invoice draft | All relation fields |
| 9 | **Activity timeline** as the record's spine, with type icons and inline compose | HubSpot | Sales context lives in the timeline, not in notes fields | Account/contact/deal |
| 10 | **Status chip rail / document state machine** visible at top of every doc (Draft → Sent → Paid) | QuickBooks | Users need to know *what can I do next* before reading fields | All docs |
| 11 | **Rotting-deal / staleness indicator** (days since last activity, colour ramp) | Pipedrive | Surfaces neglect without a report | Deals kanban, "needs attention" |
| 12 | **Drill-down numbers** — every aggregate is clickable into its constituent rows | SAP B1, NetSuite | Trust: "why is this 42,318?" must be one click | TB, P&L, BS, KPI cards |
| 13 | **Two-pane settings** (left nav categories, right inline form with per-section save) | Linear, Attio | Settings is where ERPs die; keep it shallow and save-in-place | Settings |
| 14 | **Keyboard cheat sheet overlay** (`?`) with contextual shortcuts | Linear | Keyboard-first is a stated requirement, so it must be discoverable | Global |
| 15 | **Empty states that teach** — illustration-free, one sentence + primary action + "load demo data" | Linear, Notion | First-run must reach value in 3 minutes | Every list |
| 16 | **Density toggle** (comfortable / compact row heights) | Linear, Attio | Warehouse clerk and accountant want different densities | Global, per-user |
| 17 | **Optimistic UI with rollback toast** on drag-drop and inline edits | Linear | Kanban drag that waits 300ms feels broken | Kanban, table edits |
| 18 | **Number formatting per locale + tabular figures** in every money column | Xero | Misaligned decimals destroy scanability | All tables |
| 19 | **Import wizard as a 4-step stepper** (upload → map columns → validate → commit) with a downloadable error report | ERPNext Data Import | CSV import is the #1 reason SMEs abandon an ERP | Import wizard |
| 20 | **Breadcrumb + "back to list preserving view"** — returning to a filtered list keeps filters/scroll | NetSuite, Linear | Losing filter state is the most-complained-about ERP behaviour | All tables → detail |

---

## (c) Top 10 architectural ideas worth copying

| # | Idea | Source | What it buys NEXUS |
|---|---|---|---|
| 1 | **Metadata-driven entity definitions** ("DocType"): one declarative schema per entity generates list config, form layout, field types, validation hooks, permission targets, export columns, print context | ERPNext/Frappe | ~14 entities × 5 surfaces becomes 14 declarations, not 70 hand-written screens. This is the single biggest leverage decision |
| 2 | **Modular monolith + manifest registry**: each module declares `{id, name, routes, permissions, entities, seedData, industryTags}`; the app boots by reading manifests | Odoo | Cross-industry by *configuration*: a preset is a list of enabled module IDs + COA template + numbering schemes. No `if (industry === …)` anywhere |
| 3 | **Event-driven document posting**: documents emit `document.posted`; subscribers create journals, stock moves, audit rows, notifications | Odoo, ERPNext | Decouples Sales from Finance from Inventory; posting becomes a single auditable transaction with a predictable side-effect list |
| 4 | **Immutable append-only ledger**: journals and stock moves are never UPDATEd or DELETEd; corrections are reversing entries | LedgerSMB, SAP B1 | Auditable by construction; makes "posted" trustworthy and period-locking meaningful |
| 5 | **Price-list resolution order**: explicit contract price → customer-segment list → default list → product base price, first hit wins, with validity windows | SAP B1 | One deterministic function instead of ad-hoc discount logic scattered in sales |
| 6 | **3-way match with dual tolerance** (percentage *and* absolute cap, both must pass) | SAP B1 | Percentage alone lets a rounding error on a tiny bill block payment; absolute alone lets 40% on a huge bill through |
| 7 | **Append-only audit trail** with `{actor, at, entity, entityId, action, before, after, ip:'local'}` on every mutation | SAP B1, ERPNext | Required for accounting credibility; also powers the activity feed for free |
| 8 | **Optimistic UI + local transaction queue** — UI applies the change, the main process commits, failure triggers rollback + toast | Linear | Renderer never waits on IPC round-trips for perceived responsiveness; keeps the 300ms route budget |
| 9 | **Virtualized tables** (windowed rendering) with server-side-style paging over local SQL | NocoDB, Attio | 10k+ row lists at 60fps; non-negotiable for products/contacts/GL |
| 10 | **Offline-first local DB as the system of record** (SQLite file, WAL, migrations, integrity check, file-level backup/restore) | InvenTree, Dolibarr | The whole premise. Backup/restore must be a first-class, tested feature — not a settings footnote |

Bonus (noted, not counted): **derived-not-stored** on-hand quants and account balances computed from the move/ledger tables, cached in a materialized summary that can always be rebuilt from source rows.

---

## (d) "Do NOT copy" list

| Prohibited | Reason |
|---|---|
| **GPL / AGPL / LGPL / OPL source code** (ERPNext, Odoo, Dolibarr, Akaunting, Twenty, Krayin, LedgerSMB, NocoDB, Directus, Budibase) | Copyleft would force NEXUS to be distributed under the same licence, destroying the proprietary perpetual model. **Concepts and publicly documented behaviours only; zero code, zero schema files, zero templates.** |
| **Proprietary assets, logos, brand names, icons, illustrations, screenshots** (SAP, Microsoft, Oracle, Salesforce, HubSpot, Pipedrive, Xero, Intuit, Zoho, Attio, Notion, Linear, Stripe) | Trademark and copyright. NEXUS ships its own icon set, its own name, its own visual language |
| **Proprietary fonts** (e.g. Inter is OFL — usable; Salesforce Sans, Segoe variants bundled, Xero's custom faces are not) | Font licences are separate from app licences. Ship OFL/Apache fonts only, self-hosted, **never** a CDN |
| **Their demo/seed data, COA templates, chart structures as shipped files** | Copying a shipped chart-of-accounts file is copying a creative work. Build NEXUS COA from generic accounting principles |
| **Scraping their sites, docs, or app telemetry; automated screenshots of logged-in apps** | ToS violation + copyright. Research was done from public product documentation and marketing material |
| **Their API shapes, DB schemas, or SQL dumps** | Even if publicly visible, wholesale schema copying is derivative. NEXUS's schema is designed from its own domain model |
| **CDN-loaded anything** (fonts, icons, chart libs, CSS) | Violates the offline mandate and leaks requests. Everything bundled locally |
| **Telemetry / analytics / crash-report SDKs** | Violates the offline mandate and the privacy promise in the PRD |
| **Their exact copy/text** (labels, help strings, marketing language) | Copyright. NEXUS writes its own strings, and they are i18n keys from day one |

---

## Mobbin-inspired visual direction

Six concrete layout patterns to emulate. These are *layout and interaction* patterns (not copy, not assets), chosen because they are what makes modern B2B tools feel fast rather than "enterprise".

**1. Dense KPI strip (top of dashboard)**
A single row of 4–6 cards, fixed height (~112px), no card shadows — 1px border + 8pt inner padding. Each card: label (12px, muted, uppercase-ish tracking), value (28px, tabular figures, weight 600), delta chip (12px, semantic green/red with arrow), micro-sparkline (40px tall, no axes). Cards are clickable → drill to filtered list. *Reference: Stripe Dashboard, Linear Insights.*

**2. Split-view document builder (invoice / quote / PO)**
Two columns: left 58% is the editable form (header block → line-item grid → totals block → footer notes); right 42% is a sticky live PDF preview in a subtle grey "paper" frame with the page shadow. Preview re-renders debounced at 250ms. Sticky action bar at the bottom of the left column (Save draft / Post / Print). *Reference: Xero invoice editor, Invoice Ninja.*

**3. Kanban with stage totals (deals)**
Columns are 280px fixed width, horizontally scrollable, each with a sticky header showing stage name, deal count, Σ value, weighted value. Cards: account name (600), deal value (tabular), owner avatar, days-in-stage chip that shifts amber→red. Drag shows a placeholder gap; column total animates on drop. *Reference: Pipedrive pipeline, Krayin.*

**4. Record peek drawer (right side)**
420px drawer, slides over content, does not unmount the underlying screen. Header: record type + name + status chip; body: key fields (2-col), then timeline. Footer: "Open full record" + primary action. `Esc` closes and restores focus to the originating cell. *Reference: Twenty CRM peek, Attio record preview.*

**5. Table toolbar with saved views**
Toolbar above every table: view name dropdown (with "Save current as…"), filter chips row (each chip removable, `+ Filter` opens a popover), search input, density toggle, column chooser, export button, primary create button on the far right. Below: sticky header row, 40px (compact) / 52px (comfortable) rows, right-aligned money, left-aligned text, status as chips. *Reference: Linear issues view, NetSuite saved searches, Attio grid.*

**6. Settings with left nav + inline save**
Left rail 240px: grouped categories (Company / People / Data / Finance / CRM / Security / Licence), each a collapsible section. Right: one card per settings group, fields in a 2-col grid, section-level "Save changes" that is disabled until dirty, plus an inline "Saved" confirmation that fades. No modals, no full-page reloads, no wizard for settings. *Reference: Linear settings, Attio workspace settings.*

**Supporting visual rules (all six patterns share these):** 8pt spacing grid; 4px corner radius on inputs, 6px on cards, 999px on chips; 1px borders over shadows (shadows reserved for drawers/modals/palette); semantic colour tokens (`--bg`, `--surface`, `--border`, `--text`, `--text-muted`, `--accent`, `--success`, `--warning`, `--danger`) with light/dark pairs and no hard-coded hex in components; two type sizes for UI (13px body, 12px meta) plus 28px KPI numerals; tabular-nums on every numeric column.

---

## Open research questions

1. Does an industry preset also switch the *default landing module* (e.g. manufacturing → Inventory first, services → CRM first)? Leaning yes — it is a config value, not a code branch.
2. Is "print to PDF" via Chromium's print pipeline sufficient for the 5 required document types, or is a PDF library needed for headers/footers and page numbers? Engineer to confirm; PRD assumes HTML→print.
3. How is a machine fingerprint computed so that a hardware change (NIC swap, VM move) does not lock a legitimate perpetual customer out? Proposed: warn + allow re-activation with the original key, since verification is offline and the key itself is the proof.
4. Should custom fields participate in saved-view filters in v1? Proposed: yes for text/number/date/select, stored in a JSON path — otherwise custom fields feel second-class.
