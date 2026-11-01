"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.demoIndex = demoIndex;
exports.demoLoaded = demoLoaded;
exports.presetById = presetById;
exports.applyPreset = applyPreset;
exports.seedDemo = seedDemo;
exports.removeDemo = removeDemo;
/**
 * Industry presets and demo data (TASKS T04, §D.2).
 *
 * Two hard requirements live here:
 *   1. `applyPreset` and `seedDemo` are **transaction bodies**. They never call
 *      `conn().tx()` themselves, so onboarding can compose them into one atomic
 *      step: a throw anywhere leaves zero rows behind (T04 acceptance #3).
 *   2. Demo rows are recorded in `settings['demo.seed']` as `{ table: id[] }`.
 *      `removeDemo` deletes exactly those ids, so a user's own records survive
 *      (T04 acceptance #11) — no guessing from name prefixes.
 */
const currencies_1 = require("../../shared/currencies");
const node_crypto_1 = require("node:crypto");
const dates_1 = require("../../shared/dates");
const industry_presets_1 = require("../../shared/industry-presets");
const money_1 = require("../../shared/money");
const connection_1 = require("../db/connection");
const errors_1 = require("../errors");
const settings_1 = require("../services/settings");
const DEMO_KEY = 'demo.seed';
function demoIndex() {
    return (0, settings_1.readSetting)(DEMO_KEY) ?? {};
}
/** True when demo rows are currently loaded. */
function demoLoaded() {
    const index = demoIndex();
    return Object.values(index).some((ids) => ids.length > 0);
}
function record(table, id, index) {
    const list = index[table] ?? [];
    list.push(id);
    index[table] = list;
}
// ── presets ──────────────────────────────────────────────────────────────────
function presetById(presetId) {
    const preset = industry_presets_1.INDUSTRY_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset)
        throw (0, errors_1.validation)('presetId', 'Pick one of the listed industries.');
    return preset;
}
/**
 * Writes the preset's chart of accounts, taxes, numbering, custom fields and
 * CRM pipeline. **Transaction body** — the caller owns BEGIN/COMMIT.
 *
 * Accounts are inserted parents-first (shorter codes first) because
 * `accounts.parent_id` is a real foreign key.
 */
