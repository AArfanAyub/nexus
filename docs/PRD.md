<!-- Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. -->

# NEXUS — Product Requirements Document

| Field | Value |
|---|---|
| **Product** | NEXUS — offline ERP + CRM for any industry |
| **Version** | v1.0 (P0 delivery) |
| **Author** | 许清楚 (Product Manager) · **IP owner** | arfanayub0 |
| **Licence** | NEXUS Proprietary Perpetual License — never expires, no server |
| **Platform** | Electron desktop app (Windows / macOS / Linux), single machine |
| **Storage** | One local SQLite file. **Zero runtime network calls.** |
| **Design bar** | Odoo / SAP B1 / Dynamics BC / ERPNext information architecture |
| **Companion doc** | `RESEARCH.md` (parity checklist, UX patterns, do-not-copy list) |

---

## 1. Product summary, positioning, non-goals

**Summary.** NEXUS is a desktop ERP + CRM that a 5–500 person company installs in three minutes, activates offline with a signed key, and runs forever on one machine with a local database. It ships with an onboarding wizard, industry presets, and seeded demo data so a new user sees a working business — customers, invoices, stock, a pipeline — on first launch rather than an empty shell.

**Positioning.** *"The ERP you own."* Where Odoo/ERPNext demand a server, a sysadmin, and a subscription or a copyleft commitment, and where SAP B1 / Dynamics BC demand a partner and six figures, NEXUS is a single installable file, a single database file, and a perpetual licence. Depth competes on **information architecture and discipline** (double-entry, immutable ledgers, 3-way match, audit trail), not on integration breadth.

**Three orthogonal product goals.**

| # | Goal | Measurable |
|---|---|---|
| G1 | **Time-to-value ≤ 3 min** | Fresh install → seeded demo data → dashboard with real numbers, no network, no account |
| G2 | **Accounting integrity is structural** | Every posted entry balances; posted rows are immutable; 100% of mutations audited; period locks honoured |
| G3 | **One codebase, any industry** | Adding an industry = a preset config object (enabled modules + COA template + numbering + tax set). Zero `if (industry === …)` branches |

**Non-goals (v1).** Not a multi-tenant SaaS. Not a bank-feed/reconciliation product. Not a payroll or tax-filing product. Not a manufacturing MRP. Not a marketplace/integration hub. Not a mobile app. Not a reporting BI tool. Not multi-user over LAN.

---

## 2. Personas & jobs-to-be-done

| Persona | Context | Top jobs-to-be-done | Primary surfaces |
|---|---|---|---|
| **Priya — Owner / Admin** (5–500 staff) | Signs the cheque, wants to know if the month was good | "Did we make money this month?" · "Who owes me money?" · "Is anything on fire?" · "Set up the system for my industry" | Dashboard, CRM analytics, Settings, Licence |
| **Marcus — Accountant** | Owns the books, distrusts software | "Post this month's journals" · "Reconcile AR/AP" · "Close the period" · "Prove the numbers tie" | Journal entries, Invoices, Bills, Payments, Reports, Periods |
| **Sofia — Sales rep** | Lives in the pipeline, hates data entry | "What should I call today?" · "Move this deal forward" · "Send a quote before it expires" | Deals kanban, Leads, Quotations, Activities, peek drawer |
| **Dan — Warehouse clerk** | Keyboard and barcode, not mouse | "Receive 40 units against PO-118" · "Where is this SKU?" · "Transfer 12 to Bay 3" · "What's low?" | Stock moves, Receipts, Products, On-hand |

---

## 3. Scope

### 3.1 P0 — ships in v1

| Area | Included | Why it is P0 |
|---|---|---|
| Onboarding | Wizard (company, industry, currency/FY, admin, licence) + demo seed | G1 is impossible without it |
| Auth & RBAC | Login, lock screen, sessions, roles → `module.resource.action`, user admin | Everything else needs an actor for the audit trail |
| Licensing | Community/Pro/Enterprise, Ed25519 key, machine binding, activate/deactivate, clock-rollback warn | The commercial premise; must exist before distribution |
| Dashboard | KPI cards + deltas, revenue/expense chart, pipeline summary, needs-attention, activity feed | The "is my business OK" surface; drives daily open |
| Finance | COA, journals, AR invoices, AP bills, payments, TB, P&L, BS, GL, period lock | The reason it is an ERP and not a CRM |
| Inventory | Products, warehouses, stock moves, on-hand quants, low-stock, valuation | Physical goods are the majority of target industries |
| Purchasing | Vendors, POs, partial receipts, vendor bills, 3-way match | Spend control; closes the AP loop |
| Sales | Customers, quotations + expiry, orders, delivery status, price lists | Revenue path; feeds AR |
| CRM | Accounts, contacts, leads + atomic conversion, deals kanban, activities, win/loss, analytics | Differentiator vs. accounting-only tools; drives the pipeline KPI |
| Documents | 5 PDF types via HTML→print, print/save-as-PDF, XLSX/CSV export everywhere, import wizard | A business that cannot send an invoice is not usable |
| Settings | Company, users/roles, custom fields, presets, numbering, taxes, currencies, backup/restore, audit viewer, licence, security | Configuration is how "cross-industry" is delivered |
| UX shell | ⌘K palette, shortcuts + cheat sheet, saved views, toasts, empty/error states, dark+density, collapsible sidebar, global search | Without this the module count is a liability |

### 3.2 P1 — deferred, explicitly out of v1

| Area | Why deferred |
|---|---|
| Manufacturing (BOM, work orders) | Needs a costing engine + routing model; larger than all of Inventory |
| Projects & timesheets | Requires a second billing model (time→invoice) |
| HR-lite (employees, leave) | Not on the critical accounting path |
| Fixed assets & depreciation | Needs a scheduled-journal engine |
| Support tickets | Separate domain, no shared entities |
| TOTP 2FA | No QR provisioning offline; manual secret UX needs design |
| SQLCipher DB encryption | Key-management UX + migration story not ready |
| SMTP email of documents | Breaks the "zero network" default; needs explicit opt-in design |
| Recurring documents | Needs a background scheduler + catch-up semantics |
| Approvals / workflow | Needs an approval-graph model and delegation rules |
| LAN multi-user | Turns the architecture into client/server — a different product |
| Offline update bundles | Needs signing/verification pipeline for app packages |

### 3.3 P2 — future

