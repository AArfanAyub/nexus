"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * The public face of the finance service (T05/T06).
 *
 * A barrel, on purpose: `services/finance` is the import path the architecture
 * documents, and every caller — invoices, payments, and later the inventory and
 * purchasing modules — uses it. Splitting the implementation into
 * `finance.engine` / `finance.reports` / `finance.documents` / `finance.payments`
 * keeps each file small without changing that path or creating an import cycle
 * (`finance.documents` imports the engine, never this barrel).
 *
 *   engine     — `writeJournal`, reversals, the chart of accounts, period locks
 *   reports    — trial balance, general ledger, P&L, balance sheet, cash flow
 *   documents  — invoices and bills: totals, posting, voiding
 *   payments   — receipts, allocation, realised FX
 */
__exportStar(require("./finance.engine"), exports);
__exportStar(require("./finance.reports"), exports);
__exportStar(require("./finance.documents"), exports);
__exportStar(require("./finance.payments"), exports);
//# sourceMappingURL=finance.js.map