function applyPreset(presetId, currencyCode) {
    const preset = presetById(presetId);
    const company = (0, settings_1.getCompany)();
    if (!company)
        throw (0, errors_1.notFound)('Company');
    const currency = currencyCode ?? company.baseCurrency;
    const at = (0, dates_1.nowIso)();
    // 1. Chart of accounts — sorted by depth so a parent always exists first.
    const codeToId = new Map();
    const ordered = [...preset.coaSeed].sort((a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code));
    for (const account of ordered) {
        const existing = (0, connection_1.conn)().one('SELECT id FROM accounts WHERE code = ?', [account.code]);
        if (existing) {
            codeToId.set(account.code, existing.id);
            continue;
        }
        const id = (0, node_crypto_1.randomUUID)();
        const parentId = account.parentCode ? codeToId.get(account.parentCode) ?? null : null;
        (0, connection_1.conn)().run(`INSERT INTO accounts (id, code, name, type, parent_id, is_postable, currency, is_archived, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)`, [id, account.code, account.name, account.type, parentId, account.isPostable ? 1 : 0, at, at]);
        codeToId.set(account.code, id);
    }
    // 2. Taxes, wired to the output/input tax accounts the preset names.
    for (const tax of preset.taxes) {
        const clash = (0, connection_1.conn)().one('SELECT id FROM taxes WHERE name = ?', [tax.name]);
        if (clash)
            continue;
        (0, connection_1.conn)().run(`INSERT INTO taxes (id, name, rate_bp, is_inclusive, is_compound, account_id, is_archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`, [
            (0, node_crypto_1.randomUUID)(),
            tax.name,
            tax.rateBp,
            tax.isInclusive ? 1 : 0,
            tax.isCompound ? 1 : 0,
            tax.accountCode ? codeToId.get(tax.accountCode) ?? null : null,
            at,
            at,
        ]);
    }
    // 3. Currencies — the base first, then every other currency we can name.
    const base = (0, currencies_1.currencyDef)(currency);
    (0, connection_1.conn)().run(`INSERT INTO currencies (code, name, symbol, decimals, rate_bp, is_base, updated_at)
     VALUES (?, ?, ?, ?, 10000, 1, ?)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name,
       symbol = excluded.symbol,
       decimals = excluded.decimals,
       is_base = 1,
       rate_bp = 10000,
       updated_at = excluded.updated_at`, [currency, base?.name ?? currency, base?.symbol ?? currency, base?.decimals ?? 2, at]);
    // Every currency the product can name is seeded once, inactive, so an
    // accountant switching a customer to MYR does not have to invent the row.
    for (const extra of currencies_1.CURRENCIES) {
        if (extra.code === currency)
            continue;
        (0, connection_1.conn)().run(`INSERT INTO currencies (code, name, symbol, decimals, rate_bp, is_base, updated_at)
       VALUES (?, ?, ?, ?, 10000, 0, ?) ON CONFLICT(code) DO NOTHING`, [extra.code, extra.name, extra.symbol, extra.decimals, at]);
    }
    // 4. Numbering for the current fiscal year.
    const year = (0, settings_1.ensureFiscalYear)(company.fiscalYearStartMonth);
    for (const numbering of preset.numbering) {
        (0, connection_1.conn)().run(`INSERT INTO number_sequences (doc_type, fiscal_year_id, prefix, padding, next_value, suffix)
       VALUES (?, ?, ?, ?, 1, '')
       ON CONFLICT(doc_type, fiscal_year_id) DO UPDATE SET prefix = excluded.prefix, padding = excluded.padding`, [numbering.docType, year.id, numbering.prefix, numbering.padding]);
    }
    // 5. Custom fields (US-49).
    for (const field of preset.customFields) {
        const clash = (0, connection_1.conn)().one('SELECT id FROM custom_fields WHERE entity = ? AND key = ?', [field.entity, field.key]);
        if (clash)
            continue;
        (0, connection_1.conn)().run(`INSERT INTO custom_fields (id, entity, key, label, type, is_required, options_json, sort_order, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`, [
            (0, node_crypto_1.randomUUID)(),
            field.entity,
            field.key,
            field.label,
            field.type,
            field.isRequired ? 1 : 0,
            field.options ? JSON.stringify(field.options) : null,
            at,
        ]);
    }
    // 6. Journals — the posting engine needs these codes to exist (T05, §B.4).
    for (const journal of [
        { code: 'GEN', name: 'General Journal', type: 'general' },
        { code: 'SAL', name: 'Sales Journal', type: 'sales' },
        { code: 'PUR', name: 'Purchase Journal', type: 'purchase' },
        { code: 'BNK', name: 'Bank Journal', type: 'bank' },
        { code: 'CSH', name: 'Cash Journal', type: 'cash' },
        { code: 'STK', name: 'Stock Journal', type: 'stock' },
    ]) {
        (0, connection_1.conn)().run(`INSERT INTO journals (id, code, name, type, default_account_id, is_active)
       VALUES (?, ?, ?, ?, NULL, 1) ON CONFLICT(code) DO NOTHING`, [(0, node_crypto_1.randomUUID)(), journal.code, journal.name, journal.type]);
    }
    // 7. CRM pipelines + stages (the preset may describe more than one).
    let stages = 0;
    for (const seed of preset.pipelines) {
        let pipelineId = (0, connection_1.conn)().one('SELECT id FROM pipelines WHERE name = ?', [seed.name])?.id ?? null;
        if (!pipelineId) {
            pipelineId = (0, node_crypto_1.randomUUID)();
            (0, connection_1.conn)().run('INSERT INTO pipelines (id, name, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [pipelineId, seed.name, seed.isDefault ? 1 : 0, at, at]);
        }
        for (const [index, stage] of seed.stages.entries()) {
            const clash = (0, connection_1.conn)().one('SELECT id FROM deal_stages WHERE pipeline_id = ? AND name = ?', [pipelineId, stage.name]);
            if (clash)
                continue;
            (0, connection_1.conn)().run(`INSERT INTO deal_stages (id, pipeline_id, name, sort_order, probability_bp, is_won, is_lost)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                (0, node_crypto_1.randomUUID)(),
                pipelineId,
                stage.name,
                index,
                stage.probabilityBp,
                stage.isWon ? 1 : 0,
                stage.isLost ? 1 : 0,
            ]);
            stages += 1;
        }
    }
    // Exactly one default pipeline, so `seedDemo` and the board agree on it.
    const defaults = (0, connection_1.conn)().all('SELECT id, is_default FROM pipelines ORDER BY is_default DESC, created_at ASC');
    for (const [index, row] of defaults.entries()) {
        const wanted = index === 0 ? 1 : 0;
        if (Number(row.is_default) !== wanted) {
            (0, connection_1.conn)().run('UPDATE pipelines SET is_default = ? WHERE id = ?', [wanted, row.id]);
        }
    }
    (0, connection_1.conn)().run('UPDATE companies SET industry_preset = ?, updated_at = ? WHERE id = ?', [
        preset.id,
        at,
        company.id,
    ]);
    (0, connection_1.conn)().run('UPDATE companies SET base_currency = ?, updated_at = ? WHERE id = ?', [
        currency,
        at,
        company.id,
    ]);
    return {
        presetId: preset.id,
        accounts: codeToId.size,
        taxes: preset.taxes.length,
        sequences: preset.numbering.length,
        customFields: preset.customFields.length,
        stages,
    };
}
/**
 * Seeds a demonstrable dataset: 3 customers, 3 vendors, 8 products, 6 invoices
 * across three months, 5 deals spread over the pipeline, a warehouse with two
 * locations, stock moves and activities (T04 acceptance #4).
 *
 * **Transaction body** — the caller owns BEGIN/COMMIT.
 */
function seedDemo() {
    const company = (0, settings_1.getCompany)();
    if (!company)
        throw (0, errors_1.notFound)('Company');
    const at = (0, dates_1.nowIso)();
    const today = (0, dates_1.todayIso)();
    const currency = company.baseCurrency;
    const index = {};
    let created = 0;
    const insert = (table, sql, params) => {
        const id = String(params[0]);
        (0, connection_1.conn)().run(sql, [...params]);
        record(table, id, index);
        created += 1;
        return id;
    };
    // 1. Customers.
    const customerNames = ['Northwind Trading', 'Blue Harbor Logistics', 'Meridian Health Group'];
    const customerIds = customerNames.map((name, position) => insert('customers', `INSERT INTO customers (id, code, name, legal_name, tax_id, email, phone, address_json, payment_terms_days,
         credit_limit_cents, currency, is_active, notes, custom_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, '{}', ?, ?)`, [
        (0, node_crypto_1.randomUUID)(),
        `C-${String(position + 1).padStart(4, '0')}`,
        name,
        `${name} Ltd`,
        `GST-${String(1000 + position)}`,
        `accounts@${name.toLowerCase().replace(/[^a-z]+/g, '')}.test`,
        `+1 555 01${String(10 + position)}`,
        JSON.stringify({ line1: `${100 + position} Market Street`, city: 'Springfield', country: 'US' }),
        30,
        250_000 + position * 100_000,
        currency,
        at,
        at,
    ]));
    // 2. Vendors.
    const vendorNames = ['Apex Components', 'Cascade Packaging', 'Vertex Freight'];
    const vendorIds = vendorNames.map((name, position) => insert('vendors', `INSERT INTO vendors (id, code, name, legal_name, tax_id, email, phone, address_json, payment_terms_days,
         currency, is_active, notes, custom_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, '{}', ?, ?)`, [
        (0, node_crypto_1.randomUUID)(),
        `V-${String(position + 1).padStart(4, '0')}`,
        name,
        `${name} Inc`,
        `VAT-${String(2000 + position)}`,
        `sales@${name.toLowerCase().replace(/[^a-z]+/g, '')}.test`,
        `+1 555 02${String(10 + position)}`,
        JSON.stringify({ line1: `${20 + position} Industrial Way`, city: 'Shelbyville', country: 'US' }),
        45,
        currency,
        at,
        at,
    ]));
    // 3. Products — 8, mixed stock-tracked and service.
    const stockAccount = (0, connection_1.conn)().one("SELECT id FROM accounts WHERE code = '1200'")?.id ?? null;
    const incomeAccount = (0, connection_1.conn)().one("SELECT id FROM accounts WHERE code = '4000'")?.id ?? null;
    const expenseAccount = (0, connection_1.conn)().one("SELECT id FROM accounts WHERE code = '5000'")?.id ?? null;
    const taxId = (0, connection_1.conn)().one('SELECT id FROM taxes WHERE rate_bp > 0 ORDER BY rate_bp DESC LIMIT 1')?.id ?? null;
    const productSpecs = [
        { sku: 'WID-001', name: 'Steel Widget', price: 4_500, cost: 2_600, stock: true },
        { sku: 'WID-002', name: 'Brass Widget', price: 6_200, cost: 3_500, stock: true },
        { sku: 'ASM-010', name: 'Widget Assembly', price: 18_900, cost: 11_200, stock: true },
        { sku: 'PKG-100', name: 'Shipping Carton', price: 250, cost: 120, stock: true },
        { sku: 'PKG-110', name: 'Pallet Wrap', price: 890, cost: 520, stock: true },
        { sku: 'SRV-001', name: 'Installation Service', price: 25_000, cost: 0, stock: false },
        { sku: 'SRV-002', name: 'Annual Maintenance', price: 96_000, cost: 0, stock: false },
        { sku: 'CON-001', name: 'Consumable Kit', price: 3_400, cost: 1_900, stock: true },
    ];
    const productIds = productSpecs.map((product) => insert('products', `INSERT INTO products (id, sku, barcode, name, description, uom, category, cost_method,
         standard_cost_cents, base_price_cents, tax_id, reorder_point_milli, is_stock_tracked, is_active,
         income_account_id, expense_account_id, inventory_account_id, custom_json, created_at, updated_at)
       VALUES (?, ?, NULL, ?, NULL, 'unit', 'Demo', 'avco', ?, ?, ?, ?, ?, 1, ?, ?, ?, '{}', ?, ?)`, [
        (0, node_crypto_1.randomUUID)(),
        product.sku,
        product.name,
        product.cost,
        product.price,
        taxId,
        product.stock ? 5_000 : 0,
        product.stock ? 1 : 0,
        incomeAccount,
        expenseAccount,
        product.stock ? stockAccount : null,
        at,
        at,
    ]));
    // 4. Warehouse + two locations.
    const warehouseId = insert('warehouses', `INSERT INTO warehouses (id, code, name, address_json, is_active, created_at, updated_at)
     VALUES (?, 'WH-MAIN', 'Main Warehouse', ?, 1, ?, ?)`, [(0, node_crypto_1.randomUUID)(), JSON.stringify({ city: 'Springfield', country: 'US' }), at, at]);
    const locationIds = ['A-01', 'B-02'].map((code) => insert('locations', 'INSERT INTO locations (id, warehouse_id, code, name, is_active) VALUES (?, ?, ?, ?, 1)', [(0, node_crypto_1.randomUUID)(), warehouseId, code, `Bay ${code}`]));
    // 5. Opening stock receipts, with quants derived from them per (product,
    //    location) — a quant must always equal the sum of its receipts.
    const quants = new Map();
    for (const [position, productId] of productIds.entries()) {
        const spec = productSpecs[position];
        if (!spec || !spec.stock)
            continue;
        const qtyMilli = 40_000;
        const value = (0, money_1.mulQty)((0, money_1.cents)(spec.cost), qtyMilli);
        const locationId = locationIds[position % locationIds.length];
        if (!locationId)
            continue;
        insert('stock_moves', `INSERT INTO stock_moves (id, reference, type, product_id, from_location_id, to_location_id,
         qty_milli, unit_cost_cents, value_cents, reason, status, source_type, source_id, moved_at, created_by, created_at)
       VALUES (?, ?, 'receipt', ?, NULL, ?, ?, ?, ?, 'Opening stock', 'posted', 'demo', NULL, ?, ?, ?)`, [
            (0, node_crypto_1.randomUUID)(),
            `GRN-DEMO-${String(position + 1).padStart(3, '0')}`,
            productId,
            locationId,
            qtyMilli,
            spec.cost,
            value,
            (0, dates_1.addDays)(today, -90),
            'demo',
            at,
        ]);
        const key = `${productId}|${locationId}`;
        const current = quants.get(key) ?? { productId, locationId, qty: 0, value: 0 };
        quants.set(key, { ...current, qty: current.qty + qtyMilli, value: current.value + value });
    }
    for (const quant of quants.values()) {
        (0, connection_1.conn)().run('INSERT INTO stock_quants (product_id, location_id, qty_milli, value_cents) VALUES (?, ?, ?, ?)', [quant.productId, quant.locationId, quant.qty, quant.value]);
    }
    // 6. Invoices across three months: paid, partially paid and overdue.
    const invoiceSpecs = [
        { customer: 0, daysAgo: 75, status: 'paid', paidRatio: 1, lines: [{ sku: 'WID-001', qtyMilli: 12_000 }, { sku: 'ASM-010', qtyMilli: 2_000 }] },
        { customer: 1, daysAgo: 62, status: 'paid', paidRatio: 1, lines: [{ sku: 'SRV-001', qtyMilli: 1_000 }] },
        { customer: 2, daysAgo: 48, status: 'partially_paid', paidRatio: 0.4, lines: [{ sku: 'WID-002', qtyMilli: 30_000 }, { sku: 'PKG-100', qtyMilli: 200_000 }] },
        { customer: 0, daysAgo: 33, status: 'posted', paidRatio: 0, lines: [{ sku: 'ASM-010', qtyMilli: 3_000 }, { sku: 'CON-001', qtyMilli: 5_000 }] },
        { customer: 1, daysAgo: 18, status: 'posted', paidRatio: 0, lines: [{ sku: 'SRV-002', qtyMilli: 1_000 }] },
        { customer: 2, daysAgo: 40, status: 'partially_paid', paidRatio: 0.25, lines: [{ sku: 'PKG-110', qtyMilli: 40_000 }, { sku: 'WID-001', qtyMilli: 8_000 }] },
    ];
    const taxRate = Number((0, connection_1.conn)().one('SELECT rate_bp FROM taxes ORDER BY rate_bp DESC LIMIT 1')?.rate_bp ?? 0);
    for (const [position, spec] of invoiceSpecs.entries()) {
        const invoiceId = (0, node_crypto_1.randomUUID)();
        const date = (0, dates_1.addDays)(today, -spec.daysAgo);
        const customerId = customerIds[spec.customer] ?? customerIds[0];
        if (!customerId)
            continue;
        const lineTotals = spec.lines.map((line) => {
            const productIndex = productSpecs.findIndex((candidate) => candidate.sku === line.sku);
            const price = productSpecs[productIndex]?.price ?? 0;
            const net = (0, money_1.mulQty)((0, money_1.cents)(price), line.qtyMilli);
            return { ...line, net, tax: (0, money_1.taxExclusive)(net, taxRate).tax, productIndex };
        });
        const subtotal = (0, money_1.sumCents)(lineTotals.map((line) => line.net));
        const taxTotal = (0, money_1.sumCents)(lineTotals.map((line) => line.tax));
        const total = (0, money_1.cents)(subtotal + taxTotal);
        const paid = (0, money_1.cents)(Math.round(total * spec.paidRatio));
        insert('invoices', `INSERT INTO invoices (id, number, customer_id, date, due_date, status, currency, subtotal_cents,
         discount_cents, tax_cents, total_cents, paid_cents, notes, terms, source_type, source_id,
         journal_entry_id, period_id, custom_json, posted_at, posted_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, 'demo', NULL, NULL, NULL, '{}', ?, 'demo', ?, ?)`, [
            invoiceId,
            `INV-${String(position + 1).padStart(5, '0')}`,
            customerId,
            date,
            (0, dates_1.addDays)(date, 30),
            spec.status,
            currency,
            subtotal,
            taxTotal,
            total,
            paid,
            at,
            at,
            at,
        ]);
        record('invoices', invoiceId, index);
        created += 1;
        for (const [lineNo, line] of lineTotals.entries()) {
            const productId = productIds[line.productIndex] ?? null;
            (0, connection_1.conn)().run(`INSERT INTO invoice_lines (id, invoice_id, line_no, product_id, description, qty_milli,
           unit_price_cents, discount_bp, tax_id, net_cents, tax_cents, total_cents, account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`, [
                (0, node_crypto_1.randomUUID)(),
                invoiceId,
                lineNo + 1,
                productId,
                line.sku,
                line.qtyMilli,
                productSpecs[line.productIndex]?.price ?? 0,
                taxId,
                line.net,
                line.tax,
                line.net + line.tax,
                incomeAccount,
            ]);
        }
    }
    // 7. CRM accounts, contacts and five deals spread across the stages.
    const crmAccountIds = customerNames.map((name, position) => insert('crm_accounts', `INSERT INTO crm_accounts (id, name, industry, website, phone, email, address_json, owner_id,
         customer_id, source, annual_revenue_cents, employees, notes, custom_json, created_at, updated_at)
       VALUES (?, ?, 'Demo', NULL, NULL, NULL, NULL, NULL, ?, 'demo', ?, NULL, NULL, '{}', ?, ?)`, [
        (0, node_crypto_1.randomUUID)(),
        name,
        customerIds[position] ?? null,
        1_200_000 + position * 400_000,
        at,
        at,
    ]));
    for (const [position, accountId] of crmAccountIds.entries()) {
        insert('contacts', `INSERT INTO contacts (id, account_id, first_name, last_name, title, email, phone, mobile,
         is_primary, notes, custom_json, created_at, updated_at)
       VALUES (?, ?, 'Demo', ?, 'Buyer', ?, NULL, NULL, ?, NULL, '{}', ?, ?)`, [
            (0, node_crypto_1.randomUUID)(),
            accountId,
            `Contact ${String(position + 1)}`,
            `buyer${String(position + 1)}@example.test`,
            position === 0 ? 1 : 0,
            at,
            at,
        ]);
    }
    const pipeline = (0, connection_1.conn)().one('SELECT id FROM pipelines WHERE is_default = 1 LIMIT 1');
    const stages = pipeline
        ? (0, connection_1.conn)().all('SELECT id, probability_bp, is_won, is_lost FROM deal_stages WHERE pipeline_id = ? ORDER BY sort_order', [pipeline.id])
        : [];
    const openStages = stages.filter((stage) => Number(stage.is_won) === 0 && Number(stage.is_lost) === 0);
    const dealSpecs = [
        { name: 'Northwind — line expansion', value: 1_450_000, stage: 0 },
        { name: 'Blue Harbor — annual renewal', value: 980_000, stage: 1 },
        { name: 'Meridian — pilot rollout', value: 2_300_000, stage: 2 },
        { name: 'Northwind — spare parts', value: 320_000, stage: 0 },
        { name: 'Blue Harbor — warehouse audit', value: 640_000, stage: 1 },
    ];
    for (const [position, spec] of dealSpecs.entries()) {
        const stage = openStages[Math.min(spec.stage, Math.max(openStages.length - 1, 0))];
        if (!pipeline || !stage)
            break;
        const dealId = insert('deals', `INSERT INTO deals (id, name, account_id, pipeline_id, stage_id, owner_id, value_cents, currency,
         probability_bp, expected_close_date, status, lost_reason, won_at, lost_at, lead_id, sales_order_id,
         stage_changed_at, custom_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'open', NULL, NULL, NULL, NULL, NULL, ?, '{}', ?, ?)`, [
            (0, node_crypto_1.randomUUID)(),
            spec.name,
            crmAccountIds[position % crmAccountIds.length] ?? null,
            pipeline.id,
            stage.id,
            spec.value,
            currency,
            Number(stage.probability_bp),
            (0, dates_1.addDays)(today, 15 + position * 7),
            at,
            at,
            at,
        ]);
        insert('activities', `INSERT INTO activities (id, type, subject, body, entity, entity_id, owner_id, due_at,
         completed_at, is_done, created_by, created_at)
       VALUES (?, 'call', ?, NULL, 'deal', ?, NULL, ?, NULL, 0, 'demo', ?)`, [
            (0, node_crypto_1.randomUUID)(),
            `Follow up: ${spec.name}`,
            dealId,
            (0, dates_1.addDays)(today, 3 + position),
            at,
        ]);
    }
    // 8. A few done activities on customers and vendors so timelines are not empty.
    for (const [position, customerId] of customerIds.entries()) {
        insert('activities', `INSERT INTO activities (id, type, subject, body, entity, entity_id, owner_id, due_at,
         completed_at, is_done, created_by, created_at)
       VALUES (?, 'note', ?, 'Seeded demo activity.', 'customer', ?, NULL, NULL, ?, 1, 'demo', ?)`, [(0, node_crypto_1.randomUUID)(), `Welcome call ${String(position + 1)}`, customerId, (0, dates_1.addDays)(today, -10), at]);
    }
    for (const [position, vendorId] of vendorIds.entries()) {
        insert('activities', `INSERT INTO activities (id, type, subject, body, entity, entity_id, owner_id, due_at,
         completed_at, is_done, created_by, created_at)
       VALUES (?, 'task', ?, 'Seeded demo activity.', 'vendor', ?, NULL, ?, NULL, 0, 'demo', ?)`, [(0, node_crypto_1.randomUUID)(), `Review terms ${String(position + 1)}`, vendorId, (0, dates_1.addDays)(today, 7 + position), at]);
    }
    (0, settings_1.writeSetting)(DEMO_KEY, index);
    return { created };
}
/** FK-safe delete order: children before parents. */
const DEMO_DELETE_ORDER = [
    'activities',
    'deals',
    'invoice_lines',
    'invoices',
    'contacts',
    'crm_accounts',
    'stock_quants',
    'stock_moves',
    'locations',
    'warehouses',
    'products',
    'vendors',
    'customers',
];
const DEMO_TABLE_NAMES = {
    activities: 'activities',
    deals: 'deals',
    invoices: 'invoices',
    contacts: 'contacts',
    crm_accounts: 'crm_accounts',
    locations: 'locations',
    warehouses: 'warehouses',
    products: 'products',
    vendors: 'vendors',
    customers: 'customers',
    stock_moves: 'stock_moves',
};
/**
 * Removes exactly the rows the last `seedDemo` created (T04 acceptance #11).
 * **Transaction body** — the caller owns BEGIN/COMMIT.
 */
function removeDemo() {
    const index = demoIndex();
    let removed = 0;
    for (const table of DEMO_DELETE_ORDER) {
        const ids = index[table] ?? [];
        if (table === 'invoice_lines') {
            // Lines are not indexed individually; they belong to the indexed invoices.
            for (const invoiceId of index['invoices'] ?? []) {
                const row = (0, connection_1.conn)().one('SELECT COUNT(*) AS total FROM invoice_lines WHERE invoice_id = ?', [invoiceId]);
                removed += Number(row?.total ?? 0);
                (0, connection_1.conn)().run('DELETE FROM invoice_lines WHERE invoice_id = ?', [invoiceId]);
            }
            continue;
        }
        if (table === 'stock_quants') {
            for (const productId of index['products'] ?? []) {
                (0, connection_1.conn)().run('DELETE FROM stock_quants WHERE product_id = ?', [productId]);
            }
            continue;
        }
        const sqlName = DEMO_TABLE_NAMES[table];
        if (!sqlName)
            continue;
        for (const id of ids) {
            (0, connection_1.conn)().run(`DELETE FROM ${sqlName} WHERE id = ?`, [id]);
            removed += 1;
        }
    }
    (0, settings_1.writeSetting)(DEMO_KEY, {});
    return { removed };
}
//# sourceMappingURL=seed.js.map