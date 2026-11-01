<!-- Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. -->

# NEXUS — Engineering Conventions

**This file is the contract.** If code disagrees with it, the code is wrong. Every rule here exists because of a specific failure mode listed in `ARCHITECTURE.md §F`/`§J` or a business rule `BR-xx` in `PRD.md §7`.

---

## 1. Copyright header (mandatory, first line of every file)

`.ts`, `.tsx`, `.css` — copy verbatim, one line, no blank line before it:

```ts
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
```

`.md`, `.html`, `.mjs`:

```html
<!-- Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. -->
```

`.js`/`.mjs` and JSON-with-comments use the `/* … */` form. `.json` files that cannot hold comments (`package.json`, `tsconfig.json`) carry no header. Checked in T11 with:

```bash
for f in $(git ls-files 'src/**/*.ts' 'src/**/*.tsx' 'src/**/*.css'); do
  head -1 "$f" | grep -q "NEXUS Proprietary Perpetual License" || echo "MISSING: $f";
done
```

---

## 2. Import order

Five groups, blank line between, alphabetical inside each group. Enforced by ESLint `import/order` with `newlines-between: 'always'`.

```ts
/* Copyright (c) 2026 arfanayub0. … */

// 1. node builtins — main process only
import { createHash } from 'node:crypto';
import path from 'node:path';

// 2. external packages
import { useState } from 'react';

// 3. shared contracts (always via the @shared alias)
import { type Invoice, ENTITIES } from '@shared/types';
import { CHANNELS } from '@shared/channels';
import { addCents, formatMoney } from '@shared/money';

// 4. local absolute (@main / @renderer aliases)
import { getConn } from '@main/db/connection';
import { audit } from '@main/services/audit';

// 5. relative
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
```

Rules: type-only imports use `import type` / inline `type`. Never `import * as` from a package except `node:*`. Never import a main-process module from the renderer — the build will fail on `node:` resolution and that is the point.

Path aliases (in `tsconfig.json`, `tsconfig.main.json`, `vite.config.ts`):

```
@shared/*   → src/shared/*
@main/*     → src/main/*
@renderer/* → src/renderer/*
```

---

## 3. Naming

| Thing | Convention | Example |
|---|---|---|
| File (component) | `PascalCase.tsx`, one primary export | `DataTable.tsx` |
| File (logic) | `camelCase.ts` | `useQuery.ts`, `money.ts` |
| Component | `PascalCase`, named export, **no default export** | `export function DataTable<T>(…)` |
| Hook | `useXxx` | `useQuery`, `useSession` |
| Service (main) | `XxxService` object literal + exported singleton | `export const finance = { postInvoice, … }` |
| IPC channel | `module.resource.action` lowerCamel | `finance.invoices.post` |
| Permission | `module.resource.action` lowerCamel, matches the channel where 1:1 | `finance.invoice.post` |
| SQL table | `snake_case`, plural | `journal_lines` |
| SQL column | `snake_case`, unit-suffixed | `total_cents`, `qty_milli`, `rate_bp` |
| TS type | `PascalCase`; DTO suffix only when it differs from the row | `Invoice`, `InvoiceLine`, `MatchReport` |
| Money variable | suffix `Cents` | `subtotalCents`, `taxCents` |
| Quantity variable | suffix `Milli` | `qtyMilli`, `deliveredMilli` |
| Rate variable | suffix `Bp` | `rateBp`, `probabilityBp` |
| Boolean | `is*` / `has*` / `can*` | `isPostable`, `hasPostings`, `canApprove` |
| Event/handler prop | `onXxx` / `handleXxx` | `onPost` / `handlePost` |
| i18n key | `module.screen.element` | `finance.invoice.postButton` |

No abbreviations except `qty`, `id`, `no`, `amt` (never `amt` — use `Cents`), `bp`, `ms`, `db`, `ctx`, `props`.

---

## 4. Money, quantity and rate handling

**The only place arithmetic happens on money is `src/shared/money.ts`.** Everywhere else, values move untouched.

