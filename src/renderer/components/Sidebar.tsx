/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Sidebar — the `nav` landmark (ARCHITECTURE §E.2, §E.4).
 *
 * Driven by `MODULES` and the session's permission set only: a module the preset
 * disables or the role cannot read is not rendered at all, so there is nothing to
 * click that would fail. Collapses 240px ↔ 64px, keeping icons and accessible
 * names when narrow.
 */

import clsx from 'clsx';
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  LayoutDashboard,
  Package,
  Settings,
  ShoppingCart,
  Star,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { NexusMark } from './BrandMark';
import { MODULE_GROUPS, MODULES, type ModuleIcon, type ModuleManifest } from '@shared/modules';
import type { Permission } from '@shared/permissions';

import { useSession, useUi } from '../store';

const ICONS: Record<ModuleIcon, LucideIcon> = {
  LayoutDashboard,
  Wallet,
  Package,
  ShoppingCart,
  Truck,
  Users,
  FileText,
  Settings,
};

/** Display names for the manifest's i18n keys (no runtime i18n in this build). */
const MODULE_LABELS: Record<string, string> = {
  'module.dashboard': 'Dashboard',
  'module.finance': 'Finance',
  'module.inventory': 'Inventory',
  'module.purchasing': 'Purchasing',
  'module.sales': 'Sales',
  'module.crm': 'CRM',
  'module.documents': 'Documents',
  'module.settings': 'Settings',
};

const GROUP_LABELS: Record<string, string> = {
  'group.overview': 'Overview',
  'group.operations': 'Operations',
  'group.relationship': 'Relationship',
  'group.admin': 'Administration',
};

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly permission: Permission | null;
}

/** The sub-routes shown under each module, in the order they are used. */
const NAV_ITEMS: Record<string, readonly NavItem[]> = {
  dashboard: [{ to: '/dashboard', label: 'Dashboard', permission: 'dashboard.read' }],
  finance: [
    { to: '/finance/invoices', label: 'Invoices', permission: 'finance.invoice.read' },
    { to: '/finance/bills', label: 'Bills', permission: 'finance.bill.read' },
    { to: '/finance/payments', label: 'Payments', permission: 'finance.payment.read' },
    { to: '/finance/journal-entries', label: 'Journal', permission: 'finance.journal.read' },
    { to: '/finance/accounts', label: 'Chart of accounts', permission: 'finance.account.read' },
    { to: '/finance/reports/trial-balance', label: 'Reports', permission: 'finance.report.read' },
    { to: '/finance/periods', label: 'Periods', permission: 'finance.period.read' },
  ],
  inventory: [
    { to: '/inventory/products', label: 'Products', permission: 'inventory.product.read' },
    { to: '/inventory/stock', label: 'Stock on hand', permission: 'inventory.stock.read' },
    { to: '/inventory/moves', label: 'Movements', permission: 'inventory.stock.read' },
    { to: '/inventory/warehouses', label: 'Warehouses', permission: 'inventory.warehouse.read' },
  ],
  purchasing: [
    { to: '/purchasing/vendors', label: 'Vendors', permission: 'purchasing.vendor.read' },
    { to: '/purchasing/orders', label: 'Purchase orders', permission: 'purchasing.po.read' },
    { to: '/purchasing/receipts', label: 'Receipts', permission: 'purchasing.receipt.read' },
  ],
  sales: [
    { to: '/sales/customers', label: 'Customers', permission: 'sales.customer.read' },
    { to: '/sales/quotations', label: 'Quotations', permission: 'sales.quotation.read' },
    { to: '/sales/orders', label: 'Orders', permission: 'sales.order.read' },
    { to: '/sales/price-lists', label: 'Price lists', permission: 'sales.pricelist.read' },
  ],
  crm: [
    { to: '/crm/deals', label: 'Deals', permission: 'crm.deal.read' },
    { to: '/crm/accounts', label: 'Accounts', permission: 'crm.account.read' },
    { to: '/crm/leads', label: 'Leads', permission: 'crm.lead.read' },
    { to: '/crm/activities', label: 'Activities', permission: 'crm.activity.read' },
  ],
  documents: [{ to: '/search', label: 'Search', permission: 'search.read' }],
  settings: [
    { to: '/settings/company', label: 'Company', permission: 'settings.company.read' },
    { to: '/settings/users', label: 'People', permission: 'settings.user.read' },
    { to: '/settings/roles', label: 'Roles', permission: 'settings.role.read' },
    { to: '/settings/custom-fields', label: 'Custom fields', permission: 'settings.custom_field.read' },
    { to: '/settings/numbering', label: 'Numbering', permission: 'settings.numbering.read' },
    { to: '/settings/taxes', label: 'Taxes', permission: 'settings.tax.read' },
    { to: '/settings/currencies', label: 'Currencies', permission: 'settings.currency.read' },
    { to: '/settings/import', label: 'Import', permission: 'data.import' },
    { to: '/settings/backup', label: 'Backup', permission: 'settings.backup.run' },
    { to: '/settings/license', label: 'Licence', permission: 'settings.license.read' },
    { to: '/settings/audit-log', label: 'Audit log', permission: 'settings.audit.read' },
    { to: '/settings/security', label: 'Security', permission: 'settings.security.manage' },
    { to: '/settings/appearance', label: 'Appearance', permission: 'app.prefs.write' },
  ],
};

export interface SidebarProps {
  /** Module id → count shown as a pill (e.g. overdue invoices). */
  readonly badges?: Readonly<Record<string, number>>;
  readonly favourites?: readonly string[];
  readonly onToggleFavourite?: (path: string) => void;
}

