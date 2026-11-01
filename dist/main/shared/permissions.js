"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLE_PRESET_IDS = exports.ROLE_PRESETS = exports.PERMISSION_KEYS = exports.PERMISSIONS = void 0;
exports.isPermission = isPermission;
exports.resolvePermissions = resolvePermissions;
exports.permissionGroups = permissionGroups;
const perm = (module, label, risk) => ({ module, label, risk });
exports.PERMISSIONS = {
    // ── app ────────────────────────────────────────────────────────────────────
    'app.session.use': perm('app', 'Use an authenticated session', 'low'),
    'app.prefs.write': perm('app', 'Change own appearance preferences', 'low'),
    'app.view.read': perm('app', 'Read saved list views', 'low'),
    'app.view.write': perm('app', 'Create and edit saved list views', 'low'),
    'app.demo_data.manage': perm('app', 'Load or remove demo data', 'high'),
    // ── overview ───────────────────────────────────────────────────────────────
    'dashboard.read': perm('dashboard', 'View the dashboard', 'low'),
    'search.read': perm('search', 'Search records and the command palette', 'low'),
    // ── settings ───────────────────────────────────────────────────────────────
    'settings.company.read': perm('settings', 'View company profile', 'low'),
    'settings.company.write': perm('settings', 'Edit company profile', 'medium'),
    'settings.user.read': perm('settings', 'View users', 'low'),
    'settings.user.manage': perm('settings', 'Create, edit, disable users', 'high'),
    'settings.role.read': perm('settings', 'View roles and permissions', 'low'),
    'settings.role.manage': perm('settings', 'Create and edit roles', 'high'),
    'settings.numbering.read': perm('settings', 'View document numbering', 'low'),
    'settings.numbering.manage': perm('settings', 'Change or reset numbering', 'high'),
    'settings.currency.read': perm('settings', 'View currencies', 'low'),
    'settings.currency.manage': perm('settings', 'Manage currencies and base currency', 'high'),
    'settings.tax.read': perm('settings', 'View tax rates', 'low'),
    'settings.tax.manage': perm('settings', 'Create and archive tax rates', 'medium'),
    'settings.custom_field.read': perm('settings', 'View custom fields', 'low'),
    'settings.custom_field.manage': perm('settings', 'Create and edit custom fields', 'medium'),
    'settings.preset.apply': perm('settings', 'Apply an industry preset', 'high'),
    'settings.security.manage': perm('settings', 'Change the security policy', 'high'),
    'settings.license.read': perm('settings', 'View licence state', 'low'),
    'settings.license.manage': perm('settings', 'Activate or deactivate the licence', 'high'),
    'settings.audit.read': perm('settings', 'Read and verify the audit log', 'medium'),
    'settings.backup.run': perm('settings', 'Run a backup', 'medium'),
    'settings.backup.restore': perm('settings', 'Restore from a backup', 'high'),
    // ── finance ────────────────────────────────────────────────────────────────
    'finance.account.read': perm('finance', 'View the chart of accounts', 'low'),
    'finance.account.write': perm('finance', 'Create and edit accounts', 'medium'),
    'finance.account.delete': perm('finance', 'Archive accounts', 'high'),
    'finance.journal.read': perm('finance', 'View journal entries', 'low'),
    'finance.journal.write': perm('finance', 'Create draft journal entries', 'medium'),
    'finance.journal.post': perm('finance', 'Post journal entries', 'high'),
    'finance.journal.reverse': perm('finance', 'Reverse posted journal entries', 'high'),
    'finance.invoice.read': perm('finance', 'View invoices', 'low'),
    'finance.invoice.create': perm('finance', 'Create and edit draft invoices', 'medium'),
    'finance.invoice.post': perm('finance', 'Post invoices', 'high'),
    'finance.invoice.void': perm('finance', 'Void posted invoices', 'high'),
    'finance.bill.read': perm('finance', 'View vendor bills', 'low'),
    'finance.bill.create': perm('finance', 'Create and edit draft bills', 'medium'),
    'finance.bill.post': perm('finance', 'Post vendor bills', 'high'),
    'finance.bill.void': perm('finance', 'Void posted vendor bills', 'high'),
    'finance.payment.read': perm('finance', 'View payments', 'low'),
    'finance.payment.create': perm('finance', 'Record and allocate payments', 'high'),
    'finance.report.read': perm('finance', 'Run financial reports', 'low'),
    'finance.period.read': perm('finance', 'View accounting periods', 'low'),
    'finance.period.lock': perm('finance', 'Lock and unlock periods', 'high'),
    // ── inventory ──────────────────────────────────────────────────────────────
    'inventory.product.read': perm('inventory', 'View products', 'low'),
    'inventory.product.write': perm('inventory', 'Create and edit products', 'medium'),
    'inventory.product.delete': perm('inventory', 'Archive products', 'high'),
    'inventory.warehouse.read': perm('inventory', 'View warehouses and locations', 'low'),
    'inventory.warehouse.write': perm('inventory', 'Create and edit warehouses', 'medium'),
    'inventory.warehouse.delete': perm('inventory', 'Archive warehouses', 'high'),
    'inventory.stock.read': perm('inventory', 'View stock on hand and moves', 'low'),
    'inventory.stock.adjust': perm('inventory', 'Rebuild stock quants', 'high'),
    'inventory.move.create': perm('inventory', 'Post and reverse stock moves', 'high'),
    /*
     * In-handler escalation, not a channel permission: the move channel is guarded
     * by `inventory.move.create`, and this one is checked *inside* `postMove` when a
     * quantity would go negative. Separating them is deliberate — issuing stock and
     * being allowed to drive it below zero are different levels of trust (BR-11).
     */
    'inventory.stock.allow_negative': perm('inventory', 'Allow stock to go negative', 'high'),
    // ── purchasing ─────────────────────────────────────────────────────────────
    'purchasing.vendor.read': perm('purchasing', 'View vendors', 'low'),
    'purchasing.vendor.write': perm('purchasing', 'Create and edit vendors', 'medium'),
    'purchasing.vendor.delete': perm('purchasing', 'Archive vendors', 'high'),
    'purchasing.po.read': perm('purchasing', 'View purchase orders', 'low'),
    'purchasing.po.create': perm('purchasing', 'Create and edit purchase orders', 'medium'),
    'purchasing.po.confirm': perm('purchasing', 'Confirm purchase orders', 'medium'),
    'purchasing.po.cancel': perm('purchasing', 'Cancel purchase orders', 'high'),
    'purchasing.receipt.read': perm('purchasing', 'View goods receipts', 'low'),
    'purchasing.receipt.create': perm('purchasing', 'Create goods receipts', 'medium'),
    'purchasing.receipt.post': perm('purchasing', 'Post goods receipts', 'high'),
    'purchasing.bill.approve_exception': perm('purchasing', 'Approve a 3-way match exception', 'high'),
    // ── sales ──────────────────────────────────────────────────────────────────
    'sales.customer.read': perm('sales', 'View customers', 'low'),
    'sales.customer.write': perm('sales', 'Create and edit customers', 'medium'),
    'sales.customer.delete': perm('sales', 'Archive customers', 'high'),
    'sales.quotation.read': perm('sales', 'View quotations', 'low'),
    'sales.quotation.write': perm('sales', 'Edit, send and accept quotations', 'medium'),
    'sales.quotation.create': perm('sales', 'Create quotations', 'medium'),
    'sales.quotation.convert': perm('sales', 'Convert a quotation to an order', 'high'),
    /** In-handler escalation for converting a quotation past its expiry (BR-18). */
    'sales.quotation.override_expiry': perm('sales', 'Convert an expired quotation', 'high'),
    'sales.order.read': perm('sales', 'View sales orders and deliveries', 'low'),
    'sales.order.write': perm('sales', 'Confirm and cancel sales orders', 'medium'),
    /** In-handler escalation for confirming an order past the credit limit. */
    'sales.order.override_credit': perm('sales', 'Confirm an order over the credit limit', 'high'),
    'sales.order.create': perm('sales', 'Create sales orders', 'medium'),
    'sales.delivery.create': perm('sales', 'Create deliveries', 'medium'),
    'sales.delivery.post': perm('sales', 'Post deliveries', 'high'),
    'sales.pricelist.read': perm('sales', 'View price lists and resolve prices', 'low'),
    'sales.pricelist.manage': perm('sales', 'Manage price lists', 'medium'),
    // ── crm ────────────────────────────────────────────────────────────────────
    'crm.account.read': perm('crm', 'View CRM accounts', 'low'),
    'crm.account.write': perm('crm', 'Create and edit CRM accounts', 'medium'),
    'crm.account.delete': perm('crm', 'Archive CRM accounts', 'high'),
    'crm.contact.read': perm('crm', 'View contacts', 'low'),
    'crm.contact.write': perm('crm', 'Create and edit contacts', 'medium'),
    'crm.contact.delete': perm('crm', 'Archive contacts', 'high'),
    'crm.lead.read': perm('crm', 'View leads', 'low'),
    'crm.lead.write': perm('crm', 'Create and edit leads', 'medium'),
    'crm.lead.delete': perm('crm', 'Delete leads', 'high'),
    'crm.lead.convert': perm('crm', 'Convert a lead into account, contact and deal', 'high'),
    'crm.deal.read': perm('crm', 'View deals and the pipeline board', 'low'),
    'crm.deal.write': perm('crm', 'Move, win and lose deals', 'medium'),
    'crm.deal.delete': perm('crm', 'Archive deals', 'high'),
    'crm.activity.read': perm('crm', 'View activities and timelines', 'low'),
    'crm.activity.write': perm('crm', 'Log and complete activities', 'medium'),
    'crm.activity.delete': perm('crm', 'Delete activities', 'high'),
    'crm.pipeline.read': perm('crm', 'View pipelines and stages', 'low'),
    'crm.pipeline.manage': perm('crm', 'Manage pipelines, stages and loss reasons', 'high'),
    'crm.analytics.read': perm('crm', 'View CRM analytics', 'low'),
    // ── documents & data ───────────────────────────────────────────────────────
    'documents.print': perm('documents', 'Preview, print and save documents', 'low'),
    'documents.export': perm('documents', 'Export lists to XLSX and CSV', 'medium'),
    'data.import': perm('documents', 'Import data from CSV and XLSX', 'high'),
};
/** Runtime list of every permission key. */
exports.PERMISSION_KEYS = Object.keys(exports.PERMISSIONS);
/** Type guard for untrusted strings (role rows, stored JSON). */
function isPermission(value) {
    return Object.prototype.hasOwnProperty.call(exports.PERMISSIONS, value);
}
const ALL = exports.PERMISSION_KEYS;
const ofModule = (...modules) => ALL.filter((key) => modules.includes(exports.PERMISSIONS[key].module));
const readOnly = () => ALL.filter((key) => key.endsWith('.read') || key.endsWith('.use'));
const without = (keys, excluded) => keys.filter((key) => !excluded.includes(key));
/** The six seeded roles. `owner` is the only role that can transfer the licence. */
exports.ROLE_PRESETS = {
    owner: {
        id: 'owner',
        name: 'Owner',
        description: 'Full access, including licence and backup restore. Cannot be edited.',
        permissions: ALL,
    },
    admin: {
        id: 'admin',
        name: 'Administrator',
        description: 'Everything except activating or deactivating the licence.',
        permissions: without(ALL, ['settings.license.manage', 'settings.backup.restore']),
    },
    accountant: {
        id: 'accountant',
        name: 'Accountant',
        description: 'The books: chart of accounts, journals, invoices, bills, payments, reports.',
        permissions: [
            ...ofModule('finance'),
            ...readOnly().filter((key) => [
                'settings.company.read',
                'settings.tax.read',
                'settings.currency.read',
                'settings.numbering.read',
                'settings.custom_field.read',
                'settings.audit.read',
                'inventory.product.read',
                'inventory.stock.read',
                'purchasing.vendor.read',
                'sales.customer.read',
                'sales.pricelist.read',
                'documents.print',
                'documents.export',
                'data.import',
                'dashboard.read',
                'search.read',
            ].includes(key)),
            'app.session.use',
            'app.prefs.write',
            'app.view.read',
            'app.view.write',
        ],
    },
    sales: {
        id: 'sales',
        name: 'Sales',
        description: 'Customers, quotations, orders, deliveries and the whole CRM module.',
        permissions: [
            ...ofModule('crm'),
            ...readOnly().filter((key) => [
                'sales.customer.read',
                'sales.quotation.read',
                'sales.order.read',
                'sales.pricelist.read',
                'inventory.product.read',
                'inventory.stock.read',
                'finance.invoice.read',
                'finance.payment.read',
                'settings.company.read',
                'settings.tax.read',
                'settings.currency.read',
                'documents.print',
                'documents.export',
                'dashboard.read',
                'search.read',
            ].includes(key)),
            'sales.customer.write',
            'sales.quotation.create',
            'sales.quotation.write',
            'sales.quotation.convert',
            'sales.order.create',
            'sales.order.write',
            'sales.delivery.create',
            'sales.delivery.post',
            'app.session.use',
            'app.prefs.write',
            'app.view.read',
            'app.view.write',
        ],
    },
    warehouse: {
        id: 'warehouse',
        name: 'Warehouse',
        description: 'Products, stock moves, goods receipts and purchase order visibility.',
        permissions: [
            ...ofModule('inventory'),
            ...readOnly().filter((key) => [
                'purchasing.po.read',
                'purchasing.receipt.read',
                'purchasing.vendor.read',
                'sales.order.read',
                'dashboard.read',
                'search.read',
                'documents.print',
            ].includes(key)),
            'purchasing.receipt.create',
            'purchasing.receipt.post',
            'app.session.use',
            'app.prefs.write',
            'app.view.read',
        ],
    },
    viewer: {
        id: 'viewer',
        name: 'Viewer',
        description: 'Read-only across every module. Cannot change a single record.',
        permissions: [...readOnly(), 'app.prefs.write', 'documents.print', 'search.read', 'dashboard.read'],
    },
};
/** Preset ids in display order. */
exports.ROLE_PRESET_IDS = [
    'owner',
    'admin',
    'accountant',
    'sales',
    'warehouse',
    'viewer',
];
/** Deduplicated union of several role permission lists, unknown keys dropped. */
function resolvePermissions(lists) {
    const result = new Set();
    for (const list of lists) {
        for (const key of list) {
            if (isPermission(key))
                result.add(key);
        }
    }
    return result;
}
/** Catalogue grouped by module, for the role editor matrix. */
function permissionGroups() {
    const order = [
        'app',
        'dashboard',
        'search',
        'finance',
        'inventory',
        'purchasing',
        'sales',
        'crm',
        'documents',
        'settings',
    ];
    return order.map((module) => ({
        module,
        items: exports.PERMISSION_KEYS.filter((key) => exports.PERMISSIONS[key].module === module).map((key) => ({
            key,
            label: exports.PERMISSIONS[key].label,
            risk: exports.PERMISSIONS[key].risk,
        })),
    }));
}
//# sourceMappingURL=permissions.js.map