```ts
// src/shared/money.ts (public surface — do not add arithmetic elsewhere)
export type Cents = number & { readonly __cents: unique symbol };
export const cents = (n: number): Cents => { if (!Number.isInteger(n)) throw new Error('cents must be integer'); return n as Cents; };

export const addCents   = (...v: Cents[]): Cents => cents(v.reduce((a, b) => a + b, 0));
export const subCents   = (a: Cents, b: Cents): Cents => cents(a - b);
export const mulQty     = (priceCents: Cents, qtyMilli: number): Cents => cents(Math.round((priceCents * qtyMilli) / 1000));
export const applyBp    = (base: Cents, bp: number): Cents => cents(Math.round((base * bp) / 10000));   // half-up
export const roundHalfUp   = (n: number, dp = 0): number => { const f = 10 ** dp; return Math.sign(n) * Math.round(Math.abs(n) * f) / f; };
export const roundHalfEven = (n: number, dp = 0): number => { /* banker's, exact for integers */ };
export const formatMoney = (v: Cents, currency: string, locale: string): string => …;  // edge only
export const parseMoney  = (s: string, decimals: number): Cents => …;                  // UI input only
```

**Hard rules**

| Rule | Enforcement |
|---|---|
| A `_cents` column is `INTEGER`; a `Cents` variable never meets `parseFloat` | Review + `grep -rn "parseFloat\|toFixed" src/main` must be empty |
| Never `a * b` on two `Cents`; never `a / 100` outside `money.ts` | ESLint `no-restricted-syntax` on `BinaryExpression` where either operand name ends in `Cents` |
| Tax per line = `roundHalfEven`; document total = `roundHalfUp` (BR-06) | `finance.ts` uses `computeLine()` and `computeDocumentTotals()` only |
| Inclusive tax is **back-computed**: `tax = roundHalfEven(gross × r/(1+r))`, `net = gross − tax` | `computeLine()` has one branch, asserted by unit tests |
| Format at the edge only — components receive numbers and call `format.money()` | No `Intl.NumberFormat` outside `renderer/lib/format.ts` |
| Quantities are milli-units; a UI field labelled "Qty" multiplies by 1000 on save and divides on load | `Field.tsx` `QtyInput` is the only converter |

```ts
// correct
const lineNet = subCents(mulQty(unitPriceCents, qtyMilli), applyBp(mulQty(unitPriceCents, qtyMilli), discountBp));
// wrong — float, unrounded, wrong order
const lineNet = unitPrice * qty * (1 - discount) * 100;
```

---

## 5. Dates and identifiers

```ts
// src/shared/dates.ts
export const nowIso = (): string => new Date().toISOString();          // '2026-02-11T09:41:00.000Z'
export const todayIso = (): string => nowIso().slice(0, 10);           // '2026-02-11'
export const addDays = (iso: string, n: number): string => …;
export const addMonths = (iso: string, n: number): string => …;
export const periodOf = (dateIso: string, fiscalStartMonth: number): { start: string; end: string } => …;
export const formatDate = (iso: string, locale: string, pattern: string): string => …;
```

- Storage is **always** ISO-8601 UTC with milliseconds; display is **always** via `format.date()` using the company's `date_format`.
- Date-only columns (`invoices.date`, `due_date`) store `YYYY-MM-DD`; timestamps store full ISO.
- `Date` objects never enter a payload or cross IPC.
- IDs: `crypto.randomUUID()` in the service layer, never in the renderer, never in SQL (`DEFAULT`).
- Document numbers come from `numbering.next()` inside the posting transaction — never generated in the UI, never reused.

---

## 6. Error handling

**Main process.** Throw one of exactly five error types; `ipc.ts` maps them to codes. Anything else becomes `INTERNAL` with a generic message.

```ts
// src/main/ipc.ts exports these
export class AppError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) { super(message); }
}
export const validation = (field: string, msg: string) => new AppError('VALIDATION', msg, { field });
export const notFound   = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden  = (perm: string) => new AppError('FORBIDDEN', `Missing permission: ${perm}`);
export const conflict   = (msg: string) => new AppError('CONFLICT', msg);
```

```ts
// service pattern — never throw a raw SQLite/JS error at the boundary
export function postInvoice(id: string): Invoice {
  const inv = conn.one<InvoiceRow>('SELECT * FROM invoices WHERE id = ?', [id]);
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'draft') throw conflict(`Invoice ${inv.number} is ${inv.status} and cannot be posted`);
  if (inv.total_cents === 0) throw validation('lines', 'Cannot post an invoice with a zero total');
  …
}
```

