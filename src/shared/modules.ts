/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The module registry (ARCHITECTURE §D.1).
 *
 * `MODULES` is the single source for the sidebar groups, the route guards, the
 * command-palette navigation and the "module disabled" empty state. A module
 * absent from the active preset's `modules` array is not routed at all — its
 * routes fall through to the landing module with a toast, and its permissions
 * are not granted.
 */

import type { Permission } from './permissions';
import type { PresetId } from './industry-presets';

export type ModuleId =
  | 'dashboard'
  | 'finance'
  | 'inventory'
  | 'purchasing'
  | 'sales'
  | 'crm'
  | 'documents'
  | 'settings';

export type ModuleGroup = 'overview' | 'operations' | 'relationship' | 'admin';

/**
 * The icon names the sidebar knows how to resolve. Deliberately a closed union
 * rather than `keyof typeof import('lucide-react')`: the registry is imported by
 * the main process, which must not pull React types into its build.
 */
export type ModuleIcon =
  | 'LayoutDashboard'
  | 'Wallet'
  | 'Package'
  | 'ShoppingCart'
  | 'Truck'
  | 'Users'
  | 'FileText'
  | 'Settings';

export interface ModuleManifest {
  readonly id: ModuleId;
  /** i18n key, e.g. `module.finance`. */
  readonly label: string;
  readonly icon: ModuleIcon;
  readonly group: ModuleGroup;
  /** Landing route for the module. */
  readonly route: string;
  /** Every route prefix this module owns (route guard + sidebar build). */
  readonly routes: readonly string[];
  /** Holding any one of these makes the module visible. */
  readonly permissions: readonly Permission[];
  /** `[]` means the module is always on. */
  readonly enabledByPreset: readonly PresetId[];
  /** The default landing module is the highest weight among the enabled ones. */
  readonly landingWeight: number;
}

const ALL_PRESETS = [
  'manufacturing',
  'wholesale_retail',
  'services',
  'construction',
  'education',
  'ngo',
  'logistics',
] as const satisfies readonly PresetId[];

const STOCK_PRESETS = [
  'manufacturing',
  'wholesale_retail',
  'construction',
  'logistics',
] as const satisfies readonly PresetId[];

export const MODULES: readonly ModuleManifest[] = [
  {
    id: 'dashboard',
    label: 'module.dashboard',
    icon: 'LayoutDashboard',
    group: 'overview',
    route: '/dashboard',
    routes: ['/dashboard', '/search'],
    permissions: ['dashboard.read'],
    enabledByPreset: [],
    landingWeight: 10,
  },
  {
    id: 'finance',
    label: 'module.finance',
    icon: 'Wallet',
    group: 'operations',
    route: '/finance/invoices',
    routes: ['/finance'],
    permissions: [
      'finance.invoice.read',
      'finance.bill.read',
      'finance.account.read',
      'finance.journal.read',
      'finance.report.read',
      'finance.payment.read',
    ],
    enabledByPreset: ALL_PRESETS,
    landingWeight: 60,
  },
  {
    id: 'inventory',
    label: 'module.inventory',
    icon: 'Package',
    group: 'operations',
    route: '/inventory/products',
    routes: ['/inventory'],
    permissions: ['inventory.product.read', 'inventory.stock.read'],
    enabledByPreset: STOCK_PRESETS,
    landingWeight: 80,
  },
  {
    id: 'purchasing',
    label: 'module.purchasing',
    icon: 'ShoppingCart',
    group: 'operations',
    route: '/purchasing/orders',
    routes: ['/purchasing'],
    permissions: ['purchasing.po.read', 'purchasing.vendor.read', 'purchasing.receipt.read'],
    enabledByPreset: ALL_PRESETS,
    landingWeight: 50,
  },
  {
    id: 'sales',
    label: 'module.sales',
    icon: 'Truck',
    group: 'operations',
    route: '/sales/orders',
    routes: ['/sales'],
    permissions: ['sales.order.read', 'sales.customer.read', 'sales.quotation.read'],
    enabledByPreset: ALL_PRESETS,
    landingWeight: 70,
  },
  {
    id: 'crm',
    label: 'module.crm',
    icon: 'Users',
    group: 'relationship',
    route: '/crm/deals',
    routes: ['/crm'],
    permissions: ['crm.deal.read', 'crm.account.read', 'crm.lead.read', 'crm.activity.read'],
    enabledByPreset: ALL_PRESETS,
    landingWeight: 90,
  },
  {
    id: 'documents',
    label: 'module.documents',
    icon: 'FileText',
    group: 'admin',
    route: '/print',
    routes: ['/print'],
    permissions: ['documents.print'],
    enabledByPreset: ALL_PRESETS,
    landingWeight: 5,
  },
  {
    id: 'settings',
    label: 'module.settings',
    icon: 'Settings',
    group: 'admin',
    route: '/settings/company',
    routes: ['/settings', '/data'],
    permissions: ['settings.company.read'],
    enabledByPreset: ALL_PRESETS,
    landingWeight: 1,
  },
];

/** Module ids in registry order. */
export const MODULE_IDS: readonly ModuleId[] = MODULES.map((module) => module.id);

/** Sidebar group order and their i18n keys. */
export const MODULE_GROUPS: readonly { readonly id: ModuleGroup; readonly label: string }[] = [
  { id: 'overview', label: 'group.overview' },
  { id: 'operations', label: 'group.operations' },
  { id: 'relationship', label: 'group.relationship' },
  { id: 'admin', label: 'group.admin' },
];

const MODULE_BY_ID = new Map<ModuleId, ModuleManifest>(MODULES.map((module) => [module.id, module]));

/** Looks a module up by id. */
export function moduleById(id: ModuleId): ModuleManifest {
  const module = MODULE_BY_ID.get(id);
  if (!module) throw new Error(`Unknown module: ${id}`);
  return module;
}

/** True when the preset enables the module (an empty list means always on). */
export function isModuleEnabled(module: ModuleManifest, presetId: PresetId): boolean {
  if (module.enabledByPreset.length === 0) return true;
  return module.enabledByPreset.includes(presetId);
}

/** The module that owns a path, longest prefix wins (`/finance/reports` → finance). */
export function moduleForRoute(path: string): ModuleManifest | undefined {
  let best: ModuleManifest | undefined;
  let bestLength = -1;
  for (const module of MODULES) {
    for (const prefix of module.routes) {
      const matches = path === prefix || path.startsWith(`${prefix}/`);
      if (matches && prefix.length > bestLength) {
        best = module;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/**
 * Modules the given preset + permission set may see, in sidebar order.
 * Used by the sidebar and by the route guard, so they can never disagree.
 */
export function visibleModules(
  presetId: PresetId,
  permissions: ReadonlySet<Permission>,
): readonly ModuleManifest[] {
  return MODULES.filter((module) => {
    if (!isModuleEnabled(module, presetId)) return false;
    if (module.permissions.length === 0) return true;
    return module.permissions.some((permission) => permissions.has(permission));
  });
}

/** The landing module for a preset: highest `landingWeight` among visible ones. */
export function landingModuleFor(
  presetId: PresetId,
  permissions: ReadonlySet<Permission>,
  preferred?: ModuleId,
): ModuleManifest {
  const visible = visibleModules(presetId, permissions);
  if (preferred) {
    const match = visible.find((module) => module.id === preferred);
    if (match) return match;
  }
  const fallback = visible[0] ?? moduleById('dashboard');
  return visible.reduce(
    (best, module) => (module.landingWeight > best.landingWeight ? module : best),
    fallback,
  );
}
