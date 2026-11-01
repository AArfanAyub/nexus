"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.baseCurrency = baseCurrency;
exports.assertPeriodOpen = assertPeriodOpen;
exports.writeJournal = writeJournal;
exports.getJournalEntry = getJournalEntry;
exports.listJournalEntries = listJournalEntries;
exports.saveJournal = saveJournal;
exports.postEntry = postEntry;
exports.deleteDraft = deleteDraft;
exports.reverseEntry = reverseEntry;
exports.coaTree = coaTree;
exports.saveAccount = saveAccount;
exports.archiveAccount = archiveAccount;
exports.listPeriods = listPeriods;
exports.lockPeriod = lockPeriod;
exports.unlockPeriod = unlockPeriod;
exports.closeChecklist = closeChecklist;
exports.listJournals = listJournals;
exports.journalCodes = journalCodes;
exports.ledgerControlTotals = ledgerControlTotals;
/**
 * The double-entry engine (T05, ARCHITECTURE §B.4).
 *
 * `writeJournal` is the **only** function in the codebase that inserts into
 * `journal_entries` / `journal_lines`. Invoices, bills, payments, goods
 * receipts, deliveries and stock adjustments all funnel through it, which is why
 * BR-01 (balanced or reject) and BR-04 (no posting into a locked period) cannot
 * be bypassed by adding a new document type later.
 *
 * Gate order is deliberate and must not be reordered:
 *   1. period open        → CONFLICT naming the lock date and the locking user
 *   2. line shape         → exactly one of debit/credit, both non-negative
 *   3. Σ debit === Σ credit → `Out of balance by X.XX`, **zero rows written**
 *   4. account resolvable, postable, currency-compatible
 *   5. number allocated from `number_sequences` inside the same transaction
 *
 * Everything runs inside the caller's transaction (`conn().tx` nests as a
 * passthrough), so a throw at gate 5 rolls back gates 1–4 with it.
 *
 * Reports live in `finance.reports.ts`, AR/AP documents in
 * `finance.documents.ts`, payments in `finance.payments.ts`. This file owns the
 * ledger, the chart of accounts and the period locks, and re-exports the rest so
 * callers only ever import `services/finance`.
 */
const node_crypto_1 = require("node:crypto");
const dates_1 = require("../../shared/dates");
const money_1 = require("../../shared/money");
const connection_1 = require("../db/connection");
const errors_1 = require("../errors");
const cache_1 = require("./cache");
const settings_1 = require("./settings");
/** The journal codes the preset guarantees (§B.2). */
const JOURNAL_CODES = ['GEN', 'SAL', 'PUR', 'BNK', 'CSH', 'STK'];
/** The company base currency. Posting is refused before onboarding creates one. */
function baseCurrency() {
    const company = (0, settings_1.getCompany)();
    if (!company)
        throw (0, errors_1.conflict)('Finish setting up the company before posting anything.');
    return company.baseCurrency;
}
function periodCovering(date) {
    const row = (0, connection_1.conn)().one('SELECT * FROM periods WHERE start_date <= ? AND end_date >= ? ORDER BY start_date LIMIT 1', [date, date]);
    if (row)
        return row;
    // A date outside every fiscal year is legal — create the year on demand rather
    // than refusing to record a real transaction.
    const year = (0, settings_1.fiscalYearFor)(date);
    const created = (0, connection_1.conn)().one('SELECT * FROM periods WHERE fiscal_year_id = ? AND start_date <= ? AND end_date >= ? LIMIT 1', [year.id, date, date]);
    if (!created)
        throw (0, errors_1.validation)('date', `No accounting period covers ${date}.`);
    return created;
}
/**
 * Gate 1. Exported because the acceptance tests and T07/T08 call it directly.
 * Names the lock date and the locking user — a message that says only "locked"
 * sends the operator hunting through the settings screens.
 */
