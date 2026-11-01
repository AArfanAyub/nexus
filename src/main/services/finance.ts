/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

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

export * from './finance.engine';
export * from './finance.reports';
export * from './finance.documents';
export * from './finance.payments';
