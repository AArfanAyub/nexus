/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Command palette (R2, T09) — `⌘K` from anywhere, including inside an input.
 *
 * Four groups, in the order a keyboard user wants them:
 *
 *   1. **Recent** — the last eight records opened. Present even with an empty
 *      query, because "take me back to that invoice" is the most common reason to
 *      press ⌘K.
 *   2. **Actions** — the things this role may *start*, filtered by permission.
 *      An action the operator cannot complete is not shown, which is the whole
 *      reason actions are declared with a permission rather than inferred from a
 *      route.
 *   3. **Navigation** — every route the signed-in role may open. Instant, no
 *      round trip.
 *   4. **Records** — `search.palette`, debounced 300 ms, grouped by kind with a
 *      type badge per row.
 *
 * The palette does not re-rank records: the server ranks them, and a second
 * ranking pass in the renderer would only disagree with it.
 *
 * Every entry is a route, not a command: choosing one navigates. That keeps the
 * palette free of side effects, so an accidental Enter can never post a journal.
 */

import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Permission } from '@shared/permissions';
import type { SearchResult } from '@shared/search';

import { invoke } from '../lib/api';
import { useDebounced } from '../lib/finance';
import { useQuery } from '../lib/useQuery';
import { useSession, useUi } from '../store';
import { Kbd, useFocusTrap, useOverlayRegistration } from './ui';

const RECENT_KEY = 'nexus.recent';

export interface RecentItem {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  readonly kind: string;
}

/** Reads the recent list. Exported so the shell can record a visit. */
export function readRecent(): RecentItem[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as RecentItem[]).slice(0, 8) : [];
  } catch {
    return [];
  }
}

/** Records a visit. Keeps eight, most recent first, one entry per route. */
export function rememberRecent(item: RecentItem): void {
  try {
    const next = [item, ...readRecent().filter((entry) => entry.route !== item.route)].slice(0, 8);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Recents are a convenience; losing them must never break navigation.
  }
}

interface RouteEntry {
  readonly route: string;
  readonly label: string;
  readonly permission: Permission;
  readonly keywords: string;
}