function assertPeriodOpen(date) {
    const period = periodCovering(date);
    if (period.status === 'locked') {
        const locker = period.locked_by
            ? (0, connection_1.conn)().one('SELECT full_name FROM users WHERE id = ?', [period.locked_by])
            : undefined;
        const when = period.locked_at ? period.locked_at.slice(0, 10) : 'an unknown date';
        /**
         * A user row may have been deleted since the lock. Falling back to the stored
         * id is better than "an administrator": the operator can then take that id to
         * the audit log and find out who it was.
         */
        const who = locker?.full_name ?? (period.locked_by ? `user ${period.locked_by}` : 'an administrator');
        throw (0, errors_1.conflict)(`The period ${period.name} (${period.start_date} to ${period.end_date}) is locked: locked on ${when} by ${who}. ` +
            'Post to a different date or ask an administrator to unlock the period.');
    }
    return { id: period.id, name: period.name };
}
function journalByCode(code) {
    const normalised = code.trim().toUpperCase();
    const row = (0, connection_1.conn)().one('SELECT id, code FROM journals WHERE code = ? AND is_active = 1', [normalised]);
    if (!row) {
        throw (0, errors_1.validation)('journalCode', `There is no active journal with the code ${normalised}.`);
    }
    return row;
}
function accountRow(selector) {
    const row = selector.accountId
        ? (0, connection_1.conn)().one('SELECT id, code, name, type, is_postable, is_archived, currency FROM accounts WHERE id = ?', [
            selector.accountId,
        ])
        : (0, connection_1.conn)().one('SELECT id, code, name, type, is_postable, is_archived, currency FROM accounts WHERE code = ?', [
            selector.accountCode ?? '',
        ]);
    if (!row) {
        const label = selector.accountCode ?? selector.accountId ?? '(blank)';
        throw (0, errors_1.validation)('lines.account', `There is no account with the code ${label}.`);
    }
    if (Number(row.is_archived) === 1) {
        throw (0, errors_1.validation)('lines.account', `Account ${row.code} ${row.name} is archived and cannot be posted to.`);
    }
    if (Number(row.is_postable) === 0) {
        throw (0, errors_1.validation)('lines.account', `Account ${row.code} ${row.name} is a summary account. Post to one of its children instead.`);
    }
    return row;
}
/** Gate 2 + 3 + 4, in that order, for one line. */
function resolveLines(input) {
    if (input.length < 2)
        throw (0, errors_1.validation)('lines', 'A journal entry needs at least two lines.');
    if (input.length > 500)
        throw (0, errors_1.validation)('lines', 'Split this into several entries of 500 lines or fewer.');
    const base = baseCurrency();
    const resolved = [];
    for (const [index, line] of input.entries()) {
        const debitRaw = line.debitCents ?? 0;
        const creditRaw = line.creditCents ?? 0;
        if (!Number.isInteger(debitRaw) || !Number.isInteger(creditRaw)) {
            throw (0, errors_1.validation)(`lines.${String(index)}`, 'Amounts must be whole minor units.');
        }
        if (debitRaw < 0 || creditRaw < 0) {
            throw (0, errors_1.validation)(`lines.${String(index)}`, 'Amounts cannot be negative — swap the debit and credit instead.');
        }
        const hasDebit = debitRaw > 0;
        const hasCredit = creditRaw > 0;
        if (hasDebit === hasCredit) {
            throw (0, errors_1.validation)(`lines.${String(index)}`, 'Each line is either a debit or a credit, and the amount must be greater than zero.');
        }
        const account = accountRow(line);
        const currency = line.currency ?? base;
        if (account.currency && account.currency !== currency) {
            throw (0, errors_1.validation)(`lines.${String(index)}`, `Account ${account.code} only accepts ${account.currency}, but this line is in ${currency}.`);
        }
        // Convert to base cents. A same-currency line is exact; a foreign line needs
        // an explicit rate so nothing is silently assumed to be 1:1.
        let debit = (0, money_1.cents)(debitRaw);
        let credit = (0, money_1.cents)(creditRaw);
        if (currency !== base) {
            const rateBp = line.rateBp;
            if (!rateBp || !Number.isInteger(rateBp) || rateBp <= 0) {
                throw (0, errors_1.validation)(`lines.${String(index)}`, `A ${currency} line needs a positive exchange rate against ${base}.`);
            }
            debit = (0, money_1.cents)((0, money_1.roundHalfUp)(debit * rateBp, 4));
            credit = (0, money_1.cents)((0, money_1.roundHalfUp)(credit * rateBp, 4));
        }
        resolved.push({
            accountId: account.id,
            debit,
            credit,
            description: line.description?.trim() || null,
            partnerType: line.partnerType ?? null,
            partnerId: line.partnerId ?? null,
            taxId: line.taxId ?? null,
        });
    }
    const debit = (0, money_1.sumCents)(resolved.map((line) => line.debit));
    const credit = (0, money_1.sumCents)(resolved.map((line) => line.credit));
    return { lines: resolved, debit, credit };
}
function toSummary(row) {
    return {
        id: String(row['id']),
        number: row['number'] === null ? null : String(row['number']),
        date: String(row['date']),
        journalId: String(row['journal_id']),
        journalCode: String(row['journal_code'] ?? ''),
        journalName: String(row['journal_name'] ?? ''),
        memo: row['memo'] === null ? null : String(row['memo']),
        status: String(row['status']),
        sourceType: row['source_type'] === null ? null : String(row['source_type']),
        sourceId: row['source_id'] === null ? null : String(row['source_id']),
        reversesId: row['reverses_id'] === null ? null : String(row['reverses_id']),
        postedAt: row['posted_at'] === null ? null : String(row['posted_at']),
        postedBy: row['posted_by'] === null ? null : String(row['posted_by']),
        totalCents: Number(row['total_cents'] ?? 0),
    };
}
const ENTRY_SELECT = `
  SELECT e.*, j.code AS journal_code, j.name AS journal_name,
         (SELECT COALESCE(SUM(l.debit_cents), 0) FROM journal_lines l WHERE l.entry_id = e.id) AS total_cents
    FROM journal_entries e JOIN journals j ON j.id = e.journal_id`;