POS mode · custom objects (beyond custom fields) · report builder · RTL locales beyond `en`.

---

## 4. P0 user stories

Format: **ID · persona · story · acceptance criteria (Given/When/Then) · module**. All 58 stories are P0.

### 4.1 Onboarding — 4

| ID | Persona | Story | Acceptance criteria | Module |
|---|---|---|---|---|
| US-01 | Priya | As an owner, I want a guided first-run wizard so that the system fits my business before I see it | **G** fresh install with no DB **W** I launch **T** a 5-step wizard appears and no other route is reachable | Onboarding |
| US-02 | Priya | As an owner, I want to pick an industry preset so that the right modules and accounts exist without configuration | **G** step 2 **W** I select "Wholesale/Retail" **T** module set, COA template, tax set and numbering schemes are previewed before applying; nothing is applied until I confirm | Onboarding |
| US-03 | Priya | As an owner, I want demo data so that I can evaluate the product with realistic content | **G** wizard complete **W** I tick "load demo data" **T** ≥3 customers, ≥3 vendors, ≥8 products, ≥6 invoices, ≥5 deals and stock history are created and the dashboard shows non-zero KPIs; a "Remove demo data" action exists in Settings | Onboarding |
| US-04 | Priya | As an owner, I want to enter my licence key during setup so that the right edition is active from day one | **G** step 5 **W** I paste a valid key **T** edition is shown; if I skip, the app continues on Community with a dismissible, non-blocking notice | Licensing |

### 4.2 Auth, roles, users — 4

| ID | Persona | Story | Acceptance criteria | Module |
|---|---|---|---|---|
| US-05 | All | As a user, I want to log in locally so that my actions are attributable | **G** registered user **W** I submit correct credentials **T** a session starts and every subsequent mutation records my user id | Auth |
| US-06 | All | As a user, I want the screen to lock when idle so that my session is not left open | **G** idle ≥ configured minutes **W** the timer fires **T** lock screen covers all content; re-auth restores the exact route and unsaved form state | Security |
| US-07 | Priya | As an admin, I want to define roles as permission sets so that staff see only their work | **G** role editor **W** I grant `sales.quotation.create` **T** that user sees the Create button; without it the button is absent (not disabled) and the API rejects the action | RBAC |
| US-08 | Priya | As an admin, I want to manage users so that leavers lose access without destroying history | **G** a user with audit rows **W** I try to delete **T** deletion is refused and I am offered "Disable"; disabling blocks login but preserves all attribution | Users |

### 4.3 Offline licensing — 4

| ID | Persona | Story | Acceptance criteria | Module |
|---|---|---|---|---|
| US-09 | Priya | As an owner, I want to activate a key fully offline so that no server is ever contacted | **G** a signed key string **W** I paste it **T** the Ed25519 signature verifies against the embedded public key and the edition unlocks, with zero network I/O | Licensing |
| US-10 | Priya | As an owner, I want the licence bound to my machine so that keys cannot be shared | **G** activated key **W** I view the licence page **T** a machine ID (hash) is displayed; a key activated on another machine ID is rejected with a clear reason | Licensing |
| US-11 | Priya | As an owner, I want to deactivate so that I can move the app to a new computer | **G** active licence **W** I deactivate **T** the app returns to Community immediately, an audit row is written, and the same key activates on the new machine | Licensing |
| US-12 | Priya | As an owner, I want a clock change to warn me rather than break my software | **G** system clock set backwards **W** the app checks at startup **T** a warning banner appears and **all features keep working**; no lockout, no data loss, ever | Licensing |

### 4.4 Dashboard — 3

| ID | Persona | Story | Acceptance criteria | Module |
|---|---|---|---|---|
| US-13 | Priya | As an owner, I want KPI cards with period comparison so that I know if this month beats last | **G** data for both periods **W** dashboard loads **T** Revenue, Expenses, Net profit, Open AR, Pipeline (weighted), Low-stock count each show a value and a % delta vs the prior equal-length period | Dashboard |
| US-14 | Priya | As an owner, I want a needs-attention list so that problems surface without me hunting | **G** an invoice 15 days overdue and a product below reorder point **W** dashboard loads **T** both appear with a one-click jump to the record; the list is empty-stated ("Nothing needs attention") when clean | Dashboard |
| US-15 | Sofia | As a salesperson, I want a pipeline summary by stage with weighted value so that I can forecast | **G** open deals with probabilities **W** dashboard loads **T** stages are listed with count, Σ value and Σ (value × probability), and clicking a stage opens the filtered kanban | Dashboard |

### 4.5 Finance — 8

| ID | Persona | Story | Acceptance criteria | Module |
|---|---|---|---|---|
| US-16 | Marcus | As an accountant, I want a hierarchical chart of accounts so that statements roll up correctly | **G** accounts with parents **W** I open COA **T** a tree renders with expand/collapse; a parent's balance equals the sum of its children; accounts with postings cannot be deleted | Finance |
| US-17 | Marcus | As an accountant, I want journals rejected unless balanced so that the ledger is never wrong | **G** a journal with debits 1000 / credits 900 **W** I post **T** posting is refused with "Out of balance by 100.00"; nothing is written | Finance |
| US-18 | Marcus | As an accountant, I want posted entries to be immutable so that history cannot be rewritten | **G** a posted journal **W** I open it **T** all fields are read-only; the only allowed actions are Reverse and Print; reversing creates a new mirrored entry linked to the original | Finance |
| US-19 | Marcus | As an accountant, I want invoices with tax and discounts so that I bill correctly | **G** 2 lines, 10% tax, 5% line discount **W** I post the invoice **T** totals compute in minor units, tax is shown inclusive/exclusive per the tax config, and a balanced AR journal is created automatically | Finance |
| US-20 | Marcus | As an accountant, I want payments allocated to invoices so that AR is accurate | **G** an invoice of 1,000.00 **W** I record a payment of 400.00 **T** the invoice shows Partially paid with 600.00 open; a second payment of 600.00 makes it Paid; over-allocation is refused | Finance |
| US-21 | Marcus | As an accountant, I want a trial balance so that I can prove debits equal credits | **G** any dataset **W** I run TB for a period **T** Σ debits == Σ credits is displayed as a check; every row drills to its GL detail | Finance |
| US-22 | Marcus | As an accountant, I want P&L and balance sheet so that I can report to the owner | **G** a date range **W** I open P&L **T** income and expenses group by account type with a comparative column; BS as of a date shows Assets == Liabilities + Equity | Finance |
| US-23 | Marcus | As an accountant, I want period locking so that closed months cannot change | **G** January locked **W** I post a January-dated journal **T** it is refused with the lock date and the locking user; reopening requires an explicit action that is audited | Finance |

