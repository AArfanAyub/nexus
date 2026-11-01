/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The single source of truth for every IPC channel (ARCHITECTURE §C).
 *
 * - `CHANNELS` is a readonly literal tuple: adding a channel here is step 1 of
 *   the 5-file checklist in CONVENTIONS §7.
 * - `CHANNEL_PERMISSIONS` makes the permission requirement structural: a
 *   channel cannot be dispatched without one, which is what makes BR-20 real.
 * - `preload/index.ts` imports `CHANNELS` and freezes it into a `Set`, so the
 *   allow-list can never drift from the catalogue.
 */

import type { Permission } from './permissions';

export const CHANNELS = [
  // ── generic entity family (§C.2) ───────────────────────────────────────────
  'entity.list',
  'entity.get',
  'entity.save',
  'entity.archive',
  'entity.restore',
  'entity.delete',
  'entity.export',

  // ── app, session, auth, onboarding (§C.3) ──────────────────────────────────
  'app.bootstrap',
  'app.prefs.save',
  'app.quit',
  'auth.login',
  'auth.unlock',
  'auth.lock',
  'auth.logout',
  'auth.session',
  'auth.password.change',
  'auth.heartbeat',
  'onboarding.status',
  'onboarding.preview',
  'onboarding.complete',

  // ── users, roles, permissions (§C.4) ───────────────────────────────────────
  'users.create',
  'users.update',
  'users.setActive',
  'users.resetPassword',
  'roles.duplicate',
  'permissions.catalog',

  // ── settings (§C.5) ────────────────────────────────────────────────────────
  'settings.get',
  'settings.company.save',
  'settings.company.logo',
  'settings.numbering.list',
  'settings.numbering.save',
  'settings.numbering.preview',
  'settings.numbering.reset',
  'settings.currency.setBase',
  'settings.presets.list',
  'settings.presets.preview',
  'settings.presets.apply',
  'settings.demoData.seed',
  'settings.demoData.remove',
  'settings.perf.generate',
  'settings.perf.benchmark',
  'data.archive.preview',
  'data.archive.run',
  'data.archive.restore',
  'data.archive.stats',
  'data.archive.vacuum',
  'settings.security.save',

  // ── finance (§C.6) ─────────────────────────────────────────────────────────
  'finance.coa.tree',
  'finance.coa.save',
  'finance.coa.archive',
  'finance.journals.codes',
  'finance.journals.list',
  'finance.journals.get',
  'finance.journals.save',
  'finance.journals.post',
  'finance.journals.reverse',
  'finance.journals.delete',
  'finance.invoices.list',
  'finance.invoices.save',
  'finance.invoices.get',
  'finance.invoices.post',
  'finance.invoices.void',
  'finance.invoices.duplicate',
  'finance.invoices.fromOrder',
  'finance.bills.list',
  'finance.bills.save',
  'finance.bills.get',
  'finance.bills.post',
  'finance.bills.match',
  'finance.bills.approveException',
  'finance.bills.void',
  'finance.payments.list',
  'finance.payments.create',
  'finance.payments.allocate',
  'finance.payments.get',
  /**
   * Totals for an unsaved document. A document editor must show the tax and the
   * line total *before* anything is written, and the arithmetic is not allowed
   * to leave `money.ts` — so the renderer asks the main process to compute it.
   */
  'finance.documents.compute',
  'finance.reports.trialBalance',
  'finance.reports.pnl',
  'finance.reports.balanceSheet',
  'finance.reports.cashFlow',
  'finance.reports.generalLedger',
  'finance.periods.list',
  'finance.periods.lock',
  'finance.periods.unlock',
  'finance.periods.close',

  // ── inventory (§C.7) ───────────────────────────────────────────────────────
  'inventory.stock.onHand',
  'inventory.stock.available',
  'inventory.moves.list',
  'inventory.moves.post',
  'inventory.moves.reverse',
  'inventory.valuation',
  'inventory.quants.rebuild',
  'inventory.lowStock',
  /*
   * T07 screens: the on-hand grid, a product's running-balance history, aging and
   * the grouped overview. Each is paged in SQL — a stock screen must never load a
   * whole ledger to draw 50 rows.
   */
  'inventory.quants.list',
  'inventory.moves.history',
  'inventory.aging',
  'inventory.stock.overview',
  'inventory.uom.list',
  'inventory.uom.save',

  // ── purchasing (§C.8) ──────────────────────────────────────────────────────
  'purchasing.po.confirm',
  'purchasing.po.cancel',
  'purchasing.po.outstanding',
  'purchasing.receipt.create',
  'purchasing.receipt.post',
  'purchasing.bill.fromReceipt',
  'purchasing.match.preview',
  /*
   * The declared catalogue had no way to create or read a purchase order: a PO is
   * not in the generic entity registry (it is a document with lines, not a record)
   * so it needs its own list/get/save. Without these the confirm channel had
   * nothing to confirm.
   */
  'purchasing.po.list',
  'purchasing.po.get',
  'purchasing.po.save',
  'purchasing.receipt.list',
  'purchasing.receipt.get',
  'purchasing.receipt.cancel',
  'purchasing.vendors.statement',
  'purchasing.analysis',

  // ── sales (§C.9) ───────────────────────────────────────────────────────────
  'sales.quote.send',
  'sales.quote.accept',
  'sales.quote.expire',
  'sales.quote.convert',
  'sales.order.confirm',
  'sales.order.cancel',
  'sales.order.availability',
  'sales.delivery.create',
  'sales.delivery.post',
  'sales.price.resolve',
  'sales.pricelist.items',
  'sales.pricelist.saveItems',
  /* Same reason as purchase orders: documents with lines need list/get/save. */
  'sales.quote.list',
  'sales.quote.get',
  'sales.quote.save',
  'sales.order.list',
  'sales.order.get',
  'sales.order.save',
  'sales.order.invoice',
  'sales.order.markInvoiced',
  'sales.delivery.list',
  'sales.delivery.get',
  'sales.customers.outstanding',
  'sales.pricelist.list',

  // ── crm (§C.10) ────────────────────────────────────────────────────────────
  'crm.lead.convert',
  'crm.lead.convertPreview',
  'crm.deal.moveStage',
  'crm.deal.closeWon',
  'crm.deal.closeLost',
  'crm.deal.board',
  'crm.deal.get',
  'crm.deal.fromWon',
  'crm.activity.save',
  'crm.activity.complete',
  'crm.timeline',
  'crm.pipelines.list',
  'crm.pipelines.save',
  'crm.stages.save',
  'crm.stages.reorder',
  'crm.lossReasons.list',
  'crm.lossReasons.save',
  'crm.analytics',

  // ── documents, data, dashboard, search (§C.11) ─────────────────────────────
  'documents.pdf.preview',
  'documents.pdf.save',
  'documents.print',
  'documents.export',
  'data.import.parse',
  'data.import.validate',
  'data.import.commit',
  'data.import.template',
  'data.import.pick',
  'dashboard.summary',
  'search.global',
  'search.palette',
  'search.recent.list',
  'search.recent.push',
  'search.recent.clear',
  'notifications.list',
  'notifications.markRead',

  // ── licence, audit, backup (§C.12) ─────────────────────────────────────────
  'license.status',
  'license.activate',
  'license.deactivate',
  'license.machineId',
  'audit.list',
  'audit.verify',
  'audit.diff',
  'backup.run',
  'backup.list',
  'backup.restore',
  'backup.verify',
  'backup.pickFolder',
  'app.openPath',
] as const;