const ROUTES: readonly RouteEntry[] = [
  { route: '/dashboard', label: 'Dashboard', permission: 'dashboard.read', keywords: 'home kpi overview' },
  { route: '/finance/invoices', label: 'Invoices', permission: 'finance.invoice.read', keywords: 'ar sales customer' },
  { route: '/finance/bills', label: 'Bills', permission: 'finance.bill.read', keywords: 'ap purchase vendor' },
  { route: '/finance/payments', label: 'Payments', permission: 'finance.payment.read', keywords: 'receipt allocate bank' },
  { route: '/finance/journal-entries', label: 'Journal entries', permission: 'finance.journal.read', keywords: 'gl posting ledger' },
  { route: '/finance/accounts', label: 'Chart of accounts', permission: 'finance.account.read', keywords: 'coa account' },
  { route: '/finance/reports/trial-balance', label: 'Reports', permission: 'finance.report.read', keywords: 'trial balance p&l cash flow' },
  { route: '/finance/periods', label: 'Accounting periods', permission: 'finance.period.read', keywords: 'lock close fiscal year' },
  { route: '/inventory/products', label: 'Products', permission: 'inventory.product.read', keywords: 'item sku stock' },
  { route: '/inventory/stock', label: 'Stock on hand', permission: 'inventory.stock.read', keywords: 'quant on hand' },
  { route: '/inventory/moves', label: 'Stock ledger', permission: 'inventory.stock.read', keywords: 'transfer receipt issue running balance' },
  { route: '/inventory/warehouses', label: 'Warehouses', permission: 'inventory.warehouse.read', keywords: 'location bin shelf' },
  { route: '/purchasing/vendors', label: 'Vendors', permission: 'purchasing.vendor.read', keywords: 'supplier' },
  { route: '/purchasing/orders', label: 'Purchase orders', permission: 'purchasing.po.read', keywords: 'po buy' },
  { route: '/purchasing/receipts', label: 'Goods receipts', permission: 'purchasing.receipt.read', keywords: 'receive grn' },
  { route: '/purchasing/bills', label: 'Purchasing bills', permission: 'finance.bill.read', keywords: 'three way match reconcile' },
  { route: '/sales/customers', label: 'Customers', permission: 'sales.customer.read', keywords: 'client account credit' },
  { route: '/sales/quotations', label: 'Quotations', permission: 'sales.quotation.read', keywords: 'quote proposal' },
  { route: '/sales/orders', label: 'Sales orders', permission: 'sales.order.read', keywords: 'so sell fulfilment deliver' },
  { route: '/sales/price-lists', label: 'Price lists', permission: 'sales.pricelist.read', keywords: 'pricing wholesale' },
  { route: '/crm/accounts', label: 'CRM accounts', permission: 'crm.account.read', keywords: 'company organisation' },
  { route: '/crm/leads', label: 'Leads', permission: 'crm.lead.read', keywords: 'prospect inbox convert' },
  { route: '/crm/deals', label: 'Deals', permission: 'crm.deal.read', keywords: 'pipeline opportunity kanban' },
  { route: '/crm/activities', label: 'Activities', permission: 'crm.activity.read', keywords: 'task call meeting calendar' },
  { route: '/crm/analytics', label: 'CRM analytics', permission: 'crm.analytics.read', keywords: 'win rate forecast funnel' },
  { route: '/settings/company', label: 'Company settings', permission: 'settings.company.read', keywords: 'profile logo' },
  { route: '/settings/users', label: 'Users', permission: 'settings.user.read', keywords: 'people accounts' },
  { route: '/settings/roles', label: 'Roles', permission: 'settings.role.read', keywords: 'permissions access' },
  { route: '/settings/custom-fields', label: 'Custom fields', permission: 'settings.custom_field.read', keywords: 'extra columns' },
  { route: '/settings/numbering', label: 'Numbering', permission: 'settings.numbering.read', keywords: 'sequence prefix' },
  { route: '/settings/taxes', label: 'Taxes', permission: 'settings.tax.read', keywords: 'vat gst rate' },
  { route: '/settings/currencies', label: 'Currencies', permission: 'settings.currency.read', keywords: 'fx exchange rate' },
  { route: '/settings/import', label: 'Import data', permission: 'data.import', keywords: 'csv xlsx upload wizard' },
  { route: '/settings/backup', label: 'Backup', permission: 'settings.backup.run', keywords: 'restore snapshot copy' },
  { route: '/settings/audit-log', label: 'Audit log', permission: 'settings.audit.read', keywords: 'history trail chain' },
  { route: '/settings/security', label: 'Security', permission: 'settings.security.manage', keywords: 'password lock session' },
  { route: '/settings/appearance', label: 'Appearance', permission: 'app.prefs.write', keywords: 'theme dark accent density' },
];

interface ActionEntry {
  readonly label: string;
  readonly route: string;
  readonly permission: Permission;
  readonly keywords: string;
}

/**
 * The things a palette is actually used for: starting a record. Each is a deep
 * link into a screen that already knows how to open its own create flow, so the
 * palette needs no write permission of its own — the destination checks.
 */