### 4.6 Inventory — 5

| ID | Persona | Story | Acceptance criteria | Module |
|---|---|---|---|---|
| US-24 | Dan | As a clerk, I want products with SKU, barcode and cost method so that stock is identifiable | **G** product form **W** I save with a duplicate SKU **T** save is refused naming the conflicting product; barcode must be unique when present | Inventory |
| US-25 | Dan | As a clerk, I want stock moves of four types so that every quantity change is explainable | **G** a product at 100 units **W** I post a transfer of 30 **T** total on-hand stays 100 while location balances change, and a move row records type, from, to, qty, user, time | Inventory |
| US-26 | Dan | As a clerk, I want on-hand quantities derived from moves so that counts can be trusted | **G** no manual quantity edit anywhere **W** I open on-hand **T** each product×location figure equals the sum of its moves; there is no UI to type a quantity directly | Inventory |
| US-27 | Dan | As a clerk, I want negative stock blocked so that the ledger stays physical | **G** 10 units on hand **W** I post an issue of 15 **T** the move is refused with available quantity shown; the override requires a permission and is audited | Inventory |
| US-28 | Priya | As an owner, I want low-stock alerts and valuation so that I know what to reorder and what it is worth | **G** reorder point 20, on hand 12 **W** I open the products list **T** the item is flagged Low and appears in dashboard needs-attention; valuation uses the product's cost method and is reproducible from moves | Inventory |

### 4.7 Purchasing — 4

| ID | Persona | Story | Acceptance criteria | Module |
|---|---|---|---|---|
| US-29 | Dan | As a clerk, I want to receive goods partially so that deliveries can arrive in instalments | **G** a PO for 100 units **W** I receive 40 **T** the PO shows 40 received / 60 outstanding with status Partially received; a second receipt of 60 closes it | Purchasing |
| US-30 | Marcus | As an accountant, I want a vendor bill from a receipt so that AP matches what arrived | **G** a posted receipt **W** I choose "Create bill" **T** the bill pre-fills received quantities and PO prices, and links back to both source documents | Purchasing |
| US-31 | Marcus | As an accountant, I want a 3-way match tolerance so that small price differences do not block payment | **G** tolerance 2% and 50.00 absolute **W** the bill exceeds either limit **T** it is flagged as a match exception requiring explicit approval to post; within both limits it posts silently | Purchasing |
| US-32 | Marcus | As an accountant, I want vendors with terms so that AP dates are right | **G** vendor with Net 30 **W** I create a bill **T** the due date defaults to invoice date + 30 and is editable, and the vendor cannot be deleted while bills exist | Purchasing |

### 4.8 Sales — 5

| ID | Persona | Story | Acceptance criteria | Module |
|---|---|---|---|---|
| US-33 | Sofia | As a salesperson, I want quotations with expiry so that stale prices are not honoured silently | **G** a quote expiring yesterday **W** I try to convert to a sales order **T** conversion is blocked with "Quote expired" and an override requiring permission | Sales |
| US-34 | Sofia | As a salesperson, I want to convert a quote to an order to an invoice so that I never retype | **G** an accepted quote **W** I click Create sales order **T** all lines, prices, discounts and taxes carry over and both documents cross-link | Sales |
| US-35 | Dan | As a clerk, I want delivery status per line so that I know what is left to ship | **G** an order for 10 units, 4 delivered **W** I open the order **T** the line reads ordered 10 / delivered 4 / to deliver 6 and the header reads Partially delivered | Sales |
| US-36 | Sofia | As a salesperson, I want price lists so that customers get the right price automatically | **G** a customer on "Wholesale" and a default list **W** I add a product to a quote **T** the wholesale price is used; with no list match the product base price is used, and a manual override is marked as such | Sales |
| US-37 | Priya | As an owner, I want customers with credit terms so that AR ageing is meaningful | **G** customer with 30-day terms **W** I create an invoice **T** due date = invoice date + 30, and the customer record shows total outstanding | Sales |

### 4.9 CRM — 7

| ID | Persona | Story | Acceptance criteria | Module |
|---|---|---|---|---|
| US-38 | Sofia | As a salesperson, I want accounts and contacts so that I know who I am selling to | **G** an account **W** I add a contact **T** the contact belongs to exactly one account and appears in the account's contacts tab and timeline | CRM |
| US-39 | Sofia | As a salesperson, I want to convert a lead in one atomic step so that I never end up with half a customer | **G** a qualified lead **W** I run the conversion wizard **T** account + contact + deal are created in one transaction; if any step fails, nothing is created and the lead is unchanged; the lead is marked Converted with links | CRM |
| US-40 | Sofia | As a salesperson, I want a kanban pipeline with drag-and-drop so that moving a deal is one gesture | **G** the deals board **W** I drag a card to "Negotiation" **T** the stage persists immediately (optimistic), column totals update, and a `stage_changed` activity is logged | CRM |
| US-41 | Priya | As an owner, I want custom pipeline stages with probabilities so that the forecast reflects my process | **G** settings → pipeline stages **W** I add "Pilot" at 65% **T** it appears as a column and contributes `value × 0.65` to the weighted forecast | CRM |
| US-42 | Sofia | As a salesperson, I want activities on a timeline so that I know what happened and what is next | **G** an account **W** I log a call and schedule a task **T** both appear chronologically with type icons, author and timestamp; overdue tasks are visually distinct | CRM |
| US-43 | Sofia | As a salesperson, I want to record why a deal was lost so that we learn something | **G** an open deal **W** I close it as Lost **T** a loss reason is mandatory and selectable from a configurable list; without it the close is refused | CRM |
| US-44 | Priya | As an owner, I want CRM analytics so that I can judge the sales engine | **G** ≥20 closed deals **W** I open analytics **T** win rate, average cycle length, forecast vs. closed and a per-owner leaderboard are shown for the selected period | CRM |

### 4.10 Documents & data — 4