export type Channel = (typeof CHANNELS)[number];

/** Frozen membership set — the preload allow-list. */
export const CHANNEL_SET: ReadonlySet<Channel> = new Set<Channel>(CHANNELS);

/** Marker for channels that need no session and no permission. */
export const PUBLIC = 'public' as const;

/**
 * `entity.*` channels derive their permission from the entity registry, so the
 * requirement is expressed as an operation rather than a literal permission.
 */
export type EntityOp = 'read' | 'write' | 'delete' | 'export';

export type ChannelRequirement = Permission | typeof PUBLIC | `entity.${EntityOp}`;

/**
 * Channels callable **before** login. Everything else requires a session
 * (`AUTH_REQUIRED`). The licence family is here because the onboarding wizard
 * activates a key before an administrator exists (ARCHITECTURE §C.1 step 2).
 */
export const NO_SESSION_CHANNELS: ReadonlySet<Channel> = new Set<Channel>([
  'app.bootstrap',
  'app.quit',
  'auth.login',
  'auth.unlock',
  'auth.session',
  'onboarding.status',
  'onboarding.preview',
  'onboarding.complete',
  // The first-run owner is created before onboarding can exist. `users.create`
  // refuses this path as soon as one user exists (see `services/users.ts`).
  'users.create',
  'license.status',
  'license.activate',
  'license.deactivate',
  'license.machineId',
]);