const ACTIONS: readonly ActionEntry[] = [
  { label: 'New invoice', route: '/finance/invoices?new=1', permission: 'finance.invoice.create', keywords: 'raise bill customer' },
  { label: 'New bill', route: '/finance/bills?new=1', permission: 'finance.bill.create', keywords: 'vendor purchase' },
  { label: 'Record a payment', route: '/finance/payments?new=1', permission: 'finance.payment.create', keywords: 'allocate receipt' },
  { label: 'New product', route: '/inventory/products?new=1', permission: 'inventory.product.write', keywords: 'item sku' },
  { label: 'New stock move', route: '/inventory/stock?new=1', permission: 'inventory.move.create', keywords: 'receive issue transfer adjust' },
  { label: 'New vendor', route: '/purchasing/vendors?new=1', permission: 'purchasing.vendor.write', keywords: 'supplier' },
  { label: 'New purchase order', route: '/purchasing/orders?new=1', permission: 'purchasing.po.create', keywords: 'po buy' },
  { label: 'Receive goods', route: '/purchasing/receipts?new=1', permission: 'purchasing.receipt.create', keywords: 'grn' },
  { label: 'New customer', route: '/sales/customers?new=1', permission: 'sales.customer.write', keywords: 'client' },
  { label: 'New quotation', route: '/sales/quotations?new=1', permission: 'sales.quotation.create', keywords: 'quote' },
  { label: 'New sales order', route: '/sales/orders?new=1', permission: 'sales.order.create', keywords: 'so' },
  { label: 'New price list', route: '/sales/price-lists?new=1', permission: 'sales.pricelist.manage', keywords: 'pricing' },
  { label: 'New deal', route: '/crm/deals?new=1', permission: 'crm.deal.write', keywords: 'opportunity pipeline' },
  { label: 'New lead', route: '/crm/leads?new=1', permission: 'crm.lead.write', keywords: 'prospect' },
  { label: 'Log an activity', route: '/crm/activities?new=1', permission: 'crm.activity.write', keywords: 'call meeting task' },
  { label: 'Import from CSV', route: '/settings/import', permission: 'data.import', keywords: 'upload spreadsheet' },
  { label: 'Back up now', route: '/settings/backup', permission: 'settings.backup.run', keywords: 'snapshot' },
  { label: 'Verify the audit chain', route: '/settings/audit-log', permission: 'settings.audit.read', keywords: 'tamper integrity' },
];

type GroupId = 'recent' | 'action' | 'nav' | 'record';

const GROUP_LABEL: Record<GroupId, string> = {
  recent: 'Recent',
  action: 'Actions',
  nav: 'Navigation',
  record: 'Records',
};

interface PaletteItem {
  readonly key: string;
  readonly group: GroupId;
  readonly label: string;
  readonly hint: string;
  readonly badge: string;
  readonly route: string;
}