/**
 * The engine. Writes one entry and its lines, or writes nothing at all.
 *
 * `isReversalOf` mirrors nothing by itself — `reverseEntry` builds the mirrored
 * lines and passes the original id here so the link is created in one place.
 */
function writeJournal(scope, input) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
        throw (0, errors_1.validation)('date', 'Pick a valid date.');
    }
    // Gate 1 — before anything is read or written.
    const period = assertPeriodOpen(input.date);
    // Gates 2–4.
    const journal = journalByCode(input.journalCode);
    const { lines, debit, credit } = resolveLines(input.lines);
    // Gate 3, explicit message: the operator must see the difference, not a code.
    if (debit !== credit) {
        const difference = (0, money_1.cents)(Math.abs(debit - credit));
        throw (0, errors_1.conflict)(`Out of balance by ${(0, money_1.formatAmount)(difference)}.`);
    }
    const status = input.status === 'draft' ? 'draft' : 'posted';
    const id = (0, node_crypto_1.randomUUID)();
    const at = (0, dates_1.nowIso)();
    // Gate 5 — a draft carries no number, so deleting one never burns a number
    // (BR-08). Posting allocates inside this same transaction.
    let number = null;
    if (status === 'posted') {
        const year = (0, settings_1.fiscalYearFor)(input.date);
        number = (0, settings_1.nextNumber)('journal', year.id);
    }
    (0, connection_1.conn)().run(`INSERT INTO journal_entries (id, number, journal_id, date, period_id, memo, status, source_type, source_id,
       reverses_id, posted_at, posted_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        number,
        journal.id,
        input.date,
        period.id,
        input.memo?.trim() || null,
        status,
        input.sourceType,
        input.sourceId ?? null,
        input.reversesId ?? null,
        status === 'posted' ? at : null,
        status === 'posted' ? scope.actorId : null,
        at,
        at,
    ]);
    for (const [index, line] of lines.entries()) {
        (0, connection_1.conn)().run(`INSERT INTO journal_lines (id, entry_id, line_no, account_id, debit_cents, credit_cents,
         description, partner_type, partner_id, tax_id, posted_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            (0, node_crypto_1.randomUUID)(),
            id,
            index + 1,
            line.accountId,
            line.debit,
            line.credit,
            line.description,
            line.partnerType,
            line.partnerId,
            line.taxId,
            // NULL for a draft, so a dated report never has to look at the parent to
            // learn the entry's status (v6, see migrate.v6.ts).
            status === 'posted' ? input.date : null,
        ]);
    }
    // Every report that reads the ledger is now stale. One prefix, one call — the
    // cache cannot drift from the ledger because posting is the only writer.
    (0, cache_1.invalidateCache)('report:');
    return getJournalEntry(id);
}
/** One entry with its lines and account names. */
function getJournalEntry(id) {
    const row = (0, connection_1.conn)().one(`${ENTRY_SELECT} WHERE e.id = ?`, [id]);
    if (!row)
        throw (0, errors_1.notFound)('Journal entry');
    const lines = (0, connection_1.conn)().all(`SELECT l.*, a.code AS account_code, a.name AS account_name
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id = ? ORDER BY l.line_no`, [id]);
    const mapped = lines.map((line) => ({
        id: String(line['id']),
        lineNo: Number(line['line_no']),
        accountId: String(line['account_id']),
        accountCode: String(line['account_code']),
        accountName: String(line['account_name']),
        debitCents: Number(line['debit_cents']),
        creditCents: Number(line['credit_cents']),
        description: line['description'] === null ? null : String(line['description']),
        partnerType: line['partner_type'] === null ? null : String(line['partner_type']),
        partnerId: line['partner_id'] === null ? null : String(line['partner_id']),
        taxId: line['tax_id'] === null ? null : String(line['tax_id']),
    }));
    return { ...toSummary(row), lines: mapped };
}
/** The journal browser. Aggregates in SQL; only the page is materialised. */
function listJournalEntries(filter = {}) {
    const where = [];
    const params = [];
    if (filter.from) {
        where.push('e.date >= ?');
        params.push(filter.from);
    }
    if (filter.to) {
        where.push('e.date <= ?');
        params.push(filter.to);
    }
    if (filter.journalId) {
        where.push('e.journal_id = ?');
        params.push(filter.journalId);
    }
    if (filter.sourceType) {
        where.push('e.source_type = ?');
        params.push(filter.sourceType);
    }
    if (filter.status) {
        where.push('e.status = ?');
        params.push(filter.status);
    }
    if (typeof filter.q === 'string' && filter.q.trim().length > 0) {
        where.push('(e.memo LIKE ? OR e.number LIKE ? OR e.source_id LIKE ?)');
        const like = `%${filter.q.trim()}%`;
        params.push(like, like, like);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const pageSize = Math.min(Math.max(Math.trunc(filter.pageSize ?? 50), 1), 500);
    const page = Math.max(Math.trunc(filter.page ?? 1), 1);
    const offset = (page - 1) * pageSize;
    // The amount filters act on the entry total, which is an aggregate — so the
    // statement is wrapped and filtered outside, keeping LIMIT/OFFSET correct.
    const amountWhere = [];
    const amountParams = [];
    if (typeof filter.minCents === 'number') {
        amountWhere.push('total_cents >= ?');
        amountParams.push(filter.minCents);
    }
    if (typeof filter.maxCents === 'number') {
        amountWhere.push('total_cents <= ?');
        amountParams.push(filter.maxCents);
    }
    const outer = amountWhere.length > 0 ? `WHERE ${amountWhere.join(' AND ')}` : '';
    const rows = (0, connection_1.conn)().all(`SELECT * FROM (${ENTRY_SELECT} ${clause}) AS t
      ${outer}
      ORDER BY t.date DESC, t.created_at DESC
      LIMIT ? OFFSET ?`, [...params, ...amountParams, pageSize, offset]);
    const countRow = (0, connection_1.conn)().one(`SELECT COUNT(*) AS total FROM (${ENTRY_SELECT} ${clause}) AS t ${outer}`, [...params, ...amountParams]);
    return { rows: rows.map(toSummary), total: Number(countRow?.total ?? 0) };
}
/** A manual journal from the UI: draft or posted, through the same gates. */
function saveJournal(input, scope) {
    if (input.id) {
        const existing = (0, connection_1.conn)().one('SELECT status FROM journal_entries WHERE id = ?', [input.id]);
        if (!existing)
            throw (0, errors_1.notFound)('Journal entry');
        if (String(existing.status) !== 'draft') {
            throw (0, errors_1.conflict)('Posted entries are read-only. Reverse the entry instead of editing it.');
        }
        (0, connection_1.conn)().run('DELETE FROM journal_lines WHERE entry_id = ?', [input.id]);
        (0, connection_1.conn)().run('DELETE FROM journal_entries WHERE id = ?', [input.id]);
    }
    return writeJournal(scope, input);
}
/** Promotes a draft. Re-runs every gate, because the period may have locked since. */
function postEntry(entryId, scope) {
    const row = (0, connection_1.conn)().one('SELECT status, date FROM journal_entries WHERE id = ?', [entryId]);
    if (!row)
        throw (0, errors_1.notFound)('Journal entry');
    if (String(row.status) !== 'draft')
        throw (0, errors_1.conflict)('That entry has already been posted.');
    assertPeriodOpen(String(row.date));
    const balance = (0, connection_1.conn)().one('SELECT COALESCE(SUM(debit_cents),0) AS debit, COALESCE(SUM(credit_cents),0) AS credit FROM journal_lines WHERE entry_id = ?', [entryId]);
    if (Number(balance?.debit ?? 0) !== Number(balance?.credit ?? 0)) {
        const difference = Math.abs(Number(balance?.debit ?? 0) - Number(balance?.credit ?? 0));
        throw (0, errors_1.conflict)(`Out of balance by ${(0, money_1.formatAmount)((0, money_1.cents)(difference))}.`);
    }
    const year = (0, settings_1.fiscalYearFor)(String(row.date));
    const number = (0, settings_1.nextNumber)('journal', year.id);
    const at = (0, dates_1.nowIso)();
    (0, connection_1.conn)().run("UPDATE journal_entries SET status = 'posted', number = ?, posted_at = ?, posted_by = ?, updated_at = ? WHERE id = ?", [number, at, scope.actorId, at, entryId]);
    // The lines carry the posting date (v6). Drafting wrote NULL, so this is the
    // only transition that has to keep the copy honest — and it does so in the
    // same transaction as the status change.
    (0, connection_1.conn)().run('UPDATE journal_lines SET posted_date = ? WHERE entry_id = ?', [String(row.date), entryId]);
    return getJournalEntry(entryId);
}
/** Discards a draft. Never touches a posted entry, so no number is ever lost. */
function deleteDraft(entryId) {
    const row = (0, connection_1.conn)().one('SELECT status FROM journal_entries WHERE id = ?', [entryId]);
    if (!row)
        throw (0, errors_1.notFound)('Journal entry');
    if (String(row.status) !== 'draft') {
        throw (0, errors_1.conflict)('Only drafts can be deleted. Reverse a posted entry to cancel it.');
    }
    (0, connection_1.conn)().run('DELETE FROM journal_lines WHERE entry_id = ?', [entryId]);
    (0, connection_1.conn)().run('DELETE FROM journal_entries WHERE id = ?', [entryId]);
    return { id: entryId };
}
/**
 * Reverses a posted entry by writing its mirror image (BR-03).
 *
 * The original is never touched — not even its status — so a printed copy stays
 * truthful. Reversing twice produces two distinct entries, each linked to the
 * original, which is what T05 acceptance #3 asserts.
 *
 * The reversal posts to the **original date**; if that period is locked it posts
 * to today instead, because a locked period must never make a correction
 * impossible. The memo records which date was used and why.
 */
function reverseEntry(entryId, reason, scope) {
    if (reason.trim().length < 3) {
        throw (0, errors_1.validation)('reason', 'Say why the entry is being reversed — it goes on the reversal.');
    }
    const original = getJournalEntry(entryId);
    if (original.status === 'draft') {
        throw (0, errors_1.conflict)('A draft has nothing to reverse. Delete it instead.');
    }
    if (original.reversesId) {
        throw (0, errors_1.conflict)(`${original.number ?? 'That entry'} is itself a reversal. Reverse the entry it mirrors, or post a correcting entry.`);
    }
    /**
     * Idempotence guard: one reversal per entry, ever. Without this, a double click
     * silently doubles the correction and the trial balance still balances — the
     * worst kind of wrong, because nothing looks broken.
     */
    const existing = (0, connection_1.conn)().one('SELECT number FROM journal_entries WHERE reverses_id = ? LIMIT 1', [original.id]);
    if (existing) {
        throw (0, errors_1.conflict)(`${original.number ?? 'That entry'} has already been reversed by ${existing.number ?? 'another entry'}.`);
    }
    let date = original.date;
    let note = '';
    const period = (0, connection_1.conn)().one('SELECT status FROM periods WHERE start_date <= ? AND end_date >= ? LIMIT 1', [date, date]);
    if (period && String(period.status) === 'locked') {
        date = (0, dates_1.todayIso)();
        note = ' (posted today because the original period is locked)';
    }
    const lines = original.lines.map((line) => ({
        accountId: line.accountId,
        debitCents: line.creditCents,
        creditCents: line.debitCents,
        description: line.description,
        partnerType: line.partnerType === 'customer' || line.partnerType === 'vendor' ? line.partnerType : null,
        partnerId: line.partnerId,
        taxId: line.taxId,
    }));
    return writeJournal(scope, {
        date,
        journalCode: original.journalCode,
        memo: `Reversal of ${original.number ?? 'draft'}: ${reason.trim()}${note}`,
        lines,
        sourceType: original.sourceType ?? 'reversal',
        sourceId: original.sourceId,
        reversesId: original.id,
    });
}
// ── chart of accounts ────────────────────────────────────────────────────────
const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];
/** Credit-normal types report a positive balance when credited. */
function isCreditNormal(type) {
    return type === 'liability' || type === 'equity' || type === 'income';
}
/**
 * The whole chart, flat, with computed balances (BR-05: a parent is a summary,
 * never a posting target, and its balance is the sum of its subtree).
 */