| Never | Instead |
|---|---|
| `throw new Error('sqlite constraint failed')` | `throw conflict('SKU already used by Widget A')` |
| Leaking a stack or SQL text to the renderer | Log it in main (`console.error` + audit `meta_json`), return a human sentence |
| `try { … } catch {}` | Catch, map, rethrow — or don't catch |
| Validating in the component only | Validate in `ipc.ts` (shape) **and** in the service (business) |

**Renderer.** `api.invoke` throws `ApiError` with `.code`. Handle by code, not by message.

```ts
try {
  await api.invoke('finance.invoices.post', { id });
  invalidate(['invoices', 'journal', 'dashboard']);
  toast.success('Invoice posted');
} catch (e) {
  if (e instanceof ApiError && e.code === 'VALIDATION') { toast.error(e.message); return; }
  toast.error('Could not post the invoice. Nothing was changed.', { sticky: true });
}
```

User-facing error copy states **what happened, why, and the next action** — never "Error", never a code alone (PRD §8).

---

## 7. Adding a new IPC channel — the 5-file checklist

Miss one and the build or the allow-list breaks. Do them in this order.

**1. `src/shared/channels.ts`** — add the literal name.

```ts
export const CHANNELS = [
  …
  'finance.invoices.post',
  'finance.invoices.unpost',   // ← new
] as const;
export type Channel = (typeof CHANNELS)[number];
```

**2. `src/shared/schemas.ts`** — add the payload validator (shape only, no business rules).

```ts
export const SCHEMAS: Partial<Record<Channel, Validator>> = {
  'finance.invoices.unpost': v.obj({ id: v.id(), reason: v.str({ min: 3, max: 200 }) }),
};
```

**3. `src/shared/permissions.ts`** — add the permission if it is new.

```ts
export const PERMISSIONS = {
  …
  'finance.invoice.unpost': { module: 'finance', label: 'Unpost a draft invoice', risk: 'high' },
} as const;
```

**4. `src/main/ipc.ts`** — register with its permission and handler. The permission field is **required by the type**, so a channel cannot be registered without one (this is what makes `BR-20` structural).

```ts
register({
  channel: 'finance.invoices.unpost',
  permission: 'finance.invoice.unpost',
  handler: (payload) => finance.unpostInvoice(payload.id, payload.reason),
  // mutating: true by default → runs in a transaction and appends an audit row
});
```

**5. `src/preload/index.ts`** — nothing to do if it imports `CHANNELS` (it does). If you hard-coded a name, delete it and import instead.

Then: **6. `src/renderer/lib/api.ts`** — add the typed signature so pages get autocomplete.

```ts
export interface ApiMap {
  …
  'finance.invoices.unpost': { req: { id: string; reason: string }; res: Invoice };
}
```

**Checklist to paste into the PR description**

```
[ ] channels.ts literal added
[ ] schemas.ts validator added
[ ] permissions.ts entry added (if new permission)
[ ] ipc.ts registration with permission
[ ] api.ts ApiMap entry
[ ] audit row verified (mutating) / no audit (read-only, mutating:false)
[ ] unit test: call without permission → FORBIDDEN
```

---

## 8. Writing a service transaction

Every mutating service function follows this shape exactly. `conn.tx` is `BEGIN … COMMIT` with `ROLLBACK` on throw; `ipc.ts` calls `audit.append` **inside** the transaction and `persist.markDirty()` after commit.

```ts
export function postInvoice(id: string): Invoice {
  return conn.tx(() => {
    // 1. load + guard state
    const inv = requireInvoice(id);
    if (inv.status !== 'draft') throw conflict(`Invoice is ${inv.status}`);
    assertPeriodOpen(inv.date);                         // BR-04

    // 2. compute (pure, integer cents)
    const lines = conn.all<InvoiceLineRow>('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no', [id]);
    const totals = computeDocumentTotals(lines);        // BR-05/06/07
    assertBalanced(lines);                              // BR-01 (only for manual journals)

    // 3. allocate the number inside the tx — gapless (BR-08)
    const number = numbering.next('invoice', fiscalYearIdFor(inv.date));

    // 4. write the document
    conn.run('UPDATE invoices SET number=?, status=?, subtotal_cents=?, tax_cents=?, total_cents=?, posted_at=?, posted_by=?, updated_at=? WHERE id=?',
      [number, 'posted', totals.subtotal, totals.tax, totals.total, nowIso(), currentUserId(), nowIso(), id]);

    // 5. write the ledger via the ONE posting helper
    const entryId = writeJournal({
      date: inv.date, journalCode: 'SAL', sourceType: 'invoice', sourceId: id,
      lines: buildInvoiceJournalLines(inv, lines, totals),   // §B.4 mapping
    });

    // 6. audit is appended by ipc.ts from the returned before/after
    return { ...inv, number, status: 'posted', journal_entry_id: entryId };
  });
}
```