export function CommandPalette(): JSX.Element | null {
  const open = useUi((state) => state.paletteOpen);
  const setOpen = useUi((state) => state.setPaletteOpen);
  const can = useSession((state) => state.can);
  const navigate = useNavigate();

  const panel = useRef<HTMLDivElement>(null);
  const [term, setTerm] = useState('');
  const [cursor, setCursor] = useState(0);
  const debounced = useDebounced(term, 300);

  useFocusTrap(open, panel);
  useOverlayRegistration(open);

  useEffect(() => {
    if (!open) {
      setTerm('');
      setCursor(0);
    }
  }, [open]);

  /**
   * Escape closes from anywhere, not only from the input: focus can be on a
   * result row after a click, and an overlay that only answers a key when the
   * caret happens to be inside it feels broken.
   */
  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  const results = useQuery<SearchResult>(
    `palette:${debounced}`,
    () => invoke<SearchResult>('search.palette', { q: debounced }),
    { enabled: open && debounced.trim().length >= 1, staleMs: 30_000 },
  );

  const items = useMemo<readonly PaletteItem[]>(() => {
    const needle = term.trim().toLowerCase();
    const matches = (label: string, keywords: string): boolean =>
      needle === '' || label.toLowerCase().includes(needle) || keywords.includes(needle);

    const recents: PaletteItem[] =
      needle === ''
        ? readRecent().map((item) => ({
            key: `recent:${item.route}`,
            group: 'recent' as const,
            label: item.title,
            hint: item.route,
            badge: item.kind,
            route: item.route,
          }))
        : [];

    const actions = ACTIONS.filter((entry) => can(entry.permission))
      .filter((entry) => matches(entry.label, entry.keywords))
      .slice(0, needle === '' ? 5 : 6)
      .map<PaletteItem>((entry) => ({
        key: `action:${entry.label}`,
        group: 'action',
        label: entry.label,
        hint: entry.route,
        badge: 'Action',
        route: entry.route,
      }));

    const nav = ROUTES.filter((entry) => can(entry.permission))
      .filter((entry) => matches(entry.label, entry.keywords))
      .slice(0, needle === '' ? 6 : 5)
      .map<PaletteItem>((entry) => ({
        key: `nav:${entry.route}`,
        group: 'nav',
        label: entry.label,
        hint: entry.route,
        badge: 'Page',
        route: entry.route,
      }));

    const records = (results.data?.groups ?? []).flatMap((group) =>
      group.rows.map<PaletteItem>((row) => ({
        key: `hit:${group.kind}:${row.id}`,
        group: 'record',
        label: row.title,
        hint: row.subtitle,
        badge: group.label,
        route: row.route,
      })),
    );

    return [...recents, ...actions, ...nav, ...records];
  }, [can, results.data, term]);

  useEffect(() => {
    setCursor(0);
  }, [term, results.data]);

  if (!open) return null;

  function choose(item: PaletteItem | undefined): void {
    if (!item) return;
    rememberRecent({ id: item.key, title: item.label, route: item.route, kind: item.badge });
    setOpen(false);
    navigate(item.route);
  }

  // Group headers are rendered from the flat list so arrow keys still walk one
  // continuous sequence — a keyboard user should never have to "jump" a heading.
  let lastGroup: GroupId | null = null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-6 pt-[12vh]">
      <div className="fixed inset-0 bg-[var(--overlay)]" onClick={() => setOpen(false)} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        className="relative w-full max-w-xl overflow-hidden rounded-panel border border-line bg-surface shadow-popover"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Search size={15} aria-hidden="true" className="text-muted" />
          <input
            autoFocus
            value={term}
            aria-label="Search records, actions and pages"
            placeholder="Search invoices, customers, actions, pages…"
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCursor((value) => Math.min(items.length - 1, value + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor((value) => Math.max(0, value - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(items[cursor]);
              } else if (event.key === 'Escape') {
                event.stopPropagation();
                setOpen(false);
              }
            }}
            className="h-7 flex-1 bg-transparent text-body text-text outline-none placeholder:text-muted"
          />
          <Kbd>esc</Kbd>
        </div>

        <ul role="listbox" aria-label="Results" className="max-h-[52vh] overflow-y-auto py-1">
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-meta text-muted">
              {term.trim() === '' ? 'Start typing to search.' : `Nothing matches “${term.trim()}”.`}
            </li>
          ) : (
            items.map((item, index) => {
              const header = item.group !== lastGroup ? GROUP_LABEL[item.group] : null;
              lastGroup = item.group;
              return (
                <li key={item.key} role="option" aria-selected={index === cursor}>
                  {header !== null ? (
                    <p className="micro px-3 pb-1 pt-2 text-muted" aria-hidden="true">
                      {header}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => choose(item)}
                    className={[
                      'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-fast',
                      index === cursor ? 'bg-accent-soft' : 'hover:bg-surface-2',
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'shrink-0 rounded-chip px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                        index === cursor ? 'bg-accent text-inverse' : 'bg-surface-3 text-muted',
                      ].join(' ')}
                    >
                      {item.badge}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-text">{item.label}</span>
                      <span className="block truncate text-meta text-muted">{item.hint}</span>
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11px] text-muted">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>⌘K</Kbd> anywhere
          </span>
          {results.data ? <span className="ml-auto tabular-nums">{results.data.ms} ms</span> : null}
        </div>
      </div>
    </div>
  );
}
