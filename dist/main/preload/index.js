"use strict";
const electron = require("electron");
const CHANNELS = [
  // ── generic entity family (§C.2) ───────────────────────────────────────────
  "entity.list",
  "entity.get",
  "entity.save",
  "entity.archive",
  "entity.restore",
  "entity.delete",
  "entity.export",
  // ── app, session, auth, onboarding (§C.3) ──────────────────────────────────
  "app.bootstrap",
  "app.prefs.save",
  "app.quit",
  "auth.login",
  "auth.unlock",
  "auth.lock",
  "auth.logout",
  "auth.session",
  "auth.password.change",
  "auth.heartbeat",
  "onboarding.status",
  "onboarding.preview",
  "onboarding.complete",
  // ── users, roles, permissions (§C.4) ───────────────────────────────────────
  "users.create",
  "users.update",
  "users.setActive",
  "users.resetPassword",
  "roles.duplicate",
  "permissions.catalog",
  // ── settings (§C.5) ────────────────────────────────────────────────────────
  "settings.get",
  "settings.company.save",
  "settings.company.logo",
  "settings.numbering.list",
  "settings.numbering.save",
  "settings.numbering.preview",
  "settings.numbering.reset",
  "settings.currency.setBase",
  "settings.presets.list",
  "settings.presets.preview",
  "settings.presets.apply",
  "settings.demoData.seed",
  "settings.demoData.remove",
  "settings.perf.generate",
  "settings.perf.benchmark",
  "data.archive.preview",
  "data.archive.run",
  "data.archive.restore",
  "data.archive.stats",
  "data.archive.vacuum",
  "settings.security.save",
  // ── finance (§C.6) ─────────────────────────────────────────────────────────
  "finance.coa.tree",
  "finance.coa.save",
  "finance.coa.archive",
  "finance.journals.codes",
  "finance.journals.list",
  "finance.journals.get",
  "finance.journals.save",
  "finance.journals.post",
  "finance.journals.reverse",
  "finance.journals.delete",
  "finance.invoices.list",
  "finance.invoices.save",
  "finance.invoices.get",
  "finance.invoices.post",
  "finance.invoices.void",
  "finance.invoices.duplicate",
  "finance.invoices.fromOrder",
  "finance.bills.list",
  "finance.bills.save",
  "finance.bills.get",
  "finance.bills.post",
  "finance.bills.match",
  "finance.bills.approveException",
  "finance.bills.void",
  "finance.payments.list",
  "finance.payments.create",
  "finance.payments.allocate",
  "finance.payments.get",
  /**
   * Totals for an unsaved document. A document editor must show the tax and the
   * line total *before* anything is written, and the arithmetic is not allowed
   * to leave `money.ts` — so the renderer asks the main process to compute it.
   */
  "finance.documents.compute",
  "finance.reports.trialBalance",
  "finance.reports.pnl",
  "finance.reports.balanceSheet",
  "finance.reports.cashFlow",
  "finance.reports.generalLedger",
  "finance.periods.list",
  "finance.periods.lock",
  "finance.periods.unlock",
  "finance.periods.close",
  // ── inventory (§C.7) ───────────────────────────────────────────────────────
  "inventory.stock.onHand",
  "inventory.stock.available",
  "inventory.moves.list",
  "inventory.moves.post",
  "inventory.moves.reverse",
  "inventory.valuation",
  "inventory.quants.rebuild",
  "inventory.lowStock",
  /*
   * T07 screens: the on-hand grid, a product's running-balance history, aging and
   * the grouped overview. Each is paged in SQL — a stock screen must never load a
   * whole ledger to draw 50 rows.
   */
  "inventory.quants.list",
  "inventory.moves.history",
  "inventory.aging",
  "inventory.stock.overview",
  "inventory.uom.list",
  "inventory.uom.save",
  // ── purchasing (§C.8) ──────────────────────────────────────────────────────
  "purchasing.po.confirm",
  "purchasing.po.cancel",
  "purchasing.po.outstanding",
  "purchasing.receipt.create",
  "purchasing.receipt.post",
  "purchasing.bill.fromReceipt",
  "purchasing.match.preview",
  /*
   * The declared catalogue had no way to create or read a purchase order: a PO is
   * not in the generic entity registry (it is a document with lines, not a record)
   * so it needs its own list/get/save. Without these the confirm channel had
   * nothing to confirm.
   */
  "purchasing.po.list",
  "purchasing.po.get",
  "purchasing.po.save",
  "purchasing.receipt.list",
  "purchasing.receipt.get",
  "purchasing.receipt.cancel",
  "purchasing.vendors.statement",
  "purchasing.analysis",
  // ── sales (§C.9) ───────────────────────────────────────────────────────────
  "sales.quote.send",
  "sales.quote.accept",
  "sales.quote.expire",
  "sales.quote.convert",
  "sales.order.confirm",
  "sales.order.cancel",
  "sales.order.availability",
  "sales.delivery.create",
  "sales.delivery.post",
  "sales.price.resolve",
  "sales.pricelist.items",
  "sales.pricelist.saveItems",
  /* Same reason as purchase orders: documents with lines need list/get/save. */
  "sales.quote.list",
  "sales.quote.get",
  "sales.quote.save",
  "sales.order.list",
  "sales.order.get",
  "sales.order.save",
  "sales.order.invoice",
  "sales.order.markInvoiced",
  "sales.delivery.list",
  "sales.delivery.get",
  "sales.customers.outstanding",
  "sales.pricelist.list",
  // ── crm (§C.10) ────────────────────────────────────────────────────────────
  "crm.lead.convert",
  "crm.lead.convertPreview",
  "crm.deal.moveStage",
  "crm.deal.closeWon",
  "crm.deal.closeLost",
  "crm.deal.board",
  "crm.deal.get",
  "crm.deal.fromWon",
  "crm.activity.save",
  "crm.activity.complete",
  "crm.timeline",
  "crm.pipelines.list",
  "crm.pipelines.save",
  "crm.stages.save",
  "crm.stages.reorder",
  "crm.lossReasons.list",
  "crm.lossReasons.save",
  "crm.analytics",
  // ── documents, data, dashboard, search (§C.11) ─────────────────────────────
  "documents.pdf.preview",
  "documents.pdf.save",
  "documents.print",
  "documents.export",
  "data.import.parse",
  "data.import.validate",
  "data.import.commit",
  "data.import.template",
  "data.import.pick",
  "dashboard.summary",
  "search.global",
  "search.palette",
  "search.recent.list",
  "search.recent.push",
  "search.recent.clear",
  "notifications.list",
  "notifications.markRead",
  // ── licence, audit, backup (§C.12) ─────────────────────────────────────────
  "license.status",
  "license.activate",
  "license.deactivate",
  "license.machineId",
  "audit.list",
  "audit.verify",
  "audit.diff",
  "backup.run",
  "backup.list",
  "backup.restore",
  "backup.verify",
  "backup.pickFolder",
  "app.openPath"
];
new Set(CHANNELS);
const MAIN_EVENTS = ["app:lock", "app:toast", "job:progress"];
const INVOKE_MESSAGE = "nexus:invoke";
const ALLOWED = new Set(CHANNELS);
const EVENTS = new Set(MAIN_EVENTS);
const api = {
  /**
   * Invokes a main-process channel. Rejects locally for a channel outside the
   * allow-list so a compromised renderer cannot even probe the main process.
   */
  invoke: (channel, payload = {}) => {
    if (typeof channel !== "string" || !ALLOWED.has(channel)) {
      return Promise.reject(new Error(`Blocked IPC channel: ${String(channel)}`));
    }
    return electron.ipcRenderer.invoke(INVOKE_MESSAGE, { channel, payload });
  },
  /** Subscribes to a main → renderer event. Returns an unsubscribe function. */
  on: (event, listener) => {
    if (!EVENTS.has(event)) throw new Error(`Blocked event: ${String(event)}`);
    const wrapped = (_event, payload) => {
      listener(payload);
    };
    electron.ipcRenderer.on(event, wrapped);
    return () => {
      electron.ipcRenderer.removeListener(event, wrapped);
    };
  },
  platform: process.platform,
  /** Electron runtime version; the app version arrives in `app.bootstrap`. */
  version: process.versions.electron ?? "0.0.0"
};
electron.contextBridge.exposeInMainWorld("nexus", api);