| ID | Persona | Story | Acceptance criteria | Module |
|---|---|---|---|---|
| US-45 | Sofia | As a salesperson, I want a professional PDF invoice or quote so that I can send it to a customer | **G** a posted invoice **W** I click Print **T** a paginated A4 PDF renders with company header, customer block, line table, tax summary and totals; Save-as-PDF writes a file to disk | Documents |
| US-46 | Priya | As an owner, I want the quote, PO and delivery note and statement as PDFs too so that all outward documents look consistent | **G** any of the five doc types **W** I print **T** all use one shared layout with the correct title, columns and totals for that type | Documents |
| US-47 | Marcus | As an accountant, I want to export any table to XLSX/CSV so that I can work outside the app | **G** any list with filters applied **W** I click Export **T** the file contains exactly the filtered, sorted, visible columns, with money as numbers and dates as ISO | Documents |
| US-48 | Priya | As an owner, I want an import wizard so that I can bring my existing data in | **G** a CSV of 200 customers with 3 bad rows **W** I complete mapping and validate **T** 197 rows are staged, 3 are listed with row number and reason, and I can commit the valid rows only | Data |

### 4.11 Settings — 5

| ID | Persona | Story | Acceptance criteria | Module |
|---|---|---|---|---|
| US-49 | Priya | As an owner, I want custom fields on entities so that NEXUS fits my industry without code | **G** settings → custom fields → Customer **W** I add "GSTIN" (text, required) **T** it appears on the customer form, is required on save, is exportable, and is filterable in saved views | Settings |
| US-50 | Priya | As an owner, I want gapless document numbering so that auditors find no holes | **G** prefix INV- padding 5 **W** I post three invoices **T** they are INV-00001..00003; deleting a draft does not consume a number; posted numbers are never reused | Settings |
| US-51 | Priya | As an owner, I want to configure taxes and currencies so that documents are correct locally | **G** a 20% tax marked inclusive **W** I bill 120.00 **T** net 100.00 + tax 20.00 is shown and journaled accordingly; the base currency cannot be changed once postings exist | Settings |
| US-52 | Priya | As an owner, I want local backup and restore so that my business survives a disk failure | **G** Settings → Backup **W** I click Backup **T** a consistent SQLite copy is written to a chosen path and integrity-checked; Restore validates the file, warns that current data will be replaced, and requires re-login | Settings |
| US-53 | Priya | As an owner, I want to read the audit log so that I can see who changed what | **G** any mutation history **W** I open the audit viewer **T** rows are filterable by user, entity, action and date, each showing before/after; the log cannot be edited or cleared from the UI | Settings |

### 4.12 UX shell — 5

| ID | Persona | Story | Acceptance criteria | Module |
|---|---|---|---|---|
| US-54 | All | As a user, I want a command palette so that I can reach anything in two keystrokes | **G** any route **W** I press Ctrl/Cmd+K and type "inv" **T** results are grouped (Records / Actions / Navigation), ranked, keyboard-navigable, and Enter navigates without a page flash | UX |
| US-55 | All | As a user, I want saved table views so that my daily filters persist | **G** a filtered, sorted, column-adjusted invoice list **W** I save it as "Overdue > 30d" **T** it reappears identically after restart and is selectable from a view dropdown | UX |
| US-56 | All | As a user, I want to work entirely by keyboard so that I do not need the mouse | **G** any list or form **W** I press `?` **T** a cheat sheet shows all shortcuts; `g d` goes to dashboard, `n` creates in context, `Esc` closes overlays, focus is always visible | UX |
| US-57 | All | As a user, I want dark mode and density control so that the app suits my screen and eyes | **G** Settings → Appearance **W** I pick Dark + Compact **T** the whole app switches via semantic tokens (no hard-coded colours), tables tighten row height, and the choice persists per user | UX |
| US-58 | All | As a user, I want global search across entities so that I can find a record without knowing its module | **G** a customer "Acme" and invoice INV-00012 **W** I search "acme" **T** matching accounts, contacts, deals, invoices and orders are returned with type badges and jump directly to the record | UX |

---

## 5. Screen inventory

Route contract for the architect and engineer. **72 screens.** Shortcuts: `⌘K` palette · `?` cheat sheet · `n` new · `e` edit · `/` focus search · `Esc` close · `⌘S` save.