Rules:

- One `conn.tx` per user action. Never nest — pass `tx`-scoped helpers instead.
- All `conn.run`/`all`/`one` take **bound parameters**. Template literals with user input are a review rejection.
- `writeJournal` is the only writer of `journal_entries`/`journal_lines` and it re-checks `Σdebit === Σcredit` before insert.
- Never `UPDATE` or `DELETE` a posted document, a journal line, a stock move, or an audit row. There is no such code path; do not create one (`BR-02`).
- A failed step must leave **nothing**: the only cleanup mechanism is `ROLLBACK` (`BR-15`).

---

## 9. Adding a page + route + sidebar entry

**1. `src/renderer/pages/<module>/<Group>.tsx`** — named export, no default.

```tsx
export function InvoicesList() {
  const [view, setView] = useState<string>('all');
  const q = useQuery(['invoices', view], () => api.invoke('entity.list', { entity: 'invoices', viewId: view }), { tags: ['invoices'] });
  return (
    <>
      <PageHeader title={t('finance.invoices.title')} actions={<PermissionGate perm="finance.invoice.create"><Button onClick={…}>{t('common.new')}</Button></PermissionGate>} />
      <DataTable rows={q.data?.rows ?? []} columns={columns} rowKey={(r) => r.id} total={q.data?.total} loading={q.loading} ariaLabel={t('finance.invoices.title')} />
    </>
  );
}
```

**2. `src/renderer/App.tsx`** — add to the route table with its permission. One `<Route>` per entry in `ARCHITECTURE.md §E.1`; the permission string must match the one in `permissions.ts` or the guard silently denies.

```tsx
{ path: '/finance/invoices', element: <InvoicesList />, permission: 'finance.invoice.read', module: 'finance' },
```

**3. `src/shared/modules.ts`** — if the route belongs to a new module, add it to that module's `routes[]`; the sidebar and the route guard both read from there. Never hand-write a sidebar item.

**4. `src/shared/permissions.ts`** — ensure the permission exists and is granted to at least the `admin` role preset.

**5. i18n keys** — add to the string table (no literal English in JSX, `PRD §9 i18n`).

**Page rules**

| Rule | Detail |
|---|---|
| Layout | `PageHeader` (sticky) → `Toolbar` → content. Never a bare `<h1>`. |
| Loading | Skeleton rows matching the final layout. Never a page-level spinner. |
| Empty | One sentence + primary action (+ demo-data CTA on first-run surfaces). |
| Error | Inline panel with retry, plus a toast for the action that failed. |
| Actions | `PermissionGate` for visibility; the API enforces it. Never `disabled` for a missing permission — the control is **absent** (US-07). |
| Money columns | `money: true` on the `Column`, right-aligned, `tabular-nums`. |
| Peek | `onRowPeek` opens `Drawer`, never a navigation. |

---

## 10. Styling — Tailwind tokens only

`tailwind.config.js` maps tokens to utilities:

```js
theme: { extend: {
  colors: {
    bg: 'var(--bg)', surface: 'var(--surface)', 'surface-2': 'var(--surface-2)', 'surface-3': 'var(--surface-3)',
    line: 'var(--border)', 'line-strong': 'var(--border-strong)',
    text: 'var(--text)', muted: 'var(--text-muted)', inverse: 'var(--text-inverse)',
    accent: { DEFAULT: 'var(--accent)', hover: 'var(--accent-hover)', soft: 'var(--accent-soft)' },
    success: { DEFAULT: 'var(--success)', soft: 'var(--success-soft)' },
    warning: { DEFAULT: 'var(--warning)', soft: 'var(--warning-soft)' },
    danger:  { DEFAULT: 'var(--danger)',  soft: 'var(--danger-soft)' },
    info: 'var(--info)',
  },
  borderRadius: { input: 'var(--r-input)', card: 'var(--r-card)', chip: 'var(--r-chip)' },
  fontSize: { body: 'var(--fs-body)', meta: 'var(--fs-meta)', kpi: 'var(--fs-kpi)' },
  spacing: { 1:'4px', 2:'8px', 3:'12px', 4:'16px', 5:'24px', 6:'32px', 7:'48px', 8:'64px' },
  transitionDuration: { fast: '90ms', base: '150ms', slow: '250ms' },
}});
```

