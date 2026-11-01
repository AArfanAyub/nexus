"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MODULE_GROUPS = exports.MODULE_IDS = exports.MODULES = void 0;
exports.moduleById = moduleById;
exports.isModuleEnabled = isModuleEnabled;
exports.moduleForRoute = moduleForRoute;
exports.visibleModules = visibleModules;
exports.landingModuleFor = landingModuleFor;
const ALL_PRESETS = [
    'manufacturing',
    'wholesale_retail',
    'services',
    'construction',
    'education',
    'ngo',
    'logistics',
];
const STOCK_PRESETS = [
    'manufacturing',
    'wholesale_retail',
    'construction',
    'logistics',
];
exports.MODULES = [
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
exports.MODULE_IDS = exports.MODULES.map((module) => module.id);
/** Sidebar group order and their i18n keys. */
exports.MODULE_GROUPS = [
    { id: 'overview', label: 'group.overview' },
    { id: 'operations', label: 'group.operations' },
    { id: 'relationship', label: 'group.relationship' },
    { id: 'admin', label: 'group.admin' },
];
const MODULE_BY_ID = new Map(exports.MODULES.map((module) => [module.id, module]));
/** Looks a module up by id. */
function moduleById(id) {
    const module = MODULE_BY_ID.get(id);
    if (!module)
        throw new Error(`Unknown module: ${id}`);
    return module;
}
/** True when the preset enables the module (an empty list means always on). */
function isModuleEnabled(module, presetId) {
    if (module.enabledByPreset.length === 0)
        return true;
    return module.enabledByPreset.includes(presetId);
}
/** The module that owns a path, longest prefix wins (`/finance/reports` → finance). */
function moduleForRoute(path) {
    let best;
    let bestLength = -1;
    for (const module of exports.MODULES) {
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
function visibleModules(presetId, permissions) {
    return exports.MODULES.filter((module) => {
        if (!isModuleEnabled(module, presetId))
            return false;
        if (module.permissions.length === 0)
            return true;
        return module.permissions.some((permission) => permissions.has(permission));
    });
}
/** The landing module for a preset: highest `landingWeight` among visible ones. */
function landingModuleFor(presetId, permissions, preferred) {
    const visible = visibleModules(presetId, permissions);
    if (preferred) {
        const match = visible.find((module) => module.id === preferred);
        if (match)
            return match;
    }
    const fallback = visible[0] ?? moduleById('dashboard');
    return visible.reduce((best, module) => (module.landingWeight > best.landingWeight ? module : best), fallback);
}
//# sourceMappingURL=modules.js.map