| Route | Screen | Module | Primary actions | Empty state | Shortcuts |
|---|---|---|---|---|---|
| `/onboarding` | Setup wizard (5 steps) | Onboarding | Next, Back, Apply preset, Load demo, Skip licence, Finish | n/a (always starts at step 1) | `Enter` next |
| `/login` | Login | Auth | Sign in, Show password | First-run hint → wizard | `Enter` |
| `/locked` | Lock screen | Auth | Unlock with password, Switch user | n/a | `Enter` |
| `/dashboard` | Dashboard | Dashboard | Drill KPI, Open attention item, Change period | "No activity yet — create your first invoice" + demo-data CTA | `g d` |
| `/search` | Global search results | UX | Filter by type, open record | "No matches for …" | `/` |
| `/finance/accounts` | Chart of accounts | Finance | New account, Expand/collapse, Edit, Archive | "No accounts — apply an industry preset or add one" | `n`, `e` |
| `/finance/accounts/:id` | Account detail + GL preview | Finance | Edit, View ledger, Archive | "No postings yet" | `e` |
| `/finance/journal-entries` | Journal entries list | Finance | New entry, Post, Reverse, Export | "No journal entries" | `n`, `⌘S` |
| `/finance/journal-entries/new` | Journal entry editor | Finance | Add line, Remove line, Post, Save draft, Balance helper | n/a | `⌘S`, `⌘Enter` post |
| `/finance/journal-entries/:id` | Journal entry detail | Finance | Reverse, Print, View source doc | n/a | `e` |
| `/finance/invoices` | Invoices (AR) list | Finance | New invoice, Post, Record payment, Export | "No invoices — create your first one" | `n` |
| `/finance/invoices/new` | Invoice builder (split view) | Finance | Add line, Save draft, Post, Print, Preview | n/a | `⌘S`, `⌘P` |
| `/finance/invoices/:id` | Invoice detail (split view) | Finance | Post, Record payment, Print, Duplicate, Void | n/a | `⌘P` |
| `/finance/bills` | Bills (AP) list | Finance | New bill, Post, Record payment, Export | "No bills" | `n` |
| `/finance/bills/new` | Bill builder | Finance | Add line, Save draft, Post, Print | n/a | `⌘S` |
| `/finance/bills/:id` | Bill detail | Finance | Post, Record payment, Match status, Print | n/a | `⌘P` |
| `/finance/payments` | Payments list (in/out) | Finance | New payment, Allocate, Export | "No payments recorded" | `n` |
| `/finance/payments/:id` | Payment detail | Finance | Allocate to invoices/bills, Print receipt | n/a | — |
| `/finance/reports/trial-balance` | Trial balance | Finance | Set period, Drill to GL, Export, Print | "No postings in this period" | — |
| `/finance/reports/pnl` | Profit & loss | Finance | Set range, Toggle comparative, Drill, Export | "No income or expenses in this period" | — |
| `/finance/reports/balance-sheet` | Balance sheet | Finance | Set as-of date, Drill, Export | "No balances" | — |
| `/finance/reports/general-ledger` | General ledger | Finance | Filter account, Drill to journal, Export | "No entries for this account" | — |
| `/finance/periods` | Period management | Finance | Lock period, Unlock (audited), View lock history | "No periods closed" | — |
| `/inventory/products` | Products list | Inventory | New product, Edit, Adjust stock, Export, Import | "No products — add one or import a CSV" | `n` |
| `/inventory/products/new` | Product editor | Inventory | Save, Save & new, Cancel | n/a | `⌘S` |
| `/inventory/products/:id` | Product detail | Inventory | Edit, View moves, View valuation, Adjust | "No stock movements yet" | `e` |
| `/inventory/warehouses` | Warehouses & locations | Inventory | New warehouse, New location, Archive | "No warehouses — create your first" | `n` |
| `/inventory/stock` | On-hand quants | Inventory | Filter product/location, Adjust, Export | "No stock on hand" | `/` |
| `/inventory/moves` | Stock moves ledger | Inventory | New move, Filter by type, Export | "No stock moves" | `n` |
| `/inventory/moves/new` | Stock move form | Inventory | Post move, Save draft | n/a | `⌘Enter` |
| `/inventory/valuation` | Inventory valuation | Inventory | Set as-of date, Group by warehouse, Export | "No valuation data" | — |
| `/purchasing/vendors` | Vendors list | Purchasing | New vendor, Edit, Export | "No vendors yet" | `n` |
| `/purchasing/vendors/:id` | Vendor detail | Purchasing | Edit, New PO, New bill, Disable | "No transactions with this vendor" | `e` |
| `/purchasing/orders` | Purchase orders list | Purchasing | New PO, Receive, Create bill, Export | "No purchase orders" | `n` |
| `/purchasing/orders/new` | PO builder (split view) | Purchasing | Add line, Save draft, Confirm, Print | n/a | `⌘S`, `⌘P` |
| `/purchasing/orders/:id` | PO detail | Purchasing | Confirm, Receive goods, Create bill, Print, Cancel | n/a | `⌘P` |
| `/purchasing/receipts` | Goods receipts list | Purchasing | New receipt, Create bill, Print delivery note | "No receipts" | `n` |
| `/purchasing/receipts/:id` | Receipt detail | Purchasing | Post, Create bill, Print | n/a | `⌘P` |
| `/sales/customers` | Customers list | Sales | New customer, Edit, New quote, Export | "No customers — add one or convert a lead" | `n` |
| `/sales/customers/:id` | Customer detail | Sales | Edit, New quote, New invoice, View AR, Peek contacts | "No documents for this customer" | `e` |
| `/sales/quotations` | Quotations list | Sales | New quote, Convert to order, Print, Export | "No quotations" | `n` |
| `/sales/quotations/new` | Quote builder (split view) | Sales | Add line, Save draft, Mark sent, Print | n/a | `⌘S`, `⌘P` |
| `/sales/quotations/:id` | Quote detail | Sales | Send, Accept, Convert to order, Print, Expire | n/a | `⌘P` |
| `/sales/orders` | Sales orders list | Sales | New order, Create delivery, Create invoice, Export | "No sales orders" | `n` |
| `/sales/orders/:id` | Sales order detail | Sales | Confirm, Deliver, Create invoice, Print | n/a | `⌘P` |
| `/sales/deliveries` | Deliveries list | Sales | New delivery, Post, Print delivery note | "No deliveries" | `n` |
| `/sales/price-lists` | Price lists | Sales | New list, Add items, Set validity, Archive | "No price lists — base prices will be used" | `n` |
| `/crm/accounts` | Accounts list | CRM | New account, Peek, Open, Export | "No accounts — convert a lead or add one" | `n` |
| `/crm/accounts/:id` | Account record (timeline spine) | CRM | Edit inline, Log activity, New deal, Peek contacts | "No activity yet — log your first touch" | `e` |
| `/crm/contacts` | Contacts list | CRM | New contact, Peek, Export | "No contacts" | `n` |
| `/crm/leads` | Leads list | CRM | New lead, Qualify, Convert, Disqualify | "No leads — add one or import a CSV" | `n` |
| `/crm/leads/:id` | Lead detail | CRM | Edit, Log activity, Convert | "No activity yet" | `e` |
| `/crm/leads/:id/convert` | Lead conversion wizard | CRM | Pick/create account, Pick/create contact, Create deal, Confirm (atomic) | n/a | `Enter` |
| `/crm/deals` | Deals kanban | CRM | Drag stage, New deal, Toggle table/board, Filter owner | "No deals — add your first opportunity" | `n`, `b` board |
| `/crm/deals/:id` | Deal detail | CRM | Edit inline, Move stage, Log activity, Mark won/lost | "No activity yet" | `e` |
| `/crm/activities` | Activity list (all types) | CRM | New activity, Complete task, Filter type/owner | "No activities scheduled" | `n` |
| `/crm/analytics` | CRM analytics | CRM | Set period, Switch metric, Drill to deals | "Not enough closed deals to compute win rate" | — |
| `/print/:docType/:id` | Print preview (invoice/quote/PO/delivery/statement) | Documents | Print, Save as PDF, Close | n/a | `⌘P` |
| `/data/import` | Import wizard (4 steps) | Data | Upload, Map columns, Validate, Commit | "Drop a CSV or XLSX to begin" | `Enter` |
| `/settings/company` | Company profile | Settings | Save section, Upload logo | n/a | `⌘S` |
| `/settings/users` | Users | Settings | New user, Reset password, Disable | "Only you exist — add your team" | `n` |
| `/settings/roles` | Roles & permissions | Settings | New role, Toggle permission, Duplicate | "No custom roles — using defaults" | `n` |
| `/settings/custom-fields` | Custom fields | Settings | New field, Reorder, Deactivate | "No custom fields on this entity" | `n` |
| `/settings/industry` | Industry presets | Settings | Preview, Apply, View diff | "No preset applied" | — |
| `/settings/numbering` | Document numbering | Settings | Edit scheme, Preview next, Reset counter (audited) | n/a | `⌘S` |
| `/settings/taxes` | Taxes | Settings | New tax, Set inclusive/compound, Archive | "No taxes defined" | `n` |
| `/settings/currencies` | Currencies & rates | Settings | Add currency, Set rate, Set base | "Base currency only" | `n` |
| `/settings/backup` | Backup & restore | Settings | Backup now, Restore, Open folder, Verify | "No backups yet" | — |
| `/settings/audit-log` | Audit log viewer | Settings | Filter, Inspect before/after, Export | "No audit entries" | `/` |
| `/settings/license` | Licence | Settings | Activate, Deactivate, Copy machine ID | "Community edition — no key required" | — |
| `/settings/security` | Security policy | Settings | Set idle timeout, Password policy, Session list | n/a | `⌘S` |
| `/settings/appearance` | Appearance | Settings | Theme, Density, Accent | n/a | — |