| Do | Don't |
|---|---|
| `bg-surface border border-line rounded-card p-4` | `bg-white border-[#dfe3e8] rounded-md p-4` |
| `text-muted text-meta` | `text-gray-500 text-[12px]` |
| `text-danger` | `text-red-600` |
| `shadow-[var(--shadow-overlay)]` on drawers/modals/palette only | `shadow-lg` on cards |
| `tabular-nums` on every numeric cell | default figures in money columns |
| `duration-base` | `duration-300` |
| `focus-visible:ring-2 focus-visible:ring-accent` | `outline-none` with no replacement |

Rules: no hex, no `rgb()`, no arbitrary `[]` values for colour or spacing; 1px borders instead of shadows for structure; `prefers-reduced-motion` zeroes all durations globally in `index.css`. Icons are `lucide-react` imported per name — never the barrel (`import { Search } from 'lucide-react'`).

---

## 11. Accessibility checklist (per screen, before it is "done")

```
[ ] All interactive elements reachable by Tab in logical DOM order
[ ] Visible 2px focus ring on every control (never outline:none)
[ ] Icon-only buttons have aria-label; ≥32×32px hit area (40px for primary)
[ ] Every input has a <label for>; required marked * and aria-required
[ ] Errors: aria-invalid + aria-describedby → the error node
[ ] Tables: <th scope="col">, caption or aria-label, sortable headers announce direction
[ ] Overlays: role="dialog" aria-modal, focus trapped, Esc closes, focus restored to origin
[ ] Toasts: container aria-live="polite"; errors are not auto-dismissed
[ ] Colour is never the only signal (status chips carry text)
[ ] Contrast ≥4.5:1 body, ≥3:1 large text and UI borders
[ ] Full flow completable with keyboard only — verified by doing it once
[ ] prefers-reduced-motion respected (global rule, verify one drawer)
[ ] No text baked into an image; all strings via i18n keys
```

---

## 12. Commits and branches

- Branch: `task/T0X-<slug>` (e.g. `task/T05-finance-core`).
- Commit subject: `<TASK-ID> <area>: <imperative summary>` → `T05 finance: add balanced-or-reject posting engine`.
- One task per PR; a PR must state which acceptance criteria it closes.
- Never commit: `keys/`, `*.db`, `dist/`, `release/`, `node_modules/`, `.env*`.
- Never `--no-verify`. If a hook fails, fix the cause.
- Never bump `electron` (pinned 33.4.11) or add a dependency with a native build step. A new runtime dependency needs a one-line justification in the PR (`bundle budget ≤1.5 MB gzip`).

---

## 13. Forbidden list (fast reference)

| Forbidden | Why |
|---|---|
| `if (industry === 'manufacturing')` anywhere | G3 — presets are data (`R7`) |
| `better-sqlite3`, `node-gyp`, any native module | Pinned decision — zero rebuild risk |
| `fs`, `path`, `child_process`, `require` in `src/renderer` | Renderer is sandboxed; it will not even resolve |
| `dangerouslySetInnerHTML` | XSS surface (`T5`) |
| `ipcRenderer` outside preload | The only allowed bridge is `window.nexus` |
| Dynamic channel strings from the renderer | Preload allow-list is literal |
| `SELECT *` | Column drift + payload bloat |
| String-concatenated SQL | Injection |
| `UPDATE`/`DELETE` on posted docs, journal lines, stock moves, audit | `BR-02`, `BR-21` |
| `parseFloat`/`toFixed` on money | `BR-05` |
| Hard-coded hex/rgb in components | Theming + dark mode |
| `alert()`, `confirm()`, `prompt()` | Blocks the main thread; use `Modal` |
| Emoji in UI copy or code | Product voice; use `lucide-react` |
| Any network call at runtime | Offline mandate — `connect-src 'none'` |
| Auto-update, telemetry, crash SDK | Offline mandate |
| `console.log` left in shipped code | Use `console.error` in main only, or nothing |
| A default export from a page/component file | Refactor safety + the route table imports by name |