/** Every channel and the permission it needs. Exhaustive by type. */
export const CHANNEL_PERMISSIONS: Readonly<Record<Channel, ChannelRequirement>> = {
  'entity.list': 'entity.read',
  'entity.get': 'entity.read',
  'entity.save': 'entity.write',
  'entity.archive': 'entity.write',
  'entity.restore': 'entity.write',
  'entity.delete': 'entity.delete',
  'entity.export': 'entity.export',

  'app.bootstrap': PUBLIC,
  'app.prefs.save': 'app.prefs.write',
  'app.quit': PUBLIC,
  'auth.login': PUBLIC,
  'auth.unlock': PUBLIC,
  'auth.lock': 'app.session.use',
  'auth.logout': 'app.session.use',
  'auth.session': PUBLIC,
  'auth.password.change': 'app.session.use',
  'auth.heartbeat': 'app.session.use',
  'onboarding.status': PUBLIC,
  'onboarding.preview': PUBLIC,
  'onboarding.complete': PUBLIC,

  'users.create': 'settings.user.manage',
  'users.update': 'settings.user.manage',
  'users.setActive': 'settings.user.manage',
  'users.resetPassword': 'settings.user.manage',
  'roles.duplicate': 'settings.role.manage',
  'permissions.catalog': 'settings.role.read',

  'settings.get': 'settings.company.read',
  'settings.company.save': 'settings.company.write',
  'settings.company.logo': 'settings.company.write',
  'settings.numbering.list': 'settings.numbering.read',
  'settings.numbering.save': 'settings.numbering.manage',
  'settings.numbering.preview': 'settings.numbering.read',
  'settings.numbering.reset': 'settings.numbering.manage',
  'settings.currency.setBase': 'settings.currency.manage',
  'settings.presets.list': 'settings.company.read',
  'settings.presets.preview': 'settings.company.read',
  'settings.presets.apply': 'settings.preset.apply',
  'settings.demoData.seed': 'app.demo_data.manage',
  'settings.demoData.remove': 'app.demo_data.manage',
  // Owner-only: a performance dataset is a destructive fixture, not a feature.
  'settings.perf.generate': 'settings.backup.run',
  'settings.perf.benchmark': 'settings.backup.run',
  'data.archive.preview': 'settings.company.read',
  'data.archive.run': 'settings.backup.run',
  'data.archive.restore': 'settings.backup.restore',
  'data.archive.stats': 'settings.company.read',
  'data.archive.vacuum': 'settings.backup.run',
  'settings.security.save': 'settings.security.manage',

  'finance.coa.tree': 'finance.account.read',
  'finance.coa.save': 'finance.account.write',
  'finance.coa.archive': 'finance.account.delete',
  'finance.journals.codes': 'finance.journal.read',
  'finance.journals.list': 'finance.journal.read',
  'finance.journals.get': 'finance.journal.read',
  'finance.journals.save': 'finance.journal.write',
  'finance.journals.post': 'finance.journal.post',
  'finance.journals.reverse': 'finance.journal.reverse',
  'finance.journals.delete': 'finance.journal.write',
  'finance.invoices.list': 'finance.invoice.read',
  'finance.invoices.save': 'finance.invoice.create',
  'finance.invoices.get': 'finance.invoice.read',
  'finance.invoices.post': 'finance.invoice.post',
  'finance.invoices.void': 'finance.invoice.void',
  'finance.invoices.duplicate': 'finance.invoice.create',
  'finance.invoices.fromOrder': 'finance.invoice.create',
  'finance.bills.list': 'finance.bill.read',
  'finance.bills.save': 'finance.bill.create',
  'finance.bills.get': 'finance.bill.read',
  'finance.bills.post': 'finance.bill.post',
  'finance.bills.match': 'finance.bill.read',
  'finance.bills.approveException': 'purchasing.bill.approve_exception',
  'finance.bills.void': 'finance.bill.void',
  'finance.payments.list': 'finance.payment.read',
  'finance.payments.create': 'finance.payment.create',
  'finance.payments.allocate': 'finance.payment.create',
  'finance.payments.get': 'finance.payment.read',
  // Shared by the invoice and the bill editor; the invoice read permission is
  // the one every role that can see either document already holds.
  'finance.documents.compute': 'finance.invoice.read',
  'finance.reports.trialBalance': 'finance.report.read',
  'finance.reports.pnl': 'finance.report.read',
  'finance.reports.balanceSheet': 'finance.report.read',
  'finance.reports.cashFlow': 'finance.report.read',
  'finance.reports.generalLedger': 'finance.report.read',
  'finance.periods.list': 'finance.period.read',
  'finance.periods.lock': 'finance.period.lock',
  'finance.periods.unlock': 'finance.period.lock',
  'finance.periods.close': 'finance.period.read',

  'inventory.stock.onHand': 'inventory.stock.read',
  'inventory.stock.available': 'inventory.stock.read',
  'inventory.moves.list': 'inventory.stock.read',
  'inventory.moves.post': 'inventory.move.create',
  'inventory.moves.reverse': 'inventory.move.create',
  'inventory.valuation': 'inventory.stock.read',
  'inventory.quants.rebuild': 'inventory.stock.adjust',
  'inventory.lowStock': 'inventory.stock.read',
  'inventory.quants.list': 'inventory.stock.read',
  'inventory.moves.history': 'inventory.stock.read',
  'inventory.aging': 'inventory.stock.read',
  'inventory.stock.overview': 'inventory.stock.read',
  'inventory.uom.list': 'inventory.product.read',
  'inventory.uom.save': 'inventory.product.write',

  'purchasing.po.confirm': 'purchasing.po.confirm',
  'purchasing.po.cancel': 'purchasing.po.cancel',
  'purchasing.po.outstanding': 'purchasing.po.read',
  'purchasing.receipt.create': 'purchasing.receipt.create',
  'purchasing.receipt.post': 'purchasing.receipt.post',
  'purchasing.bill.fromReceipt': 'finance.bill.create',
  'purchasing.match.preview': 'finance.bill.read',
  'purchasing.po.list': 'purchasing.po.read',
  'purchasing.po.get': 'purchasing.po.read',
  'purchasing.po.save': 'purchasing.po.create',
  'purchasing.receipt.list': 'purchasing.receipt.read',
  'purchasing.receipt.get': 'purchasing.receipt.read',
  'purchasing.receipt.cancel': 'purchasing.receipt.post',
  'purchasing.vendors.statement': 'purchasing.vendor.read',
  'purchasing.analysis': 'purchasing.po.read',

  'sales.quote.send': 'sales.quotation.write',
  'sales.quote.accept': 'sales.quotation.write',
  'sales.quote.expire': 'sales.quotation.write',
  'sales.quote.convert': 'sales.quotation.convert',
  'sales.order.confirm': 'sales.order.write',
  'sales.order.cancel': 'sales.order.write',
  'sales.order.availability': 'sales.order.read',
  'sales.delivery.create': 'sales.delivery.create',
  'sales.delivery.post': 'sales.delivery.post',
  'sales.price.resolve': 'sales.pricelist.read',
  'sales.pricelist.items': 'sales.pricelist.read',
  'sales.pricelist.saveItems': 'sales.pricelist.manage',
  'sales.quote.list': 'sales.quotation.read',
  'sales.quote.get': 'sales.quotation.read',
  'sales.quote.save': 'sales.quotation.create',
  'sales.order.list': 'sales.order.read',
  'sales.order.get': 'sales.order.read',
  'sales.order.save': 'sales.order.create',
  'sales.order.invoice': 'sales.order.read',
  'sales.order.markInvoiced': 'finance.invoice.create',
  'sales.delivery.list': 'sales.order.read',
  'sales.delivery.get': 'sales.order.read',
  'sales.customers.outstanding': 'sales.customer.read',
  'sales.pricelist.list': 'sales.pricelist.read',

  'crm.lead.convert': 'crm.lead.convert',
  'crm.lead.convertPreview': 'crm.lead.read',
  'crm.deal.moveStage': 'crm.deal.write',
  'crm.deal.closeWon': 'crm.deal.write',
  'crm.deal.closeLost': 'crm.deal.write',
  'crm.deal.board': 'crm.deal.read',
  'crm.deal.get': 'crm.deal.read',
  'crm.deal.fromWon': 'sales.order.create',
  'crm.activity.save': 'crm.activity.write',
  'crm.activity.complete': 'crm.activity.write',
  'crm.timeline': 'crm.activity.read',
  'crm.pipelines.list': 'crm.pipeline.read',
  'crm.pipelines.save': 'crm.pipeline.manage',
  'crm.stages.save': 'crm.pipeline.manage',
  'crm.stages.reorder': 'crm.pipeline.manage',
  'crm.lossReasons.list': 'crm.deal.read',
  'crm.lossReasons.save': 'crm.pipeline.manage',
  'crm.analytics': 'crm.analytics.read',

  'documents.pdf.preview': 'documents.print',
  'documents.pdf.save': 'documents.print',
  'documents.print': 'documents.print',
  'documents.export': 'documents.export',
  'data.import.pick': 'data.import',
  'data.import.parse': 'data.import',
  'data.import.validate': 'data.import',
  'data.import.commit': 'data.import',
  'data.import.template': 'data.import',
  'dashboard.summary': 'dashboard.read',
  'search.global': 'search.read',
  'search.palette': 'search.read',
  'search.recent.list': 'search.read',
  'search.recent.push': 'search.read',
  'search.recent.clear': 'search.read',
  'notifications.list': 'app.session.use',
  'notifications.markRead': 'app.session.use',

  'license.status': 'settings.license.read',
  'license.activate': 'settings.license.manage',
  'license.deactivate': 'settings.license.manage',
  'license.machineId': 'settings.license.read',
  'audit.list': 'settings.audit.read',
  'audit.verify': 'settings.audit.read',
  'audit.diff': 'settings.audit.read',
  'backup.run': 'settings.backup.run',
  'backup.list': 'settings.backup.run',
  'backup.restore': 'settings.backup.restore',
  'backup.verify': 'settings.backup.run',
  'backup.pickFolder': 'settings.backup.run',
  'app.openPath': 'settings.backup.run',
};

