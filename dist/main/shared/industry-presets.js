"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRESET_IDS = exports.INDUSTRY_PRESETS = void 0;
exports.presetById = presetById;
exports.previewOf = previewOf;
exports.validatePresets = validatePresets;
// ── the shared chart skeleton ────────────────────────────────────────────────
const CORE_COA = [
    { code: '1000', name: 'Current Assets', type: 'asset', parentCode: null, isPostable: false },
    { code: '1010', name: 'Cash on Hand', type: 'asset', parentCode: '1000', isPostable: true },
    { code: '1020', name: 'Bank Account', type: 'asset', parentCode: '1000', isPostable: true },
    { code: '1100', name: 'Accounts Receivable', type: 'asset', parentCode: '1000', isPostable: true },
    { code: '1300', name: 'Input Tax Recoverable', type: 'asset', parentCode: '1000', isPostable: true },
    { code: '2000', name: 'Current Liabilities', type: 'liability', parentCode: null, isPostable: false },
    { code: '2100', name: 'Accounts Payable', type: 'liability', parentCode: '2000', isPostable: true },
    {
        code: '2110',
        name: 'Goods Received Not Invoiced',
        type: 'liability',
        parentCode: '2000',
        isPostable: true,
    },
    { code: '2200', name: 'Tax Payable', type: 'liability', parentCode: '2000', isPostable: true },
    { code: '3000', name: 'Equity', type: 'equity', parentCode: null, isPostable: false },
    { code: '3100', name: 'Retained Earnings', type: 'equity', parentCode: '3000', isPostable: true },
    { code: '3900', name: 'Suspense', type: 'equity', parentCode: '3000', isPostable: true },
    { code: '4000', name: 'Revenue', type: 'income', parentCode: null, isPostable: false },
    { code: '4010', name: 'Sales of Goods', type: 'income', parentCode: '4000', isPostable: true },
    { code: '4020', name: 'Sales of Services', type: 'income', parentCode: '4000', isPostable: true },
    { code: '5000', name: 'Cost of Sales', type: 'expense', parentCode: null, isPostable: false },
    { code: '5010', name: 'Cost of Goods Sold', type: 'expense', parentCode: '5000', isPostable: true },
    { code: '6000', name: 'Operating Expenses', type: 'expense', parentCode: null, isPostable: false },
    { code: '6010', name: 'Rent', type: 'expense', parentCode: '6000', isPostable: true },
    { code: '6020', name: 'Salaries and Wages', type: 'expense', parentCode: '6000', isPostable: true },
    { code: '6030', name: 'Utilities', type: 'expense', parentCode: '6000', isPostable: true },
    { code: '6040', name: 'Professional Fees', type: 'expense', parentCode: '6000', isPostable: true },
    { code: '6050', name: 'Marketing', type: 'expense', parentCode: '6000', isPostable: true },
    { code: '6090', name: 'Bank Charges', type: 'expense', parentCode: '6000', isPostable: true },
];
const INVENTORY_PARENT = {
    code: '1200',
    name: 'Inventory',
    type: 'asset',
    parentCode: '1000',
    isPostable: false,
};
/** Builds a chart: the shared skeleton, the inventory branch when the preset stocks goods, plus its own accounts. */
function coa(stockTracked, extra) {
    const base = stockTracked ? [...CORE_COA, INVENTORY_PARENT] : [...CORE_COA];
    return [...base, ...extra].sort((a, b) => a.code.localeCompare(b.code));
}
const STANDARD_NUMBERING = [
    { docType: 'invoice', prefix: 'INV-', padding: 5 },
    { docType: 'bill', prefix: 'BILL-', padding: 5 },
    { docType: 'purchase_order', prefix: 'PO-', padding: 5 },
    { docType: 'goods_receipt', prefix: 'GRN-', padding: 5 },
    { docType: 'quote', prefix: 'QT-', padding: 5 },
    { docType: 'sales_order', prefix: 'SO-', padding: 5 },
    { docType: 'payment', prefix: 'PAY-', padding: 5 },
    { docType: 'journal', prefix: 'JE-', padding: 5 },
];
function numbering(overrides) {
    return STANDARD_NUMBERING.map((seed) => {
        const override = overrides.find((entry) => entry.docType === seed.docType);
        return override ? { ...seed, prefix: override.prefix } : seed;
    });
}
const SALES_PIPELINE = {
    name: 'Sales pipeline',
    isDefault: true,
    stages: [
        { name: 'New', probabilityBp: 1000 },
        { name: 'Qualified', probabilityBp: 2500 },
        { name: 'Proposal', probabilityBp: 5000 },
        { name: 'Negotiation', probabilityBp: 7500 },
        { name: 'Won', probabilityBp: 10000, isWon: true },
        { name: 'Lost', probabilityBp: 0, isLost: true },
    ],
};
const STANDARD_TERMS = [
    { label: 'Due on receipt', days: 0 },
    { label: 'Net 15', days: 15 },
    { label: 'Net 30', days: 30 },
    { label: 'Net 60', days: 60 },
];
const VAT_20 = { name: 'VAT 20%', rateBp: 2000, isInclusive: false, isCompound: false, accountCode: '2200' };
const VAT_10 = { name: 'VAT 10% reduced', rateBp: 1000, isInclusive: false, isCompound: false, accountCode: '2200' };
const VAT_5 = { name: 'VAT 5% reduced', rateBp: 500, isInclusive: false, isCompound: false, accountCode: '2200' };
const ZERO_RATED = { name: 'Zero-rated 0%', rateBp: 0, isInclusive: false, isCompound: false, accountCode: '2200' };
const EXEMPT = { name: 'Exempt', rateBp: 0, isInclusive: false, isCompound: false, accountCode: null };
// ── the seven presets ────────────────────────────────────────────────────────
exports.INDUSTRY_PRESETS = [
    {
        id: 'manufacturing',
        label: 'Manufacturing',
        description: 'Buy materials, build goods, sell finished products. Adds work-in-progress and finished-goods accounts, machine cost tracking and a bill-of-materials note field.',
        modules: ['dashboard', 'finance', 'inventory', 'purchasing', 'sales', 'crm', 'documents', 'settings'],
        coaSeed: coa(true, [
            { code: '1210', name: 'Raw Materials', type: 'asset', parentCode: '1200', isPostable: true },
            { code: '1240', name: 'Work in Progress', type: 'asset', parentCode: '1200', isPostable: true },
            { code: '1250', name: 'Finished Goods', type: 'asset', parentCode: '1200', isPostable: true },
            { code: '5020', name: 'Purchase Price Variance', type: 'expense', parentCode: '5000', isPostable: true },
            { code: '6060', name: 'Machine Maintenance', type: 'expense', parentCode: '6000', isPostable: true },
            { code: '6070', name: 'Depreciation', type: 'expense', parentCode: '6000', isPostable: true },
        ]),
        taxes: [VAT_20, VAT_10, ZERO_RATED, EXEMPT],
        numbering: numbering([
            { docType: 'invoice', prefix: 'INV-' },
            { docType: 'purchase_order', prefix: 'PO-' },
            { docType: 'goods_receipt', prefix: 'GRN-' },
        ]),
        customFields: [
            { entity: 'products', key: 'machine_capacity', label: 'Machine capacity (units/hr)', type: 'number', isRequired: false },
            { entity: 'products', key: 'bom_notes', label: 'Bill of materials notes', type: 'text', isRequired: false },
            { entity: 'products', key: 'work_center', label: 'Work centre', type: 'select', isRequired: false, options: ['Line A', 'Line B', 'Assembly', 'Finishing'] },
            { entity: 'customers', key: 'gstin', label: 'GSTIN', type: 'text', isRequired: false },
        ],
        pipelines: [SALES_PIPELINE],
        uoms: ['unit', 'kg', 'm', 'box', 'hour'],
        paymentTerms: STANDARD_TERMS,
        landingModule: 'dashboard',
    },
    {
        id: 'wholesale_retail',
        label: 'Wholesale / Retail',
        description: 'Buy and resell at volume, with shelf locations and a POS-ready tax set. Lands on the product list because stock is the day job.',
        modules: ['dashboard', 'finance', 'inventory', 'purchasing', 'sales', 'crm', 'documents', 'settings'],
        coaSeed: coa(true, [
            { code: '1210', name: 'Stock - Trade', type: 'asset', parentCode: '1200', isPostable: true },
            { code: '5020', name: 'Purchase Price Variance', type: 'expense', parentCode: '5000', isPostable: true },
            { code: '5030', name: 'Stock Adjustments', type: 'expense', parentCode: '5000', isPostable: true },
            { code: '6060', name: 'Software and Subscriptions', type: 'expense', parentCode: '6000', isPostable: true },
            { code: '6080', name: 'Card and POS Fees', type: 'expense', parentCode: '6000', isPostable: true },
        ]),
        taxes: [VAT_20, VAT_5, ZERO_RATED],
        numbering: numbering([
            { docType: 'invoice', prefix: 'INV-' },
            { docType: 'quote', prefix: 'QT-' },
        ]),
        customFields: [
            { entity: 'products', key: 'barcode_alt', label: 'Alternate barcode', type: 'text', isRequired: false },
            { entity: 'products', key: 'shelf_location', label: 'Shelf location', type: 'text', isRequired: false },
            { entity: 'customers', key: 'gstin', label: 'GSTIN', type: 'text', isRequired: false },
            { entity: 'customers', key: 'loyalty_tier', label: 'Loyalty tier', type: 'select', isRequired: false, options: ['None', 'Silver', 'Gold'] },
        ],
        pipelines: [SALES_PIPELINE],
        uoms: ['unit', 'box', 'pack', 'kg', 'l'],
        paymentTerms: STANDARD_TERMS,
        landingModule: 'inventory',
    },
    {
        id: 'services',
        label: 'Professional services',
        description: 'Sell time, not stock. No inventory module and no stock accounts; subcontractor cost and engagement codes instead. Lands on the deal board.',
        modules: ['dashboard', 'finance', 'purchasing', 'sales', 'crm', 'documents', 'settings'],
        coaSeed: coa(false, [
            { code: '4030', name: 'Sales Discounts', type: 'income', parentCode: '4000', isPostable: true },
            { code: '4900', name: 'Other Income', type: 'income', parentCode: null, isPostable: true },
            { code: '6100', name: 'Subcontractors', type: 'expense', parentCode: '6000', isPostable: true },
            { code: '6060', name: 'Software and Subscriptions', type: 'expense', parentCode: '6000', isPostable: true },
            { code: '6070', name: 'Travel and Entertainment', type: 'expense', parentCode: '6000', isPostable: true },
        ]),
        taxes: [VAT_20, { name: 'Reverse charge 0%', rateBp: 0, isInclusive: false, isCompound: false, accountCode: '2200' }],
        numbering: numbering([
            { docType: 'invoice', prefix: 'INV-' },
            { docType: 'quote', prefix: 'QT-' },
        ]),
        customFields: [
            { entity: 'customers', key: 'engagement_code', label: 'Engagement code', type: 'text', isRequired: true },
            { entity: 'contacts', key: 'department', label: 'Department', type: 'text', isRequired: false },
            { entity: 'products', key: 'billable_role', label: 'Billable role', type: 'select', isRequired: false, options: ['Partner', 'Manager', 'Consultant', 'Analyst'] },
            { entity: 'deals', key: 'engagement_type', label: 'Engagement type', type: 'select', isRequired: false, options: ['Fixed fee', 'Time and materials', 'Retainer'] },
        ],
        pipelines: [
            {
                name: 'Consulting pipeline',
                isDefault: true,
                stages: [
                    { name: 'Lead', probabilityBp: 1000 },
                    { name: 'Discovery', probabilityBp: 3000 },
                    { name: 'Proposal', probabilityBp: 6000 },
                    { name: 'Won', probabilityBp: 10000, isWon: true },
                    { name: 'Lost', probabilityBp: 0, isLost: true },
                ],
            },
        ],
        uoms: ['hour', 'day', 'unit'],
        paymentTerms: STANDARD_TERMS,
        landingModule: 'crm',
    },
    {
        id: 'construction',
        label: 'Construction',
        description: 'Long projects, retentions and CIS deductions. Adds contract work-in-progress, subcontract cost and a tender reference on deals.',
        modules: ['dashboard', 'finance', 'inventory', 'purchasing', 'sales', 'crm', 'documents', 'settings'],
        coaSeed: coa(true, [
            { code: '1310', name: 'Work in Progress - Contracts', type: 'asset', parentCode: '1000', isPostable: true },
            { code: '1210', name: 'Materials on Site', type: 'asset', parentCode: '1200', isPostable: true },
            { code: '5100', name: 'Subcontract Cost', type: 'expense', parentCode: '5000', isPostable: true },
            { code: '5110', name: 'Site Labour', type: 'expense', parentCode: '5000', isPostable: true },
            { code: '5120', name: 'Plant and Equipment Hire', type: 'expense', parentCode: '5000', isPostable: true },
            { code: '6060', name: 'Insurance', type: 'expense', parentCode: '6000', isPostable: true },
        ]),
        taxes: [VAT_20, VAT_5, { name: 'CIS deduction 20%', rateBp: 2000, isInclusive: false, isCompound: false, accountCode: '2200' }],
        numbering: numbering([
            { docType: 'invoice', prefix: 'IPC-' },
            { docType: 'purchase_order', prefix: 'PO-' },
            { docType: 'goods_receipt', prefix: 'GRN-' },
        ]),
        customFields: [
            { entity: 'products', key: 'retention_pct', label: 'Retention %', type: 'number', isRequired: false },
            { entity: 'customers', key: 'site_address', label: 'Site address', type: 'text', isRequired: false },
            { entity: 'deals', key: 'tender_ref', label: 'Tender reference', type: 'text', isRequired: false },
            { entity: 'deals', key: 'contract_value', label: 'Contract value', type: 'money', isRequired: false },
        ],
        pipelines: [SALES_PIPELINE],
        uoms: ['unit', 'm', 'm2', 'm3', 'tonne', 'day'],
        paymentTerms: [
            { label: 'Due on receipt', days: 0 },
            { label: 'Net 30', days: 30 },
            { label: 'Net 45', days: 45 },
            { label: 'Net 60', days: 60 },
        ],
        landingModule: 'dashboard',
    },
    {
        id: 'education',
        label: 'Education',
        description: 'Tuition, grants and student billing. Fund-style income accounts, no inventory, and a student id on the customer record.',
        modules: ['dashboard', 'finance', 'purchasing', 'sales', 'crm', 'documents', 'settings'],
        coaSeed: coa(false, [
            { code: '4100', name: 'Tuition Fees', type: 'income', parentCode: '4000', isPostable: true },
            { code: '4200', name: 'Grants and Funding', type: 'income', parentCode: '4000', isPostable: true },
            { code: '4300', name: 'Donations', type: 'income', parentCode: '4000', isPostable: true },
            { code: '6060', name: 'Teaching Materials', type: 'expense', parentCode: '6000', isPostable: true },
            { code: '6070', name: 'Student Services', type: 'expense', parentCode: '6000', isPostable: true },
        ]),
        taxes: [ZERO_RATED, EXEMPT],
        numbering: numbering([
            { docType: 'invoice', prefix: 'INV-' },
            { docType: 'quote', prefix: 'QT-' },
        ]),
        customFields: [
            { entity: 'customers', key: 'student_id', label: 'Student ID', type: 'text', isRequired: true },
            { entity: 'contacts', key: 'guardian_phone', label: 'Guardian phone', type: 'text', isRequired: false },
            { entity: 'customers', key: 'programme', label: 'Programme', type: 'text', isRequired: false },
        ],
        pipelines: [SALES_PIPELINE],
        uoms: ['term', 'unit', 'hour'],
        paymentTerms: STANDARD_TERMS,
        landingModule: 'dashboard',
    },
    {
        id: 'ngo',
        label: 'NGO / Non-profit',
        description: 'Donations, grants and restricted funds. Fund-accounting chart, exempt-only taxes, no inventory. Every receipt needs a funder reference.',
        modules: ['dashboard', 'finance', 'purchasing', 'crm', 'documents', 'settings'],
        coaSeed: coa(false, [
            { code: '4300', name: 'Donations', type: 'income', parentCode: '4000', isPostable: true },
            { code: '4400', name: 'Grants', type: 'income', parentCode: '4000', isPostable: true },
            { code: '3300', name: 'Restricted Funds', type: 'equity', parentCode: '3000', isPostable: true },
            { code: '6100', name: 'Programme Costs', type: 'expense', parentCode: '6000', isPostable: true },
            { code: '6110', name: 'Fundraising Costs', type: 'expense', parentCode: '6000', isPostable: true },
        ]),
        taxes: [EXEMPT],
        numbering: numbering([
            { docType: 'invoice', prefix: 'INV-' },
            { docType: 'purchase_order', prefix: 'PO-' },
        ]),
        customFields: [
            { entity: 'customers', key: 'funder_ref', label: 'Funder reference', type: 'text', isRequired: true },
            { entity: 'deals', key: 'grant_cycle', label: 'Grant cycle', type: 'select', isRequired: false, options: ['Q1', 'Q2', 'Q3', 'Q4', 'Multi-year'] },
            { entity: 'customers', key: 'restricted_fund', label: 'Restricted fund', type: 'text', isRequired: false },
        ],
        pipelines: [SALES_PIPELINE],
        uoms: ['unit', 'hour', 'grant'],
        paymentTerms: STANDARD_TERMS,
        landingModule: 'dashboard',
    },
    {
        id: 'logistics',
        label: 'Logistics',
        description: 'Move freight, bill per consignment. Adds freight-in-transit stock, fuel and driver costs, and an incoterm on sales orders.',
        modules: ['dashboard', 'finance', 'inventory', 'purchasing', 'sales', 'crm', 'documents', 'settings'],
        coaSeed: coa(true, [
            { code: '1230', name: 'Freight in Transit', type: 'asset', parentCode: '1200', isPostable: true },
            { code: '5040', name: 'Freight and Duty', type: 'expense', parentCode: '5000', isPostable: true },
            { code: '5050', name: 'Fuel', type: 'expense', parentCode: '5000', isPostable: true },
            { code: '5060', name: 'Driver Costs', type: 'expense', parentCode: '5000', isPostable: true },
            { code: '6060', name: 'Depot and Warehouse Rent', type: 'expense', parentCode: '6000', isPostable: true },
        ]),
        taxes: [VAT_20, ZERO_RATED],
        numbering: numbering([
            { docType: 'invoice', prefix: 'INV-' },
            { docType: 'sales_order', prefix: 'SO-' },
            { docType: 'goods_receipt', prefix: 'GRN-' },
        ]),
        customFields: [
            { entity: 'products', key: 'volume_m3', label: 'Volume (m3)', type: 'number', isRequired: false },
            { entity: 'customers', key: 'consignee_ref', label: 'Consignee reference', type: 'text', isRequired: false },
            { entity: 'salesOrders', key: 'incoterm', label: 'Incoterm', type: 'select', isRequired: false, options: ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DDP'] },
        ],
        pipelines: [SALES_PIPELINE],
        uoms: ['unit', 'pallet', 'container', 'kg', 'm3'],
        paymentTerms: STANDARD_TERMS,
        landingModule: 'dashboard',
    },
];
/** Preset ids in catalogue order. */
exports.PRESET_IDS = exports.INDUSTRY_PRESETS.map((preset) => preset.id);
/** Looks a preset up by id; returns `undefined` for an unknown id. */
function presetById(id) {
    return exports.INDUSTRY_PRESETS.find((preset) => preset.id === id);
}
/** The preview contract the onboarding wizard renders before writing anything. */
function previewOf(preset) {
    return {
        id: preset.id,
        label: preset.label,
        description: preset.description,
        modules: preset.modules,
        coa: { count: preset.coaSeed.length, sample: preset.coaSeed.slice(0, 8) },
        taxes: preset.taxes,
        numbering: preset.numbering,
        customFields: preset.customFields,
        landing: preset.landingModule,
    };
}
/**
 * Structural validation of every preset chart: unique codes, resolvable
 * parents, at least one postable account per type, and the 20–35 account
 * window promised in T01 acceptance #7. Called by `npm test`.
 */
function validatePresets() {
    const problems = [];
    if (exports.INDUSTRY_PRESETS.length !== 7)
        problems.push(`expected 7 presets, found ${String(exports.INDUSTRY_PRESETS.length)}`);
    for (const preset of exports.INDUSTRY_PRESETS) {
        if (preset.coaSeed.length < 20 || preset.coaSeed.length > 35) {
            problems.push(`${preset.id}: chart has ${String(preset.coaSeed.length)} accounts, expected 20-35`);
        }
        const codes = new Set();
        for (const account of preset.coaSeed) {
            if (codes.has(account.code))
                problems.push(`${preset.id}: duplicate account code ${account.code}`);
            codes.add(account.code);
        }
        for (const account of preset.coaSeed) {
            if (account.parentCode !== null && !codes.has(account.parentCode)) {
                problems.push(`${preset.id}: account ${account.code} has unknown parent ${account.parentCode}`);
            }
        }
        for (const type of ['asset', 'liability', 'equity', 'income', 'expense']) {
            if (!preset.coaSeed.some((account) => account.type === type && account.isPostable)) {
                problems.push(`${preset.id}: no postable ${type} account`);
            }
        }
        if (preset.taxes.length === 0)
            problems.push(`${preset.id}: no tax rates seeded`);
        if (preset.numbering.length === 0)
            problems.push(`${preset.id}: no numbering sequences`);
        if (!preset.modules.includes(preset.landingModule)) {
            problems.push(`${preset.id}: landing module ${preset.landingModule} is not enabled`);
        }
        if (!preset.pipelines.some((pipeline) => pipeline.isDefault)) {
            problems.push(`${preset.id}: no default pipeline`);
        }
    }
    return problems;
}
//# sourceMappingURL=industry-presets.js.map