---

## 6. Core flows

### 6.1 First run → usable system
1. Launch → no DB found → `/onboarding` step 1: company name, legal name, address, tax ID, logo.
2. Step 2: industry preset (Manufacturing / Wholesale-Retail / Services / Construction / Education / NGO / Logistics) → preview panel shows modules enabled, COA template, tax set, numbering schemes, sample UoMs. Confirm applies atomically.
3. Step 3: base currency, fiscal-year start month, date format, number format.
4. Step 4: admin user (name, username, password, confirm) — password policy enforced live.
5. Step 5: licence key (optional; skip → Community) → "Load demo data" checkbox.
6. Finish → DB created, migrations run, preset applied, seed executed in one transaction → auto-login → `/dashboard`.
7. If seeding failed, the app still starts with an empty DB and shows a non-blocking error toast with a retry action.

### 6.2 Quote → order → invoice → payment → GL
1. Sofia creates a quotation on `/sales/quotations/new`: customer, expiry date, lines (product, qty, price auto-resolved from price list, discount, tax).
2. Save draft → `Draft`. "Mark sent" → `Sent`. Customer accepts → `Accepted`.
3. Convert → sales order created with all lines, links both ways (`quote_id` on order). Quote becomes `Converted`.
4. Confirm order → `Confirmed`; stock availability checked and shown per line (warning, not block).
5. Deliver → delivery record created, stock moves posted (issue from warehouse), order line `delivered_qty` increases; order becomes `Partially delivered` or `Delivered`.
6. Create invoice from order → invoice `Draft` with delivered quantities pre-filled → Post.
7. Posting runs in one transaction: invoice status `Posted`, gapless number assigned, AR journal created (Dr Accounts Receivable / Cr Revenue / Cr Tax Payable), audit rows written, document event emitted.
8. Marcus records a payment on `/finance/payments` → allocates to the invoice → invoice `Partially paid` or `Paid`, journal Dr Bank / Cr AR.
9. Dashboard revenue KPI and AR KPI reflect the change on next load; invoice appears in the customer's record timeline.

### 6.3 PO → receipt → bill → 3-way match
1. Dan creates a PO (vendor, lines, expected date) → Confirm → `Confirmed`.
2. Goods arrive in two shipments. Receipt #1 for 40 of 100 → post → stock moves (receipt to warehouse), PO shows 40 received / 60 outstanding, status `Partially received`.
3. Receipt #2 for 60 → PO status `Fully received`.
4. Marcus creates a vendor bill from a receipt → quantities and PO prices pre-fill; `po_id` and `receipt_ids` recorded.
5. Match check on post: line price vs PO price within `tolerance_pct` **and** line total delta within `tolerance_abs`; quantity billed ≤ quantity received.
6. Within tolerance → posts silently, AP journal created (Dr Inventory/Expense / Cr Accounts Payable), bill `Posted`.
7. Outside tolerance → bill enters `Match exception` with the offending lines highlighted; posting requires a user holding `purchasing.bill.approve_exception`, and the override is audited with a reason.
8. Payment → bill `Paid`; vendor balance and AP ageing update.

### 6.4 Lead → deal → won → sales order
1. Sofia creates a lead on `/crm/leads` (name, company, source, estimated value, owner).
2. Logs activities (call, meeting) → they appear on the lead timeline.
3. Qualify → `Qualified`. Click Convert → wizard step 1 chooses "create new account" or "link existing"; step 2 same for contact; step 3 sets deal name, value, stage, probability, expected close.
4. Confirm → **single transaction** creates account + contact + deal, marks lead `Converted`, writes `converted_to` links and three audit rows. Any failure rolls back everything and surfaces the reason.
5. Deal appears in `/crm/deals` in the first stage; Sofia drags it forward as it progresses (each move logged as an activity).
6. Mark Won → requires a value; deal `Won`, counted in win rate and forecast-actual. (Mark Lost requires a loss reason.)
7. "Create sales order" on the won deal → prefills customer from the account, lines from the deal products, links `deal_id`; continues into flow 6.2 at step 3.

### 6.5 Stock receipt → move → count
1. Dan opens `/inventory/moves/new`, type `Receipt`, product, warehouse location, qty 50, unit cost.
2. Post → one immutable move row (`type`, `product`, `from=null`, `to=location`, `qty`, `unit_cost`, `user`, `at`); on-hand for that product×location increases by 50.
3. Transfer 12 to Bay 3 → two-sided move; total on-hand unchanged, per-location balances change.
4. Physical count finds 47 (3 damaged) → adjustment move of −3 with a reason code; on-hand becomes 47; a variance report row is written.
5. Valuation recomputes per the product's cost method; `/inventory/valuation` shows the new value; the product's low-stock flag clears if above reorder point.
6. Every move is visible on the product's "Moves" tab with running balance.

