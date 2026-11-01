"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENTITY_NAMES = exports.ENTITIES = exports.MAX_PAGE_SIZE = void 0;
exports.isEntityName = isEntityName;
/**
 * The hard ceiling on any single list page (R1).
 *
 * It lives here so the validator and every caller read the same number. It used
 * to be a literal `200` in the schema while three screens asked for `500`, so
 * those requests were rejected with `VALIDATION: Must be 200 or less` and the
 * rejection was swallowed by the query hook — the dropdown simply stayed empty
 * and the user was told "a destination location is required". A single exported
 * constant is the only way to keep the two ends from drifting apart again.
 */
exports.MAX_PAGE_SIZE = 200;
/**
 * The metadata that makes `entity.*` a single generic family over 24 tables
 * (decision D-02). Permissions here are what `entity.*` resolves at dispatch.
 */
exports.ENTITIES = {
    accounts: {
        name: 'accounts',
        table: 'accounts',
        module: 'finance',
        label: 'Account',
        read: 'finance.account.read',
        write: 'finance.account.write',
        remove: 'finance.account.delete',
        softDelete: true,
    },
    journals: {
        name: 'journals',
        table: 'journals',
        module: 'finance',
        label: 'Journal',
        read: 'finance.journal.read',
        write: 'finance.journal.write',
        remove: null,
        softDelete: false,
    },
    invoices: {
        name: 'invoices',
        table: 'invoices',
        module: 'finance',
        label: 'Invoice',
        read: 'finance.invoice.read',
        write: 'finance.invoice.create',
        remove: null,
        softDelete: false,
    },
    bills: {
        name: 'bills',
        table: 'bills',
        module: 'finance',
        label: 'Bill',
        read: 'finance.bill.read',
        write: 'finance.bill.create',
        remove: null,
        softDelete: false,
    },
    payments: {
        name: 'payments',
        table: 'payments',
        module: 'finance',
        label: 'Payment',
        read: 'finance.payment.read',
        write: 'finance.payment.create',
        remove: null,
        softDelete: false,
    },
    taxes: {
        name: 'taxes',
        table: 'taxes',
        module: 'settings',
        label: 'Tax rate',
        read: 'settings.tax.read',
        write: 'settings.tax.manage',
        remove: 'settings.tax.manage',
        softDelete: false,
    },
    currencies: {
        name: 'currencies',
        table: 'currencies',
        module: 'settings',
        label: 'Currency',
        read: 'settings.currency.read',
        write: 'settings.currency.manage',
        remove: null,
        softDelete: false,
    },
    products: {
        name: 'products',
        table: 'products',
        module: 'inventory',
        label: 'Product',
        read: 'inventory.product.read',
        write: 'inventory.product.write',
        remove: 'inventory.product.delete',
        softDelete: true,
    },
    warehouses: {
        name: 'warehouses',
        table: 'warehouses',
        module: 'inventory',
        label: 'Warehouse',
        read: 'inventory.warehouse.read',
        write: 'inventory.warehouse.write',
        remove: 'inventory.warehouse.delete',
        softDelete: false,
    },
    locations: {
        name: 'locations',
        table: 'locations',
        module: 'inventory',
        label: 'Location',
        read: 'inventory.warehouse.read',
        write: 'inventory.warehouse.write',
        remove: 'inventory.warehouse.delete',
        softDelete: false,
    },
    customers: {
        name: 'customers',
        table: 'customers',
        module: 'sales',
        label: 'Customer',
        read: 'sales.customer.read',
        write: 'sales.customer.write',
        remove: 'sales.customer.delete',
        softDelete: true,
    },
    vendors: {
        name: 'vendors',
        table: 'vendors',
        module: 'purchasing',
        label: 'Vendor',
        read: 'purchasing.vendor.read',
        write: 'purchasing.vendor.write',
        remove: 'purchasing.vendor.delete',
        softDelete: true,
    },
    quotes: {
        name: 'quotes',
        table: 'quotes',
        module: 'sales',
        label: 'Quotation',
        read: 'sales.quotation.read',
        write: 'sales.quotation.create',
        remove: null,
        softDelete: false,
    },
    salesOrders: {
        name: 'salesOrders',
        table: 'sales_orders',
        module: 'sales',
        label: 'Sales order',
        read: 'sales.order.read',
        write: 'sales.order.create',
        remove: null,
        softDelete: false,
    },
    priceLists: {
        name: 'priceLists',
        table: 'price_lists',
        module: 'sales',
        label: 'Price list',
        read: 'sales.pricelist.read',
        write: 'sales.pricelist.manage',
        remove: 'sales.pricelist.manage',
        softDelete: false,
    },
    crmAccounts: {
        name: 'crmAccounts',
        table: 'crm_accounts',
        module: 'crm',
        label: 'Account',
        read: 'crm.account.read',
        write: 'crm.account.write',
        remove: 'crm.account.delete',
        softDelete: true,
    },
    contacts: {
        name: 'contacts',
        table: 'contacts',
        module: 'crm',
        label: 'Contact',
        read: 'crm.contact.read',
        write: 'crm.contact.write',
        remove: 'crm.contact.delete',
        softDelete: true,
    },
    leads: {
        name: 'leads',
        table: 'leads',
        module: 'crm',
        label: 'Lead',
        read: 'crm.lead.read',
        write: 'crm.lead.write',
        remove: 'crm.lead.delete',
        softDelete: false,
    },
    deals: {
        name: 'deals',
        table: 'deals',
        module: 'crm',
        label: 'Deal',
        read: 'crm.deal.read',
        write: 'crm.deal.write',
        remove: 'crm.deal.delete',
        softDelete: true,
    },
    activities: {
        name: 'activities',
        table: 'activities',
        module: 'crm',
        label: 'Activity',
        read: 'crm.activity.read',
        write: 'crm.activity.write',
        remove: 'crm.activity.delete',
        softDelete: false,
    },
    users: {
        name: 'users',
        table: 'users',
        module: 'settings',
        label: 'User',
        read: 'settings.user.read',
        write: 'settings.user.manage',
        remove: null,
        softDelete: true,
    },
    roles: {
        name: 'roles',
        table: 'roles',
        module: 'settings',
        label: 'Role',
        read: 'settings.role.read',
        write: 'settings.role.manage',
        remove: 'settings.role.manage',
        softDelete: true,
    },
    customFields: {
        name: 'customFields',
        table: 'custom_fields',
        module: 'settings',
        label: 'Custom field',
        read: 'settings.custom_field.read',
        write: 'settings.custom_field.manage',
        remove: 'settings.custom_field.manage',
        softDelete: false,
    },
    savedViews: {
        name: 'savedViews',
        table: 'saved_views',
        module: 'app',
        label: 'Saved view',
        read: 'app.view.read',
        write: 'app.view.write',
        remove: 'app.view.write',
        softDelete: false,
    },
};
/** Runtime list of entity names, used to validate `entity.*` payloads. */
exports.ENTITY_NAMES = Object.keys(exports.ENTITIES);
/** Type guard for the `entity` field of a generic payload. */
function isEntityName(value) {
    return Object.prototype.hasOwnProperty.call(exports.ENTITIES, value);
}
//# sourceMappingURL=types.js.map