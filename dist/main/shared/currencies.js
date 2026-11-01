"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CURRENCIES = void 0;
exports.currencyDef = currencyDef;
exports.isKnownCurrency = isKnownCurrency;
exports.currencyOptions = currencyOptions;
exports.CURRENCIES = [
    { code: 'MYR', name: 'Malaysian ringgit', symbol: 'RM', decimals: 2 },
    { code: 'USD', name: 'US dollar', symbol: '$', decimals: 2 },
    { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 },
    { code: 'GBP', name: 'Pound sterling', symbol: '£', decimals: 2 },
    { code: 'SGD', name: 'Singapore dollar', symbol: 'S$', decimals: 2 },
    { code: 'IDR', name: 'Indonesian rupiah', symbol: 'Rp', decimals: 2 },
    { code: 'THB', name: 'Thai baht', symbol: '฿', decimals: 2 },
    { code: 'PHP', name: 'Philippine peso', symbol: '₱', decimals: 2 },
    { code: 'VND', name: 'Vietnamese dong', symbol: '₫', decimals: 0 },
    { code: 'INR', name: 'Indian rupee', symbol: '₹', decimals: 2 },
    { code: 'AED', name: 'UAE dirham', symbol: 'د.إ', decimals: 2 },
    { code: 'SAR', name: 'Saudi riyal', symbol: '﷼', decimals: 2 },
    { code: 'CNY', name: 'Chinese yuan', symbol: '¥', decimals: 2 },
    { code: 'JPY', name: 'Japanese yen', symbol: '¥', decimals: 0 },
    { code: 'KRW', name: 'South Korean won', symbol: '₩', decimals: 0 },
    { code: 'AUD', name: 'Australian dollar', symbol: 'A$', decimals: 2 },
    { code: 'CAD', name: 'Canadian dollar', symbol: 'C$', decimals: 2 },
    { code: 'ZAR', name: 'South African rand', symbol: 'R', decimals: 2 },
    { code: 'BRL', name: 'Brazilian real', symbol: 'R$', decimals: 2 },
    { code: 'MXN', name: 'Mexican peso', symbol: 'MX$', decimals: 2 },
];
const BY_CODE = new Map(exports.CURRENCIES.map((entry) => [entry.code, entry]));
function currencyDef(code) {
    return BY_CODE.get(code.toUpperCase());
}
/** True when the code is one we can name — anything else is still accepted as a raw code. */
function isKnownCurrency(code) {
    return BY_CODE.has(code.toUpperCase());
}
/** Options for a `<Select>`, base currency first. */
function currencyOptions(baseCode) {
    const ordered = baseCode
        ? [...exports.CURRENCIES].sort((a, b) => (a.code === baseCode ? -1 : b.code === baseCode ? 1 : 0))
        : [...exports.CURRENCIES];
    return ordered.map((entry) => ({ value: entry.code, label: `${entry.code} — ${entry.name}` }));
}
//# sourceMappingURL=currencies.js.map