### 6.6 Licence activation
1. `/settings/license` (or onboarding step 5) → paste key string (`NEXUS-<base64 payload>.<base64 signature>`).
2. App verifies the Ed25519 signature with the embedded public key → invalid signature → clear error, no state change.
3. Decode payload: edition, licensee name, machine binding, issued date, optional seat label. **No expiry field is honoured as a hard stop** — perpetual by construction.
4. Compare payload machine binding with the locally computed machine ID hash → mismatch → refuse with "This key belongs to another machine; deactivate it there first."
5. Success → edition stored, UI unlocks Pro/Enterprise modules, audit row `license.activated`, licence page shows edition + licensee + machine ID (copyable).
6. Startup: verify stored licence; if the signature fails or the clock moved backwards since last run → warn banner only, all features remain available.

---

## 7. Business rules catalogue (testable)

| ID | Rule | Test |
|---|---|---|
| BR-01 | A journal entry may only be posted if Σ debits == Σ credits, compared in minor units | Post 1000/999 → rejected, message states the delta |
| BR-02 | Posted journal entries, invoices, bills, POs and stock moves are immutable; corrections are reversing entries | No UPDATE path exists for `status='posted'`; UI fields read-only |
| BR-03 | Reversal creates a new entry with mirrored lines and `reverses_id`; the original is never touched | Reverse twice → two distinct reversal entries |
| BR-04 | Posting into a locked period is refused, naming the lock date and locking user | Lock Jan, post Jan → rejected |
| BR-05 | Money is stored as integer minor units; all arithmetic is integer or decimal, never float | No `number` arithmetic on money in code; round-trip 0.1+0.2 == 0.3 |
| BR-06 | Rounding is half-up at the document level only; line amounts are exact | 3 lines of 33.335 at 2dp → document total 100.01, not 100.02 |
| BR-07 | Tax-inclusive documents back-compute net from gross so that net + tax == gross exactly | Gross 120.00 @20% incl → net 100.00, tax 20.00 |
| BR-08 | Document numbers are gapless per type per fiscal year; drafts reserve nothing; posting assigns atomically | Delete draft → next posted number is unchanged |
| BR-09 | A posted document's number is never reused or renumbered | Attempt renumber → refused |
| BR-10 | Stock on-hand is derived from moves; there is no direct quantity write path | No UI or IPC method accepts a quantity set |
| BR-11 | Negative stock is blocked unless the user holds `inventory.stock.allow_negative`; the override is audited with a reason | Issue 15 of 10 → refused; with permission → allowed + audit row |
| BR-12 | Transfer moves are two-sided and conserve total quantity | Transfer 30 of 100 → total stays 100 |
| BR-13 | 3-way match requires billed qty ≤ received qty ≤ ordered qty, and price within BOTH `tolerance_pct` and `tolerance_abs` | Bill 101 of 100 received → exception; price +1.9% with 2%/50 cap → pass |
| BR-14 | A bill outside tolerance cannot post without `purchasing.bill.approve_exception` and a non-empty reason | Post without permission → refused |
| BR-15 | Lead conversion is one transaction: account + contact + deal all commit or none do | Force failure at deal insert → no account/contact rows exist |
| BR-16 | Closing a deal as Lost requires a non-empty loss reason from the configured list | Close Lost with no reason → refused |
| BR-17 | Price resolution order: contract price → customer price list → default price list → product base price; first valid, non-expired match wins | Customer on expired list → falls through to default |
| BR-18 | A quotation past its expiry date cannot convert to an order without `sales.quotation.override_expiry` | Expired quote → blocked; with permission → allowed + audit |
| BR-19 | Payment allocation may not exceed the open balance of the target document | Allocate 1200 to a 1000 invoice → refused |
| BR-20 | Permissions are the union of the user's roles; denial is enforced in the main process, not only the UI | Call the IPC action directly without permission → rejected |
| BR-21 | Every mutation writes an audit row `{actor, at, entity, entityId, action, before, after}`; audit rows cannot be edited or deleted from the UI | Attempt delete via UI → no affordance; log is append-only |
| BR-22 | Deleting a record with downstream documents or audit history is refused; use Cancel/Void/Disable instead | Delete a customer with invoices → refused with a link list |
| BR-23 | Base currency and fiscal-year start cannot change once any posting exists | Attempt change → refused with explanation |
| BR-24 | Licence verification is offline-only; a failed signature never destroys data and a clock rollback only warns | Set clock back 1 year → banner, app fully usable |
| BR-25 | Community edition is fully functional for its module set and never expires or nags repeatedly | No expiry logic path exists; notice is dismissible and persists as dismissed |

---

## 8. Design principles & visual direction

**Principles.** (1) *Density is respect* — an accountant wants 40 rows on screen, not 8 cards. (2) *Every number is clickable* — an aggregate that cannot be drilled is a rumour. (3) *State is always visible* — document status, unsaved changes, active filters, current user. (4) *Destructive actions are reversible or refused* — reverse, don't edit; disable, don't delete. (5) *Keyboard parity* — every mouse action has a shortcut; nothing is drag-only. (6) *Configuration over code* — if a customer would ask for it, it is a setting.

**Grid & tokens.** 8pt spacing scale (4/8/12/16/24/32/48). 4px radius inputs, 6px cards, 999px chips. 1px borders preferred over shadows; shadows only for overlays (drawer, modal, palette). Semantic tokens only — `--bg --surface --surface-2 --border --text --text-muted --accent --success --warning --danger` with light/dark pairs; no hex literals in components. Two UI type sizes (13px body, 12px meta) + 28px KPI numerals; `font-variant-numeric: tabular-nums` on all numeric columns. Self-hosted OFL font — **no CDN**.

**Shell anatomy.** Collapsible left sidebar (240px / 64px icon rail) grouped by module with the active module's sub-routes expanded; topbar with global search, ⌘K hint, period selector (dashboard/report routes only), density toggle, theme toggle, user menu. Content area max-width unconstrained (tables use full width). Breadcrumb for drill paths. Sticky page header with title + status chip + primary action.

**Command palette.** `Ctrl/Cmd+K` from anywhere, including inside inputs. Fuzzy match over: navigation routes, record titles (customers, products, invoices by number), and actions ("new invoice", "lock period"). Grouped, ranked, recent-first, max 8 per group. `↑↓` navigate, `Enter` run, `Esc` dismiss, `Tab` cycle groups. Never a full-page reload.

**Table behaviour.** Sticky header, virtualized body, 40px compact / 52px comfortable rows, right-aligned tabular money, left-aligned text, status chips, row hover reveals quick actions, click row → detail, `Space` → peek drawer. Toolbar: saved view dropdown → filter chips → search → density → columns → export → primary create. Filters/sort/columns persist per view per user. Selecting rows enables bulk export; there is no bulk delete.