/** Channels that change state and therefore run inside a transaction + audit. */
export const READ_ONLY_CHANNELS: ReadonlySet<Channel> = new Set<Channel>([
  'app.bootstrap',
  'app.quit',
  'auth.session',
  'auth.heartbeat',
  'onboarding.status',
  'onboarding.preview',
  'permissions.catalog',
  'entity.list',
  'entity.get',
  'entity.export',
  'settings.get',
  'settings.numbering.list',
  'settings.numbering.preview',
  'settings.presets.list',
  'settings.presets.preview',
  'data.archive.preview',
  'data.archive.stats',
  'finance.coa.tree',
  'finance.journals.codes',
  'finance.journals.list',
  'finance.journals.get',
  'finance.invoices.list',
  'finance.invoices.get',
  'finance.bills.list',
  'finance.bills.get',
  'finance.bills.match',
  'finance.payments.list',
  'finance.payments.get',
  'finance.documents.compute',
  'finance.reports.trialBalance',
  'finance.reports.pnl',
  'finance.reports.balanceSheet',
  'finance.reports.cashFlow',
  'finance.reports.generalLedger',
  'finance.periods.list',
  'finance.periods.close',
  'inventory.stock.onHand',
  'inventory.stock.available',
  'inventory.moves.list',
  'inventory.valuation',
  'inventory.lowStock',
  'inventory.quants.list',
  'inventory.moves.history',
  'inventory.aging',
  'inventory.stock.overview',
  'inventory.uom.list',
  'purchasing.po.outstanding',
  'purchasing.po.list',
  'purchasing.po.get',
  'purchasing.receipt.list',
  'purchasing.receipt.get',
  'purchasing.vendors.statement',
  'purchasing.analysis',
  'purchasing.match.preview',
  'sales.order.availability',
  'sales.price.resolve',
  'sales.pricelist.items',
  'sales.pricelist.list',
  'sales.quote.list',
  'sales.quote.get',
  'sales.order.list',
  'sales.order.get',
  'sales.order.invoice',
  'sales.delivery.list',
  'sales.delivery.get',
  'sales.customers.outstanding',
  'crm.deal.board',
  'crm.timeline',
  'crm.pipelines.list',
  'crm.lossReasons.list',
  'crm.analytics',
  'documents.pdf.preview',
  'documents.pdf.save',
  'documents.print',
  'documents.export',
  'data.import.pick',
  'data.import.parse',
  'data.import.validate',
  'dashboard.summary',
  'search.global',
  'search.palette',
  'notifications.list',
  'license.status',
  'license.machineId',
  'audit.list',
  'audit.verify',
  'audit.diff',
  'backup.list',
  'backup.verify',
  'backup.pickFolder',
  'search.recent.list',
  'crm.deal.get',
  'crm.lead.convertPreview',
]);

