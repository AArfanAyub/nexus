"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHART = void 0;
exports.firstPostable = firstPostable;
exports.accountFor = accountFor;
exports.payableFor = payableFor;
exports.isPostable = isPostable;
/**
 * Account resolution shared by every posting service (T05–T08).
 *
 * The preset chart deliberately contains **summary** accounts (`1000`, `1200`,
 * `2000`, `4000`, `5000`) that exist to group their children. `writeJournal`
 * refuses a summary account, so a fallback chain must prefer the leaf and use the
 * parent only as a last resort for a hand-edited chart — otherwise a company that
 * renamed `1201` to `1210` would discover the problem at posting time with a
 * message about the wrong thing.
 *
 * This module exists because the same twelve-line function had already been
 * written twice (`finance.documents`, `finance.payments`). A third and fourth copy
 * for inventory and purchasing would have meant four places to fix when the chart
 * changes, so it lives here instead and the two callers import it.
 */
const connection_1 = require("../db/connection");
const errors_1 = require("../errors");
/**
 * The chart codes the posting matrix (§B.4) refers to.
 *
 * §B.4 writes the *shorthand* — "Dr 1200 Inventory", "Cr 2100 GRNI",
 * "Dr 5000 COGS" — but in the preset chart those three are **parents** and
 * `writeJournal` refuses a parent. The real leaves are `1210`/`1250`,
 * `2110` and `5010`. So each slot lists the leaf first and the shorthand second,
 * and `firstPostable` skips anything that is not postable. That way §B.4 stays
 * readable as documentation and the code still lands on an account it can post to.
 */
exports.CHART = {
    bank: ['1020', '1010'],
    ar: ['1100'],
    inventory: ['1210', '1250', '1230', '1200'],
    inputTax: ['1300', '1310'],
    ap: ['2100', '2000'],
    grni: ['2110', '2100'],
    sales: ['4010', '4020', '4000'],
    cogs: ['5010', '5000'],
    priceVariance: ['5020', '5100', '5000'],
    stockAdjustment: ['5030', '5200', '5020', '5100', '5000'],
    expense: ['6010', '6000'],
};
/**
 * First **postable** account among `codes`.
 *
 * Exported because inventory, purchasing and sales all need the same behaviour,
 * and because the acceptance tests assert which account a journal landed on.
 */
function firstPostable(codes, label) {
    for (const code of codes) {
        const row = (0, connection_1.conn)().one('SELECT id, is_postable FROM accounts WHERE code = ? AND deleted_at IS NULL AND is_archived = 0', [code]);
        if (row && Number(row.is_postable) === 1)
            return row.id;
    }
    throw (0, errors_1.conflict)(`${label} account is missing from the chart of accounts (looked for ${codes.join(', ')}). ` +
        'Restore it in Settings → Chart of accounts before posting.');
}
/** Resolves a chart slot from `CHART`. Thin sugar so call sites read as English. */
function accountFor(slot, label) {
    return firstPostable(exports.CHART[slot], label);
}
/**
 * A partner's own account if it has one, otherwise the chart slot.
 *
 * A vendor may carry `payable_account_id` and a customer may not — the payable
 * override is a real requirement (US-32), the receivable one is not, so this
 * deliberately only looks at the vendor column.
 */
function payableFor(vendorId) {
    const row = (0, connection_1.conn)().one('SELECT payable_account_id FROM vendors WHERE id = ?', [vendorId]);
    if (row?.payable_account_id)
        return row.payable_account_id;
    return accountFor('ap', 'Accounts payable');
}
/** True when the account exists, is postable and is not archived. */
function isPostable(accountId) {
    const row = (0, connection_1.conn)().one('SELECT is_postable, is_archived, deleted_at FROM accounts WHERE id = ?', [accountId]);
    return Boolean(row) && Number(row?.is_postable) === 1 && Number(row?.is_archived) === 0 && !row?.deleted_at;
}
//# sourceMappingURL=accounts.js.map