**Form behaviour.** Two-column layout, labels above inputs, required marked with `*`, inline validation on blur (not on keystroke), errors below the field with `aria-describedby`. Save is disabled until dirty. `⌘S` saves. Unsaved-changes guard on navigation. Document forms use the split-view builder (form left 58%, live PDF preview right 42%, 250ms debounce). Relation fields open a peek drawer rather than navigating away.

**Feedback rules.** Optimistic for drag-drop and inline edits with rollback toast on failure. Toasts bottom-right, auto-dismiss 4s (errors persist until dismissed), max 3 stacked. Destructive actions require a typed confirmation or an explicit reason field. Loading uses skeletons matching final layout, never a spinner over the whole page. Errors state what happened, why, and the next action — never a bare "Error".

---

## 9. Accessibility & performance budgets

| Area | Requirement |
|---|---|
| **WCAG 2.2 AA** | Contrast ≥4.5:1 body / ≥3:1 large and UI borders; visible 2px focus ring on every interactive element; no keyboard traps; overlays trap focus and restore it on close |
| Keyboard | 100% of flows completable without a mouse; logical DOM order; `Esc` closes any overlay; skip-to-content link |
| Screen readers | Semantic landmarks (`nav/main/aside`), `aria-live="polite"` for toasts and async validation, table headers with `scope`, form errors linked via `aria-describedby` |
| Motion | Respect `prefers-reduced-motion`; no animation >200ms except drawer/palette (≤250ms) |
| Targets | Min 32×32px hit area for icon buttons, 40px for primary |
| i18n | All strings via keys from day one; no concatenated sentences; dates/numbers via locale formatter; no text baked into images |
| **Cold start** | ≤3.0s to interactive dashboard on a 4-core/8GB machine with a 100k-row DB |
| **Route change** | ≤300ms to painted content for any list/detail route |
| **Tables** | Smooth (≥50fps) scroll at 10,000+ rows via virtualization; filter application ≤150ms |
| **Writes** | Posting a document ≤200ms perceived (optimistic UI, commit in background); DB commit ≤500ms |
| **Bundle** | Renderer JS ≤1.5MB gzipped; all assets local; no network requests at runtime (verifiable in DevTools) |
| **DB** | 100k documents + 500k journal lines remain within budget; integrity check on backup ≤10s |

---

## 10. Success metrics, risks, open questions

**v1 success metrics.**

| Metric | Target |
|---|---|
| Install → dashboard with seeded data | ≤3 min, zero network requests |
| First-run completion rate (wizard finished / launched) | ≥90% |
| Time to first real posted invoice for a new user | ≤15 min |
| Journal integrity | 100% of posted entries balanced; 0 float-money bugs in QA |
| Crash-free sessions | ≥99.5% |
| Cold start p95 | ≤3.0s |
| Story coverage | All 58 P0 stories pass acceptance |

**Risks.**

| # | Risk | Mitigation |
|---|---|---|
| R1 | Scope vs. one-session delivery — 12 P0 areas is a large surface | Metadata-driven entities + manifest registry so screens are generated, not hand-built; P1/P2 explicitly cut |
| R2 | Electron adds ~100MB and a security surface vs. Tauri | Hardened `contextIsolation`, `sandbox`, CSP, no `nodeIntegration` in renderer; see §11 |
| R3 | Offline licensing can be trivially bypassed by editing local state | Accept it: the goal is honesty enforcement, not DRM. Signature verification raises the bar without punishing legitimate users |
| R4 | Print-to-PDF fidelity across OSes | One shared print stylesheet, test on all three platforms, fixed A4 template |
| R5 | Derived on-hand/balances get slow at scale | Materialized summary tables rebuildable from source rows; indexes on `(product, location)`, `(account, period)` |
| R6 | Custom fields + saved views interaction | Custom values stored as JSON with a documented path convention; filters support text/number/date/select in v1 |
| R7 | "Cross-industry" degenerates into per-industry code branches | Presets are data-only; PR review rule: no industry string may appear in business logic |

**Open questions.** (1) Should an industry preset also set the default landing module? (2) Is HTML→print sufficient for all five document types or is a PDF library needed for page numbers/headers? (3) Machine-fingerprint policy on hardware change — warn-and-reactivate, or hard fail? (Proposed: warn.) (4) Do custom fields participate in saved-view filters in v1? (Proposed: yes, for scalar types.)

---

## 11. Deviation log

| Item | Original spec | Delivered | Impact |
|---|---|---|---|
| **Runtime shell** | Tauri (Rust + system webview) | **Electron (Chromium + Node)** — customer override | See consequences below |

**Why Electron.** (1) **Crypto availability** — Ed25519 licence verification and Argon2/scrypt password hashing are mature, synchronous, and identical across platforms in Node's `crypto`; no Rust toolchain or FFI bridge is needed for the licensing core. (2) **Simpler native module story** — SQLite (`better-sqlite3`) is a first-class, prebuilt, well-documented dependency; no separate Rust build step, no cross-compilation matrix. (3) **PDF fidelity** — Chromium's print pipeline gives identical A4 output on all three platforms, which directly serves the five document types. (4) **Team velocity** — one language (TypeScript) across main, preload, and renderer; a small team ships in one session.

**Consequences we accept.**

| Consequence | Detail | Mitigation |
|---|---|---|
| Larger binary | ~90–120MB installer vs. ~10MB for Tauri | Accepted; it is a desktop ERP, not a utility |
| Larger memory footprint | Chromium baseline ~150MB RSS | Acceptable on target hardware; single window |
| Security surface | Node in main process; renderer must never reach it | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, narrow typed preload API, strict CSP (`default-src 'self'`), no remote content, no `shell.openExternal` on user data |
| Manual hardening required | Tauri's capability model is deny-by-default; Electron is not | Explicit IPC allow-list, one handler per action with permission checks server-side (main process) |
| No built-in updater we can trust | Auto-update would phone home | No auto-update in v1; offline update bundles are P1 |
| No Rust-level memory safety | Main process is JS | All DB access through one prepared-statement layer; no dynamic SQL from user input |

**Other deviations.** None. The Tauri→Electron change does not alter the offline mandate, the licensing model, the data model, or any P0 requirement.

---

*End of PRD. Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE.*