export function Sidebar({ badges = {}, favourites = [], onToggleFavourite }: SidebarProps): JSX.Element {
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const permissions = useSession((state) => state.permissions);
  const license = useSession((state) => state.license);

  const visible = useMemo(
    () =>
      MODULES.filter((module) =>
        module.permissions.length === 0 ? true : module.permissions.some((permission) => permissions.has(permission as Permission)),
      ),
    [permissions],
  );

  const groups = useMemo(
    () =>
      MODULE_GROUPS.map((group) => ({
        ...group,
        modules: visible.filter((module) => module.group === group.id),
      })).filter((group) => group.modules.length > 0),
    [visible],
  );

  return (
    <nav
      aria-label="Main navigation"
      className={clsx(
        'flex h-full flex-col border-r border-line bg-surface transition-[width] duration-base',
        collapsed ? 'w-[var(--sidebar-w-collapsed)]' : 'w-[var(--sidebar-w)]',
      )}
    >
      <div className={clsx('flex items-center gap-2 px-3 py-3', collapsed && 'justify-center px-0')}>
        <NexusMark size={collapsed ? 22 : 26} title={null} className="shrink-0" />
        {collapsed ? null : (
          <div className="min-w-0">
            <p className="truncate text-body font-semibold text-text">NEXUS</p>
            <p className="truncate text-meta text-muted">{license?.edition ?? 'community'} edition</p>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {favourites.length > 0 && !collapsed ? (
          <SidebarGroup label="Favourites">
            {favourites.map((path) => (
              <NavLink
                key={path}
                to={path}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-2 rounded-input px-2 py-1.5 text-body',
                    isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-text',
                  )
                }
              >
                <Star size={14} aria-hidden="true" />
                <span className="truncate">{path}</span>
              </NavLink>
            ))}
          </SidebarGroup>
        ) : null}

        {groups.map((group) => (
          <SidebarGroup key={group.id} label={GROUP_LABELS[group.label] ?? group.label}>
            {group.modules.map((module) => (
              <SidebarModule
                key={module.id}
                module={module}
                collapsed={collapsed}
                permissions={permissions}
                badge={badges[module.id] ?? 0}
                favourites={favourites}
                onToggleFavourite={onToggleFavourite}
              />
            ))}
          </SidebarGroup>
        ))}
      </div>

      <div className="border-t border-line p-2">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={clsx(
            'flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-meta text-muted hover:bg-surface-2 hover:text-text',
            collapsed && 'justify-center',
          )}
        >
          {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronLeft size={16} aria-hidden="true" />}
          {collapsed ? null : <span>Collapse</span>}
        </button>
      </div>
    </nav>
  );
}

function SidebarGroup({ label, children }: { readonly label: string; readonly children: React.ReactNode }): JSX.Element {
  return (
    <div className="mt-3">
      <p className="px-2 pb-1 text-meta uppercase tracking-wide text-muted">{label}</p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

interface SidebarModuleProps {
  readonly module: ModuleManifest;
  readonly collapsed: boolean;
  readonly permissions: ReadonlySet<Permission>;
  readonly badge: number;
  readonly favourites: readonly string[];
  readonly onToggleFavourite?: (path: string) => void;
}

function SidebarModule({
  module,
  collapsed,
  permissions,
  badge,
  favourites,
  onToggleFavourite,
}: SidebarModuleProps): JSX.Element {
  const Icon = ICONS[module.icon] ?? LayoutDashboard;
  const items = (NAV_ITEMS[module.id] ?? []).filter(
    (item) => item.permission === null || permissions.has(item.permission),
  );
  const label = MODULE_LABELS[module.label] ?? module.id;
  const active = useIsModuleActive(module);

  if (collapsed) {
    return (
      <NavLink
        to={module.route}
        title={label}
        aria-label={label}
        className={clsx(
          'relative flex items-center justify-center rounded-input py-2',
          active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-text',
        )}
      >
        <Icon size={18} aria-hidden="true" />
        {badge > 0 ? (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-chip bg-danger" aria-label={`${String(badge)} needing attention`} />
        ) : null}
      </NavLink>
    );
  }

  return (
    <div>
      <div className="flex items-center">
        <NavLink
          to={module.route}
          className={clsx(
            'flex min-w-0 flex-1 items-center gap-2 rounded-input px-2 py-1.5 text-body',
            active ? 'text-text' : 'text-muted hover:bg-surface-2 hover:text-text',
          )}
        >
          <Icon size={16} aria-hidden="true" />
          <span className="truncate">{label}</span>
          {badge > 0 ? (
            <span className="ml-auto rounded-chip bg-danger-soft px-1.5 text-meta text-danger">{badge}</span>
          ) : null}
        </NavLink>
        {onToggleFavourite && items[0] ? (
          <button
            type="button"
            aria-label={favourites.includes(items[0].to) ? `Remove ${label} from favourites` : `Add ${label} to favourites`}
            onClick={() => onToggleFavourite(items[0]?.to ?? module.route)}
            className="ml-1 rounded-input p-1 text-muted hover:text-accent"
          >
            <Star
              size={12}
              aria-hidden="true"
              fill={favourites.includes(items[0].to) ? 'currentColor' : 'none'}
            />
          </button>
        ) : null}
      </div>

      {active && items.length > 1 ? (
        <div className="ml-4 mt-0.5 flex flex-col gap-0.5 border-l border-line pl-2">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to.split('/').length <= 2}
              className={({ isActive }) =>
                clsx(
                  'truncate rounded-input px-2 py-1 text-meta',
                  isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-text',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** True when the current path falls inside the module's route prefixes. */
function useIsModuleActive(module: ModuleManifest): boolean {
  const { pathname } = useLocation();
  return module.routes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