/**
 * Channels that manage their own transaction and append their own, richer audit
 * rows.
 *
 * Two different reasons put a channel here, and both mean the dispatcher's
 * automatic `BEGIN … COMMIT` would be wrong:
 *
 *  - a failure path that must still persist evidence (`login_failed` inside a
 *    rolled-back transaction would erase the brute-force trail);
 *  - a handler that cannot be synchronous — `backup.run` opens a second database
 *    to integrity-check the copy it is writing, and `backup.restore` closes and
 *    re-opens the live connection, which is impossible from inside a
 *    transaction on that same connection. The dispatcher refuses an async
 *    mutating handler outright, so a channel missing from this list does not
 *    fail slowly — it fails on the first click.
 */
export const SELF_AUDITING_CHANNELS: ReadonlySet<Channel> = new Set<Channel>([
  'auth.login',
  'auth.logout',
  'auth.lock',
  'auth.unlock',
  'auth.password.change',
  'users.create',
  'users.update',
  'users.setActive',
  'users.resetPassword',
  'license.activate',
  'license.deactivate',
  'backup.run',
  'backup.restore',
]);

/** Main → renderer event names the preload will forward. */
export const MAIN_EVENTS = ['app:lock', 'app:toast', 'job:progress'] as const;
export type MainEvent = (typeof MAIN_EVENTS)[number];

/** The single `ipcRenderer.invoke` message name. */
export const INVOKE_MESSAGE = 'nexus:invoke' as const;

/** Type guard for untrusted channel strings. */
export function isChannel(value: string): value is Channel {
  return CHANNEL_SET.has(value as Channel);
}

/** The requirement for a channel, or `PUBLIC` when unknown (never dispatched). */
export function requirementFor(channel: Channel): ChannelRequirement {
  return CHANNEL_PERMISSIONS[channel];
}