function coaTree(options = {}) {
    const rows = (0, connection_1.conn)().all(`SELECT a.id, a.code, a.name, a.type, a.parent_id, a.is_postable, a.is_archived, a.currency, a.description,
            (SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)
               FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
              WHERE l.account_id = a.id AND e.status = 'posted') AS own,
            (SELECT COUNT(*)
               FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
              WHERE l.account_id = a.id AND e.status = 'posted') AS postings
       FROM accounts a
      WHERE a.deleted_at IS NULL ${options.includeArchived ? '' : 'AND a.is_archived = 0'}
      ORDER BY a.code`);
    const byId = new Map();
    const children = new Map();
    for (const row of rows) {
        const own = Number(row.own);
        byId.set(row.id, {
            id: row.id,
            code: row.code,
            name: row.name,
            type: row.type,
            parentId: row.parent_id,
            isPostable: Number(row.is_postable) === 1,
            isArchived: Number(row.is_archived) === 1,
            currency: row.currency,
            description: row.description,
            depth: 0,
            hasChildren: false,
            balanceCents: isCreditNormal(row.type) ? -own : own,
            ownBalanceCents: isCreditNormal(row.type) ? -own : own,
            postingCount: Number(row.postings),
        });
        if (row.parent_id) {
            const list = children.get(row.parent_id) ?? [];
            list.push(row.id);
            children.set(row.parent_id, list);
        }
    }
    // Roll subtree balances up, then walk down again to stamp depth.
    const rolled = new Map();
    const rollUp = (id) => {
        const cached = rolled.get(id);
        if (cached !== undefined)
            return cached;
        let total = byId.get(id)?.balanceCents ?? 0;
        for (const childId of children.get(id) ?? [])
            total += rollUp(childId);
        rolled.set(id, total);
        return total;
    };
    for (const id of byId.keys())
        rollUp(id);
    const stampDepth = (id, depth) => {
        const node = byId.get(id);
        if (!node)
            return;
        const kids = children.get(id) ?? [];
        byId.set(id, {
            ...node,
            depth,
            hasChildren: kids.length > 0,
            balanceCents: rolled.get(id) ?? node.balanceCents,
        });
        for (const childId of kids)
            stampDepth(childId, depth + 1);
    };
    for (const [id, node] of byId) {
        if (!node.parentId || !byId.has(node.parentId))
            stampDepth(id, 0);
    }
    return [...byId.values()].sort((a, b) => a.code.localeCompare(b.code));
}
function descendantsOf(id) {
    const result = new Set();
    const queue = [id];
    while (queue.length > 0) {
        const current = queue.pop();
        if (!current)
            break;
        for (const row of (0, connection_1.conn)().all('SELECT id FROM accounts WHERE parent_id = ?', [current])) {
            if (result.has(row.id))
                continue;
            result.add(row.id);
            queue.push(row.id);
        }
    }
    return result;
}
function postingCountFor(accountId) {
    const row = (0, connection_1.conn)().one('SELECT COUNT(*) AS total FROM journal_lines WHERE account_id = ?', [
        accountId,
    ]);
    return Number(row?.total ?? 0);
}
/** Creates or edits an account. Keeps the tree a tree and the types consistent. */
function saveAccount(input) {
    const code = input.code.trim();
    const name = input.name.trim();
    if (!/^[0-9A-Z][0-9A-Z.-]{1,15}$/.test(code)) {
        throw (0, errors_1.validation)('code', 'Use 2–16 characters: digits, capitals, a dot or a dash (for example 1200 or AR-01).');
    }
    if (name.length < 2)
        throw (0, errors_1.validation)('name', 'Give the account a name.');
    if (!ACCOUNT_TYPES.includes(input.type))
        throw (0, errors_1.validation)('type', 'Pick an account type.');
    const parentId = input.parentId ?? null;
    if (parentId) {
        const parent = (0, connection_1.conn)().one('SELECT id, type, is_postable, is_archived FROM accounts WHERE id = ?', [parentId]);
        if (!parent)
            throw (0, errors_1.notFound)('Parent account');
        if (Number(parent.is_archived) === 1)
            throw (0, errors_1.conflict)('That parent account is archived.');
        if (parent.type !== input.type) {
            throw (0, errors_1.validation)('type', 'A child account must have the same type as its parent.');
        }
        if (input.id && (input.id === parentId || descendantsOf(input.id).has(parentId))) {
            throw (0, errors_1.validation)('parentId', 'An account cannot be its own parent or sit under its own child.');
        }
    }
    const clash = (0, connection_1.conn)().one('SELECT id FROM accounts WHERE code = ? AND id <> ?', [
        code,
        input.id ?? '',
    ]);
    if (clash)
        throw (0, errors_1.conflict)(`Account code ${code} is already in use.`);
    const at = (0, dates_1.nowIso)();
    let id = input.id ?? '';
    if (id) {
        const existing = (0, connection_1.conn)().one('SELECT is_postable FROM accounts WHERE id = ?', [id]);
        if (!existing)
            throw (0, errors_1.notFound)('Account');
        (0, connection_1.conn)().run(`UPDATE accounts SET code = ?, name = ?, type = ?, parent_id = ?, currency = ?, description = ?, updated_at = ?
        WHERE id = ?`, [code, name, input.type, parentId, input.currency ?? null, input.description ?? null, at, id]);
    }
    else {
        id = (0, node_crypto_1.randomUUID)();
        (0, connection_1.conn)().run(`INSERT INTO accounts (id, code, name, type, parent_id, is_postable, currency, is_archived, description,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`, [id, code, name, input.type, parentId, input.isPostable === false ? 0 : 1, input.currency ?? null, input.description ?? null, at, at]);
    }
    // A parent with children is a summary. Flip it, unless it already carries
    // postings — then the chart is wrong and the operator has to fix it first.
    if (parentId) {
        const postings = postingCountFor(parentId);
        if (postings > 0) {
            throw (0, errors_1.conflict)('That parent account already has postings, so it cannot become a summary account. Pick another parent or move the postings first.');
        }
        (0, connection_1.conn)().run('UPDATE accounts SET is_postable = 0, updated_at = ? WHERE id = ?', [at, parentId]);
    }
    if (input.isPostable === false) {
        (0, connection_1.conn)().run('UPDATE accounts SET is_postable = 0, updated_at = ? WHERE id = ?', [at, id]);
    }
    const node = coaTree({ includeArchived: true }).find((candidate) => candidate.id === id);
    if (!node)
        throw (0, errors_1.notFound)('Account');
    return node;
}
/** Archives an account. Refuses when postings or children would be orphaned. */
function archiveAccount(id, reason) {
    if (reason.trim().length < 3)
        throw (0, errors_1.validation)('reason', 'Say why the account is being archived.');
    const row = (0, connection_1.conn)().one('SELECT code, name FROM accounts WHERE id = ?', [id]);
    if (!row)
        throw (0, errors_1.notFound)('Account');
    const postings = postingCountFor(id);
    if (postings > 0) {
        throw (0, errors_1.conflict)(`Account ${row.code} ${row.name} has ${String(postings)} posted line(s), so it cannot be archived. ` +
            'Archive is only for accounts that were never used.');
    }
    const children = (0, connection_1.conn)().one('SELECT COUNT(*) AS total FROM accounts WHERE parent_id = ? AND deleted_at IS NULL', [id]);
    if (Number(children?.total ?? 0) > 0) {
        throw (0, errors_1.conflict)(`Account ${row.code} still has child accounts. Move or archive them first.`);
    }
    const at = (0, dates_1.nowIso)();
    (0, connection_1.conn)().run('UPDATE accounts SET is_archived = 1, deleted_at = ?, updated_at = ? WHERE id = ?', [at, at, id]);
    return { id };
}
// ── periods ──────────────────────────────────────────────────────────────────
function listPeriods() {
    const rows = (0, connection_1.conn)().all(`SELECT p.id, p.fiscal_year_id, f.name AS fiscal_year_name, p.name, p.start_date, p.end_date, p.status,
            p.locked_at, p.locked_by, u.full_name AS locked_by_name,
            (SELECT COUNT(*) FROM journal_entries e WHERE e.period_id = p.id) AS entry_count,
            (SELECT COUNT(*) FROM journal_entries e WHERE e.period_id = p.id AND e.status = 'draft') AS draft_count
       FROM periods p
       JOIN fiscal_years f ON f.id = p.fiscal_year_id
       LEFT JOIN users u ON u.id = p.locked_by
      ORDER BY p.start_date DESC`);
    return rows.map((row) => ({
        id: row.id,
        fiscalYearId: row.fiscal_year_id,
        fiscalYearName: row.fiscal_year_name,
        name: row.name,
        startDate: row.start_date,
        endDate: row.end_date,
        status: row.status,
        lockedAt: row.locked_at,
        lockedBy: row.locked_by,
        lockedByName: row.locked_by_name,
        entryCount: Number(row.entry_count),
        draftCount: Number(row.draft_count),
    }));
}
function lockPeriod(periodId, reason, scope) {
    if (reason.trim().length < 3)
        throw (0, errors_1.validation)('reason', 'Say why the period is being locked.');
    const row = (0, connection_1.conn)().one('SELECT status, name FROM periods WHERE id = ?', [periodId]);
    if (!row)
        throw (0, errors_1.notFound)('Period');
    if (String(row.status) === 'locked')
        throw (0, errors_1.conflict)(`${row.name} is already locked.`);
    const drafts = (0, connection_1.conn)().one("SELECT COUNT(*) AS total FROM journal_entries WHERE period_id = ? AND status = 'draft'", [periodId]);
    if (Number(drafts?.total ?? 0) > 0) {
        throw (0, errors_1.conflict)(`${row.name} still has ${String(drafts?.total ?? 0)} draft entr(y/ies). Post or delete them before locking.`);
    }
    const at = (0, dates_1.nowIso)();
    (0, connection_1.conn)().run("UPDATE periods SET status = 'locked', locked_at = ?, locked_by = ?, unlocked_at = NULL, unlocked_by = NULL WHERE id = ?", [at, scope.actorId, periodId]);
    return requirePeriod(periodId);
}
function unlockPeriod(periodId, reason, scope) {
    if (reason.trim().length < 3)
        throw (0, errors_1.validation)('reason', 'A reason is required to unlock a period.');
    const row = (0, connection_1.conn)().one('SELECT status, name FROM periods WHERE id = ?', [periodId]);
    if (!row)
        throw (0, errors_1.notFound)('Period');
    if (String(row.status) !== 'locked')
        throw (0, errors_1.conflict)(`${row.name} is not locked.`);
    const at = (0, dates_1.nowIso)();
    (0, connection_1.conn)().run("UPDATE periods SET status = 'open', unlocked_at = ?, unlocked_by = ?, locked_at = NULL, locked_by = NULL WHERE id = ?", [at, scope.actorId, periodId]);
    return requirePeriod(periodId);
}
function requirePeriod(periodId) {
    const found = listPeriods().find((period) => period.id === periodId);
    if (!found)
        throw (0, errors_1.notFound)('Period');
    return found;
}
/** The month-end checklist: what still stands between this year and a close. */
function closeChecklist(fiscalYearId) {
    const year = (0, connection_1.conn)().one('SELECT name, start_date, end_date FROM fiscal_years WHERE id = ?', [fiscalYearId]);
    if (!year)
        throw (0, errors_1.notFound)('Fiscal year');
    const drafts = (0, connection_1.conn)().one(`SELECT COUNT(*) AS total FROM journal_entries e JOIN periods p ON p.id = e.period_id
      WHERE p.fiscal_year_id = ? AND e.status = 'draft'`, [fiscalYearId]);
    const openInvoices = (0, connection_1.conn)().one(`SELECT COUNT(*) AS total, COALESCE(SUM(total_cents - paid_cents), 0) AS amount FROM invoices
      WHERE status IN ('posted', 'partially_paid')`);
    const openBills = (0, connection_1.conn)().one(`SELECT COUNT(*) AS total, COALESCE(SUM(total_cents - paid_cents), 0) AS amount FROM bills
      WHERE status IN ('posted', 'partially_paid')`);
    const unposted = (0, connection_1.conn)().one("SELECT COUNT(*) AS total FROM invoices WHERE status = 'draft'");
    const locked = (0, connection_1.conn)().one("SELECT COUNT(*) AS total FROM periods WHERE fiscal_year_id = ? AND status = 'locked'", [fiscalYearId]);
    const periods = (0, connection_1.conn)().one('SELECT COUNT(*) AS total FROM periods WHERE fiscal_year_id = ?', [fiscalYearId]);
    const empty = (0, connection_1.conn)().one(`SELECT COUNT(*) AS total FROM accounts a
      WHERE a.is_postable = 1 AND a.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.account_id = a.id)`);
    return [
        {
            id: 'drafts',
            label: 'No draft entries left in the year',
            ok: Number(drafts?.total ?? 0) === 0,
            detail: `${String(drafts?.total ?? 0)} draft entr(y/ies)`,
        },
        {
            id: 'invoices',
            label: 'Every invoice is posted or void',
            ok: Number(unposted?.total ?? 0) === 0,
            detail: `${String(unposted?.total ?? 0)} draft invoice(s)`,
        },
        {
            id: 'receivables',
            label: 'Receivables reviewed',
            ok: true,
            detail: `${String(openInvoices?.total ?? 0)} open invoice(s), ${(0, money_1.formatCents)((0, money_1.cents)(Number(openInvoices?.amount ?? 0)), baseCurrency())} outstanding`,
        },
        {
            id: 'payables',
            label: 'Payables reviewed',
            ok: true,
            detail: `${String(openBills?.total ?? 0)} open bill(s), ${(0, money_1.formatCents)((0, money_1.cents)(Number(openBills?.amount ?? 0)), baseCurrency())} outstanding`,
        },
        {
            id: 'periods',
            label: 'Every period in the year is locked',
            ok: Number(locked?.total ?? 0) === Number(periods?.total ?? 0) && Number(periods?.total ?? 0) > 0,
            detail: `${String(locked?.total ?? 0)} of ${String(periods?.total ?? 0)} periods locked`,
        },
        {
            id: 'unused',
            label: 'Chart of accounts is tidy',
            ok: Number(empty?.total ?? 0) === 0,
            detail: `${String(empty?.total ?? 0)} postable account(s) never used`,
        },
    ];
}
/** Journal codes, for the browser filter. */
function listJournals() {
    return (0, connection_1.conn)().all('SELECT id, code, name, type FROM journals WHERE is_active = 1 ORDER BY code');
}
/** Every journal code the preset creates — used by the tests and by T07/T08. */
function journalCodes() {
    return JOURNAL_CODES;
}
/** Total posted debit for a date range — the cheapest possible integrity probe. */
function ledgerControlTotals(from, to) {
    const row = (0, connection_1.conn)().one(`SELECT COALESCE(SUM(l.debit_cents), 0) AS debit, COALESCE(SUM(l.credit_cents), 0) AS credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.status = 'posted' AND e.date BETWEEN ? AND ?`, [from, to]);
    return { debitCents: Number(row?.debit ?? 0), creditCents: Number(row?.credit ?? 0) };
}
//# sourceMappingURL=finance.engine.js.map