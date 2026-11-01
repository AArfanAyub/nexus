"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCHEMAS = exports.v = void 0;
exports.validatePayload = validatePayload;
/**
 * Hand-written payload validators. No `zod`, no dependency, no code
 * generation — 200 lines that cannot break on an upgrade.
 *
 * These validate SHAPE ONLY. Business rules belong in the service layer
 * (CONVENTIONS §6: "validate in ipc.ts (shape) and in the service (business)").
 */
const dates_1 = require("./dates");
const types_1 = require("./types");
const pass = (value) => ({ ok: true, value });
const fail = (path, message) => ({
    ok: false,
    issues: [{ path, message }],
});
function isPlainObject(input) {
    return typeof input === 'object' && input !== null && !Array.isArray(input);
}
function describe(input) {
    if (input === null)
        return 'null';
    if (Array.isArray(input))
        return 'a list';
    return `a ${typeof input}`;
}
function stringValidator(options = {}) {
    const { min = 0, max = 4096, pattern, trim = true, allowEmpty = true } = options;
    return {
        validate: (input, path = '') => {
            if (typeof input !== 'string')
                return fail(path, `Expected text but received ${describe(input)}`);
            const value = trim ? input.trim() : input;
            if (!allowEmpty && value.length === 0)
                return fail(path, 'This field is required');
            if (value.length < min)
                return fail(path, `Must be at least ${String(min)} characters`);
            if (value.length > max)
                return fail(path, `Must be at most ${String(max)} characters`);
            if (pattern && !pattern.test(value))
                return fail(path, 'Contains characters that are not allowed here');
            return pass(value);
        },
    };
}
function intValidator(options = {}) {
    const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
    return {
        validate: (input, path = '') => {
            if (typeof input !== 'number' || !Number.isInteger(input)) {
                return fail(path, `Expected a whole number but received ${describe(input)}`);
            }
            if (input < min)
                return fail(path, `Must be ${String(min)} or more`);
            if (input > max)
                return fail(path, `Must be ${String(max)} or less`);
            return pass(input);
        },
    };
}
function numberValidator(options = {}) {
    const { min = -Number.MAX_VALUE, max = Number.MAX_VALUE } = options;
    return {
        validate: (input, path = '') => {
            if (typeof input !== 'number' || !Number.isFinite(input)) {
                return fail(path, `Expected a number but received ${describe(input)}`);
            }
            if (input < min)
                return fail(path, `Must be ${String(min)} or more`);
            if (input > max)
                return fail(path, `Must be ${String(max)} or less`);
            return pass(input);
        },
    };
}
function enumValidator(values) {
    return {
        validate: (input, path = '') => {
            if (typeof input !== 'string' || !values.includes(input)) {
                return fail(path, `Must be one of: ${values.join(', ')}`);
            }
            return pass(input);
        },
    };
}
function booleanValidator() {
    return {
        validate: (input, path = '') => typeof input === 'boolean' ? pass(input) : fail(path, `Expected true or false but received ${describe(input)}`),
    };
}
function arrayValidator(item, options = {}) {
    const { min = 0, max = 5000 } = options;
    return {
        validate: (input, path = '') => {
            if (!Array.isArray(input))
                return fail(path, `Expected a list but received ${describe(input)}`);
            if (input.length < min)
                return fail(path, `Must contain at least ${String(min)} item(s)`);
            if (input.length > max)
                return fail(path, `Must contain at most ${String(max)} item(s)`);
            const values = [];
            const issues = [];
            input.forEach((entry, index) => {
                const result = item.validate(entry, `${path}[${String(index)}]`);
                if (result.ok)
                    values.push(result.value);
                else
                    issues.push(...result.issues);
            });
            if (issues.length > 0)
                return { ok: false, issues };
            return pass(values);
        },
    };
}
function objectValidator(shape) {
    return {
        validate: (input, path = '') => {
            if (!isPlainObject(input))
                return fail(path, `Expected an object but received ${describe(input)}`);
            const output = {};
            const issues = [];
            for (const key of Object.keys(shape)) {
                const validator = shape[key];
                if (!validator)
                    continue;
                const childPath = path === '' ? key : `${path}.${key}`;
                const result = validator.validate(input[key], childPath);
                if (result.ok) {
                    if (result.value !== undefined)
                        output[key] = result.value;
                }
                else {
                    issues.push(...result.issues);
                }
            }
            if (issues.length > 0)
                return { ok: false, issues };
            return pass(output);
        },
    };
}
function optional(inner) {
    return {
        validate: (input, path = '') => (input === undefined ? pass(undefined) : inner.validate(input, path)),
    };
}
/** Accepts `undefined`, `null` or a valid value — the shape of an optional FK. */
function nullable(inner) {
    return {
        validate: (input, path = '') => input === undefined || input === null ? pass(input) : inner.validate(input, path),
    };
}
function anything() {
    return { validate: (input) => pass(input) };
}
/** The validator vocabulary. Every payload below is built from exactly these. */
exports.v = {
    string: stringValidator,
    /** Non-empty trimmed text — the common case for a name. */
    text: (max = 200) => stringValidator({ min: 1, max, allowEmpty: false }),
    uuid: () => stringValidator({
        min: 36,
        max: 36,
        pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    }),
    int: intValidator,
    /** Integer minor units. May be negative (a credit, a variance). */
    cents: () => intValidator({ min: -999_999_999_999, max: 999_999_999_999 }),
    /** Integer milli-units of quantity. */
    milli: () => intValidator({ min: -999_999_999_999, max: 999_999_999_999 }),
    /** Basis points, 0..100000 (0%..1000%). */
    bp: () => intValidator({ min: -100_000, max: 100_000 }),
    number: numberValidator,
    boolean: booleanValidator,
    /** `YYYY-MM-DD`. */
    date: () => ({
        validate: (input, path = '') => typeof input === 'string' && (0, dates_1.isValidDate)(input)
            ? pass(input)
            : fail(path, 'Expected a date in YYYY-MM-DD form'),
    }),
    /** Full ISO-8601 UTC timestamp. */
    timestamp: () => ({
        validate: (input, path = '') => typeof input === 'string' && (0, dates_1.isValidTimestamp)(input)
            ? pass(input)
            : fail(path, 'Expected a UTC timestamp'),
    }),
    enum: enumValidator,
    array: arrayValidator,
    object: objectValidator,
    optional,
    nullable,
    anything,
    /** Free-form JSON object (custom field values, filter maps). */
    record: () => ({
        validate: (input, path = '') => {
            if (input === undefined)
                return pass({});
            if (!isPlainObject(input))
                return fail(path, `Expected an object but received ${describe(input)}`);
            return pass(input);
        },
    }),
};
// ── per-channel payloads ─────────────────────────────────────────────────────
const emptyObject = {
    validate: (input, path = '') => input === undefined || isPlainObject(input)
        ? pass({})
        : fail(path, `Expected an object but received ${describe(input)}`),
};
const loginPayload = exports.v.object({
    username: exports.v.string({ min: 1, max: 64, allowEmpty: false }),
    password: exports.v.string({ min: 1, max: 200, allowEmpty: false, trim: false }),
});
const prefsPayload = exports.v.object({
    theme: exports.v.optional(exports.v.enum(['light', 'dark'])),
    density: exports.v.optional(exports.v.enum(['compact', 'comfortable'])),
    accent: exports.v.optional(exports.v.enum(['blue', 'teal', 'violet', 'amber'])),
    sidebarCollapsed: exports.v.optional(exports.v.boolean()),
    locale: exports.v.optional(exports.v.string({ min: 2, max: 16 })),
    licenseNoticeDismissed: exports.v.optional(exports.v.boolean()),
});
const passwordChangePayload = exports.v.object({
    currentPassword: exports.v.string({ min: 1, max: 200, allowEmpty: false, trim: false }),
    newPassword: exports.v.string({ min: 8, max: 200, allowEmpty: false, trim: false }),
});
const userCreatePayload = exports.v.object({
    username: exports.v.string({ min: 3, max: 64, pattern: /^[a-zA-Z0-9._-]+$/ }),
    fullName: exports.v.string({ min: 1, max: 120, allowEmpty: false }),
    email: exports.v.optional(exports.v.string({ max: 160, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ })),
    password: exports.v.string({ min: 8, max: 200, allowEmpty: false, trim: false }),
    roleIds: exports.v.array(exports.v.uuid(), { min: 1, max: 20 }),
});
const userUpdatePayload = exports.v.object({
    id: exports.v.uuid(),
    fullName: exports.v.optional(exports.v.string({ min: 1, max: 120, allowEmpty: false })),
    email: exports.v.optional(exports.v.string({ max: 160, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ })),
    roleIds: exports.v.optional(exports.v.array(exports.v.uuid(), { max: 20 })),
    prefs: exports.v.optional(exports.v.record()),
});
const userSetActivePayload = exports.v.object({
    id: exports.v.uuid(),
    active: exports.v.boolean(),
    reason: exports.v.optional(exports.v.string({ max: 200 })),
});
const userResetPasswordPayload = exports.v.object({
    id: exports.v.uuid(),
    newPassword: exports.v.string({ min: 8, max: 200, allowEmpty: false, trim: false }),
    mustChange: exports.v.boolean(),
});
const roleDuplicatePayload = exports.v.object({
    id: exports.v.uuid(),
    name: exports.v.string({ min: 2, max: 60, allowEmpty: false }),
});
const auditListPayload = exports.v.object({
    actorId: exports.v.optional(exports.v.uuid()),
    entity: exports.v.optional(exports.v.string({ max: 60 })),
    entityId: exports.v.optional(exports.v.string({ max: 64 })),
    action: exports.v.optional(exports.v.string({ max: 60 })),
    from: exports.v.optional(exports.v.timestamp()),
    to: exports.v.optional(exports.v.timestamp()),
    limit: exports.v.optional(exports.v.int({ min: 1, max: 500 })),
    offset: exports.v.optional(exports.v.int({ min: 0, max: 1_000_000 })),
});
const licenseActivatePayload = exports.v.object({
    // Short on purpose: the owner's perpetual code is `arfanayub0`, and a signed
    // customer key is far longer. The verifier decides what is acceptable.
    key: exports.v.string({ min: 6, max: 4096, allowEmpty: false }),
});
const licenseDeactivatePayload = exports.v.object({
    reason: exports.v.optional(exports.v.string({ max: 200 })),
});
const settingsGetPayload = exports.v.object({
    keys: exports.v.optional(exports.v.array(exports.v.string({ min: 1, max: 80 }), { max: 200 })),
});
const heartbeatPayload = exports.v.object({ at: exports.v.timestamp() });
// ── T03/T04: entity family, onboarding, settings ─────────────────────────────
const entityListPayload = exports.v.object({
    entity: exports.v.string({ min: 2, max: 40 }),
    q: exports.v.optional(exports.v.string({ max: 200 })),
    filters: exports.v.optional(exports.v.anything()),
    sort: exports.v.optional(exports.v.anything()),
    // R1: a list never materialises more than MAX_PAGE_SIZE rows at a time.
    limit: exports.v.optional(exports.v.int({ min: 1, max: types_1.MAX_PAGE_SIZE })),
    offset: exports.v.optional(exports.v.int({ min: 0, max: 10_000_000 })),
    viewId: exports.v.optional(exports.v.uuid()),
});
const entityGetPayload = exports.v.object({
    entity: exports.v.string({ min: 2, max: 40 }),
    id: exports.v.string({ min: 1, max: 64, allowEmpty: false }),
});
const entitySavePayload = exports.v.object({
    entity: exports.v.string({ min: 2, max: 40 }),
    id: exports.v.optional(exports.v.string({ min: 1, max: 64 })),
    values: exports.v.record(),
    custom: exports.v.optional(exports.v.record()),
});
const entityArchivePayload = exports.v.object({
    entity: exports.v.string({ min: 2, max: 40 }),
    id: exports.v.string({ min: 1, max: 64, allowEmpty: false }),
    reason: exports.v.optional(exports.v.string({ max: 200 })),
});
const entityExportPayload = exports.v.object({
    entity: exports.v.string({ min: 2, max: 40 }),
    format: exports.v.enum(['csv', 'xlsx']),
    filters: exports.v.optional(exports.v.anything()),
    sort: exports.v.optional(exports.v.anything()),
    columns: exports.v.optional(exports.v.array(exports.v.string({ min: 1, max: 60 }), { max: 100 })),
});
const onboardingPreviewPayload = exports.v.object({
    presetId: exports.v.string({ min: 2, max: 40 }),
});
const onboardingCompletePayload = exports.v.object({
    company: exports.v.object({
        name: exports.v.string({ min: 2, max: 120, allowEmpty: false }),
        legalName: exports.v.optional(exports.v.string({ max: 160 })),
        taxId: exports.v.optional(exports.v.string({ max: 40 })),
        address: exports.v.optional(exports.v.anything()),
    }),
    presetId: exports.v.string({ min: 2, max: 40 }),
    currency: exports.v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
    fiscalStartMonth: exports.v.int({ min: 1, max: 12 }),
    admin: exports.v.object({
        username: exports.v.string({ min: 3, max: 64, pattern: /^[a-zA-Z0-9._-]+$/ }),
        fullName: exports.v.string({ min: 1, max: 120, allowEmpty: false }),
        email: exports.v.optional(exports.v.string({ max: 160 })),
        password: exports.v.string({ min: 8, max: 200, allowEmpty: false, trim: false }),
    }),
    licenseKey: exports.v.optional(exports.v.string({ max: 4096 })),
    loadDemo: exports.v.optional(exports.v.boolean()),
});
const companySavePayload = exports.v.object({
    name: exports.v.optional(exports.v.string({ min: 2, max: 120, allowEmpty: false })),
    legalName: exports.v.optional(exports.v.string({ max: 160 })),
    taxId: exports.v.optional(exports.v.string({ max: 40 })),
    address: exports.v.optional(exports.v.anything()),
    dateFormat: exports.v.optional(exports.v.string({ min: 4, max: 20 })),
    numberFormat: exports.v.optional(exports.v.string({ min: 4, max: 20 })),
});
const logoPayload = exports.v.object({
    dataUrl: exports.v.string({ min: 32, max: 400_000, allowEmpty: false, trim: false }),
});
const numberingSavePayload = exports.v.object({
    docType: exports.v.string({ min: 2, max: 32, pattern: /^[a-z][a-z0-9_]+$/ }),
    prefix: exports.v.string({ max: 12 }),
    padding: exports.v.int({ min: 1, max: 8 }),
    suffix: exports.v.optional(exports.v.string({ max: 12 })),
});
const numberingDocPayload = exports.v.object({
    docType: exports.v.string({ min: 2, max: 32, pattern: /^[a-z][a-z0-9_]+$/ }),
});
const numberingResetPayload = exports.v.object({
    docType: exports.v.string({ min: 2, max: 32, pattern: /^[a-z][a-z0-9_]+$/ }),
    reason: exports.v.string({ min: 3, max: 200, allowEmpty: false }),
});
const currencyBasePayload = exports.v.object({
    code: exports.v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
});
const presetApplyPayload = exports.v.object({
    presetId: exports.v.string({ min: 2, max: 40 }),
    confirm: exports.v.boolean(),
});
const securitySavePayload = exports.v.object({
    idleTimeoutMin: exports.v.optional(exports.v.int({ min: 1, max: 240 })),
    minPasswordLength: exports.v.optional(exports.v.int({ min: 8, max: 64 })),
    requireSymbol: exports.v.optional(exports.v.boolean()),
    maxAttempts: exports.v.optional(exports.v.int({ min: 3, max: 20 })),
    lockoutMin: exports.v.optional(exports.v.int({ min: 1, max: 1440 })),
});
const notificationsListPayload = exports.v.object({
    unreadOnly: exports.v.optional(exports.v.boolean()),
    limit: exports.v.optional(exports.v.int({ min: 1, max: 200 })),
});
const notificationsMarkReadPayload = exports.v.object({
    ids: exports.v.optional(exports.v.array(exports.v.string({ min: 1, max: 64 }), { max: 200 })),
    all: exports.v.optional(exports.v.boolean()),
});
// ── finance (T05/T06) ───────────────────────────────────────────────────────
const idPayload = exports.v.object({ id: exports.v.uuid() });
const idReasonPayload = exports.v.object({
    id: exports.v.uuid(),
    reason: exports.v.string({ min: 3, max: 400, allowEmpty: false }),
});
const coaSavePayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    code: exports.v.string({ min: 2, max: 16, pattern: /^[0-9A-Z][0-9A-Z.-]+$/, allowEmpty: false }),
    name: exports.v.string({ min: 2, max: 120, allowEmpty: false }),
    type: exports.v.enum(['asset', 'liability', 'equity', 'income', 'expense']),
    parentId: exports.v.nullable(exports.v.uuid()),
    isPostable: exports.v.optional(exports.v.boolean()),
    currency: exports.v.nullable(exports.v.string({ min: 3, max: 3 })),
    description: exports.v.nullable(exports.v.string({ max: 400 })),
});
const journalLinePayload = exports.v.object({
    accountId: exports.v.optional(exports.v.uuid()),
    accountCode: exports.v.optional(exports.v.string({ min: 2, max: 16 })),
    debitCents: exports.v.optional(exports.v.cents()),
    creditCents: exports.v.optional(exports.v.cents()),
    description: exports.v.nullable(exports.v.string({ max: 400 })),
    currency: exports.v.optional(exports.v.string({ min: 3, max: 3 })),
    rateBp: exports.v.optional(exports.v.int({ min: 1, max: 100_000_000 })),
    partnerType: exports.v.nullable(exports.v.enum(['customer', 'vendor'])),
    partnerId: exports.v.nullable(exports.v.uuid()),
    taxId: exports.v.nullable(exports.v.uuid()),
});
const journalSavePayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    date: exports.v.date(),
    journalCode: exports.v.string({ min: 2, max: 8, allowEmpty: false }),
    memo: exports.v.nullable(exports.v.string({ max: 400 })),
    lines: exports.v.array(journalLinePayload, { min: 2, max: 500 }),
    sourceType: exports.v.string({ min: 2, max: 40, allowEmpty: false }),
    sourceId: exports.v.nullable(exports.v.string({ max: 64 })),
    status: exports.v.optional(exports.v.enum(['draft', 'posted'])),
});
const journalFilterPayload = exports.v.object({
    from: exports.v.optional(exports.v.date()),
    to: exports.v.optional(exports.v.date()),
    journalId: exports.v.optional(exports.v.uuid()),
    sourceType: exports.v.optional(exports.v.string({ max: 40 })),
    status: exports.v.optional(exports.v.enum(['draft', 'posted', 'reversed'])),
    minCents: exports.v.optional(exports.v.cents()),
    maxCents: exports.v.optional(exports.v.cents()),
    q: exports.v.optional(exports.v.string({ max: 120 })),
    page: exports.v.optional(exports.v.int({ min: 1, max: 10_000 })),
    pageSize: exports.v.optional(exports.v.int({ min: 1, max: 200 })),
});
const documentLineShape = {
    productId: exports.v.nullable(exports.v.uuid()),
    description: exports.v.string({ min: 1, max: 400, allowEmpty: false }),
    qtyMilli: exports.v.milli(),
    unitPriceCents: exports.v.cents(),
    discountBp: exports.v.optional(exports.v.bp()),
    taxId: exports.v.nullable(exports.v.uuid()),
    accountId: exports.v.nullable(exports.v.uuid()),
};
const documentLinePayload = exports.v.object(documentLineShape);
/*
 * A bill line carries two extra columns that only exist for the three-way
 * match: the price the purchase order agreed and the quantity the receipt
 * actually delivered. `objectValidator` copies declared keys only, so leaving
 * them off this schema silently stripped them and the match compared nothing
 * against nothing — every bill "passed" and the accrual was never cleared.
 */
const billLinePayload = exports.v.object({
    ...documentLineShape,
    poPriceCents: exports.v.optional(exports.v.cents()),
    receivedQtyMilli: exports.v.optional(exports.v.milli()),
});
const invoiceSavePayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    customerId: exports.v.uuid(),
    date: exports.v.date(),
    dueDate: exports.v.date(),
    currency: exports.v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
    notes: exports.v.nullable(exports.v.string({ max: 2000 })),
    terms: exports.v.nullable(exports.v.string({ max: 2000 })),
    lines: exports.v.array(documentLinePayload, { min: 1, max: 200 }),
    sourceType: exports.v.nullable(exports.v.string({ max: 40 })),
    sourceId: exports.v.nullable(exports.v.string({ max: 64 })),
});
const billSavePayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    vendorId: exports.v.uuid(),
    vendorRef: exports.v.nullable(exports.v.string({ max: 120 })),
    date: exports.v.date(),
    dueDate: exports.v.date(),
    currency: exports.v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
    notes: exports.v.nullable(exports.v.string({ max: 2000 })),
    lines: exports.v.array(billLinePayload, { min: 1, max: 200 }),
    poId: exports.v.nullable(exports.v.uuid()),
    receiptIds: exports.v.optional(exports.v.array(exports.v.uuid(), { max: 50 })),
});
const paymentCreatePayload = exports.v.object({
    direction: exports.v.enum(['in', 'out']),
    partnerType: exports.v.enum(['customer', 'vendor']),
    partnerId: exports.v.uuid(),
    date: exports.v.date(),
    method: exports.v.enum(['bank', 'cash', 'card', 'cheque', 'transfer', 'other']),
    reference: exports.v.nullable(exports.v.string({ max: 120 })),
    amountCents: exports.v.cents(),
    currency: exports.v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
    bankAccountId: exports.v.nullable(exports.v.uuid()),
    notes: exports.v.nullable(exports.v.string({ max: 2000 })),
});
const paymentAllocatePayload = exports.v.object({
    id: exports.v.uuid(),
    allocations: exports.v.array(exports.v.object({
        invoiceId: exports.v.optional(exports.v.uuid()),
        billId: exports.v.optional(exports.v.uuid()),
        amountCents: exports.v.cents(),
    }), { min: 1, max: 100 }),
});
const reportRangePayload = exports.v.object({
    from: exports.v.date(),
    to: exports.v.date(),
    comparative: exports.v.optional(exports.v.boolean()),
});
const reportAsOfPayload = exports.v.object({
    asOf: exports.v.date(),
    comparative: exports.v.optional(exports.v.boolean()),
});
const ledgerPayload = exports.v.object({
    accountId: exports.v.uuid(),
    from: exports.v.date(),
    to: exports.v.date(),
    page: exports.v.optional(exports.v.int({ min: 1, max: 10_000 })),
    pageSize: exports.v.optional(exports.v.int({ min: 1, max: 200 })),
});
const periodReasonPayload = exports.v.object({
    id: exports.v.uuid(),
    reason: exports.v.string({ min: 3, max: 400, allowEmpty: false }),
});
/**
 * The shared shape of every AR/AP list call (R1).
 *
 * `pageSize` is capped at 200 here and nowhere else — a caller that asks for
 * 5 000 rows gets a validation error naming `pageSize`, not a 40 MB reply.
 * `status` is optional because `overdue` and `partially_paid` are *derived*
 * states, so the service filters them after computing, then slices.
 */
const documentListPayload = exports.v.object({
    from: exports.v.optional(exports.v.date()),
    to: exports.v.optional(exports.v.date()),
    customerId: exports.v.optional(exports.v.uuid()),
    vendorId: exports.v.optional(exports.v.uuid()),
    status: exports.v.optional(exports.v.string({ max: 20 })),
    q: exports.v.optional(exports.v.string({ max: 120 })),
    page: exports.v.optional(exports.v.int({ min: 1, max: 10_000 })),
    pageSize: exports.v.optional(exports.v.int({ min: 1, max: 200 })),
});
const computeDocumentPayload = exports.v.object({
    currency: exports.v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
    lines: exports.v.array(documentLinePayload, { min: 0, max: 200 }),
});
const paymentListPayload = exports.v.object({
    from: exports.v.optional(exports.v.date()),
    to: exports.v.optional(exports.v.date()),
    partnerType: exports.v.optional(exports.v.enum(['customer', 'vendor'])),
    partnerId: exports.v.optional(exports.v.uuid()),
    direction: exports.v.optional(exports.v.enum(['in', 'out'])),
    q: exports.v.optional(exports.v.string({ max: 120 })),
    page: exports.v.optional(exports.v.int({ min: 1, max: 10_000 })),
    pageSize: exports.v.optional(exports.v.int({ min: 1, max: 200 })),
});
const fiscalYearPayload = exports.v.object({ fiscalYearId: exports.v.uuid() });
const perfGeneratePayload = exports.v.object({
    customers: exports.v.optional(exports.v.int({ min: 0, max: 20_000 })),
    products: exports.v.optional(exports.v.int({ min: 0, max: 20_000 })),
    invoices: exports.v.optional(exports.v.int({ min: 0, max: 50_000 })),
    seed: exports.v.optional(exports.v.int({ min: 0, max: 2_147_483_647 })),
});
const archiveBeforePayload = exports.v.object({ before: exports.v.date() });
const archiveRunPayload = exports.v.object({
    before: exports.v.date(),
    tables: exports.v.optional(exports.v.array(exports.v.string({ min: 2, max: 40 }), { max: 10 })),
    reason: exports.v.optional(exports.v.string({ max: 400 })),
    limit: exports.v.optional(exports.v.int({ min: 1, max: 50_000 })),
});
const searchPayload = exports.v.object({
    q: exports.v.string({ max: 120, allowEmpty: true, trim: false }),
    limit: exports.v.optional(exports.v.int({ min: 1, max: 50 })),
    kinds: exports.v.optional(exports.v.array(exports.v.string({ min: 2, max: 40 }), { max: 12 })),
});
const searchPalettePayload = exports.v.object({
    q: exports.v.string({ max: 120, allowEmpty: true, trim: false }),
});
// ── T09 CRM ─────────────────────────────────────────────────────────────────
const crmBoardPayload = exports.v.object({
    pipelineId: exports.v.optional(exports.v.uuid()),
    ownerId: exports.v.optional(exports.v.uuid()),
    stageId: exports.v.optional(exports.v.uuid()),
    closeFrom: exports.v.optional(exports.v.date()),
    closeTo: exports.v.optional(exports.v.date()),
    q: exports.v.optional(exports.v.string({ max: 120 })),
    perColumn: exports.v.optional(exports.v.int({ min: 1, max: 200 })),
});
const crmMoveStagePayload = exports.v.object({
    id: exports.v.uuid(),
    stageId: exports.v.uuid(),
    note: exports.v.nullable(exports.v.string({ max: 400 })),
});
const crmCloseWonPayload = exports.v.object({
    id: exports.v.uuid(),
    note: exports.v.nullable(exports.v.string({ max: 400 })),
});
const crmCloseLostPayload = exports.v.object({
    id: exports.v.uuid(),
    reason: exports.v.string({ min: 1, max: 200, allowEmpty: false }),
    note: exports.v.nullable(exports.v.string({ max: 400 })),
});
/**
 * The conversion payload. Every branch is validated here as well as in the
 * service, because `objectValidator` copies declared keys only — a field missing
 * from this shape is dropped before the service ever sees it, and the account
 * would then be created with no name.
 */
const crmLeadConvertPayload = exports.v.object({
    leadId: exports.v.uuid(),
    account: exports.v.object({
        name: exports.v.string({ min: 1, max: 200, allowEmpty: false }),
        industry: exports.v.nullable(exports.v.string({ max: 120 })),
        domain: exports.v.nullable(exports.v.string({ max: 200 })),
        phone: exports.v.nullable(exports.v.string({ max: 40 })),
        ownerId: exports.v.nullable(exports.v.uuid()),
        customerId: exports.v.nullable(exports.v.uuid()),
    }),
    contact: exports.v.object({
        firstName: exports.v.string({ min: 1, max: 120, allowEmpty: false }),
        lastName: exports.v.nullable(exports.v.string({ max: 120 })),
        title: exports.v.nullable(exports.v.string({ max: 120 })),
        email: exports.v.nullable(exports.v.string({ max: 200 })),
        phone: exports.v.nullable(exports.v.string({ max: 40 })),
        isPrimary: exports.v.optional(exports.v.boolean()),
    }),
    deal: exports.v.object({
        name: exports.v.string({ min: 1, max: 200, allowEmpty: false }),
        pipelineId: exports.v.uuid(),
        stageId: exports.v.nullable(exports.v.uuid()),
        valueCents: exports.v.cents(),
        currency: exports.v.optional(exports.v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ })),
        expectedCloseDate: exports.v.nullable(exports.v.date()),
        ownerId: exports.v.nullable(exports.v.uuid()),
    }),
});
const crmTimelinePayload = exports.v.object({
    entity: exports.v.optional(exports.v.string({ max: 40 })),
    entityId: exports.v.optional(exports.v.string({ max: 64 })),
    openOnly: exports.v.optional(exports.v.boolean()),
    from: exports.v.optional(exports.v.date()),
    to: exports.v.optional(exports.v.date()),
    ownerId: exports.v.optional(exports.v.uuid()),
    limit: exports.v.optional(exports.v.int({ min: 1, max: 200 })),
    offset: exports.v.optional(exports.v.int({ min: 0, max: 1_000_000 })),
});
const crmActivityPayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    type: exports.v.enum(['call', 'email', 'meeting', 'task', 'note', 'system']),
    subject: exports.v.string({ min: 1, max: 200, allowEmpty: false }),
    body: exports.v.nullable(exports.v.string({ max: 4000 })),
    entity: exports.v.string({ min: 2, max: 40, allowEmpty: false }),
    entityId: exports.v.string({ min: 1, max: 64, allowEmpty: false }),
    ownerId: exports.v.nullable(exports.v.uuid()),
    dueAt: exports.v.nullable(exports.v.timestamp()),
});
const crmActivityCompletePayload = exports.v.object({
    id: exports.v.uuid(),
    done: exports.v.optional(exports.v.boolean()),
});
const crmPipelineSavePayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    name: exports.v.string({ min: 1, max: 120, allowEmpty: false }),
    isDefault: exports.v.optional(exports.v.boolean()),
});
const crmStageSavePayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    pipelineId: exports.v.uuid(),
    name: exports.v.string({ min: 1, max: 120, allowEmpty: false }),
    sortOrder: exports.v.optional(exports.v.int({ min: 0, max: 999 })),
    probabilityBp: exports.v.bp(),
    isWon: exports.v.optional(exports.v.boolean()),
    isLost: exports.v.optional(exports.v.boolean()),
    color: exports.v.optional(exports.v.enum(['info', 'accent', 'warning', 'success', 'danger', 'neutral'])),
});
const crmStageReorderPayload = exports.v.object({
    pipelineId: exports.v.uuid(),
    ids: exports.v.array(exports.v.uuid(), { min: 1, max: 60 }),
});
const crmLossReasonSavePayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    label: exports.v.string({ min: 1, max: 120, allowEmpty: false }),
    isActive: exports.v.optional(exports.v.boolean()),
});
const crmAnalyticsPayload = exports.v.object({
    from: exports.v.date(),
    to: exports.v.date(),
    pipelineId: exports.v.optional(exports.v.uuid()),
});
// ── T10 dashboard, admin ────────────────────────────────────────────────────
const dashboardPayload = exports.v.object({
    period: exports.v.optional(exports.v.enum(['month', 'quarter', 'ytd', 'custom'])),
    from: exports.v.optional(exports.v.date()),
    to: exports.v.optional(exports.v.date()),
});
const recentPushPayload = exports.v.object({
    id: exports.v.string({ min: 1, max: 64, allowEmpty: false }),
    title: exports.v.string({ min: 1, max: 200, allowEmpty: false }),
    subtitle: exports.v.string({ max: 200 }),
    kind: exports.v.string({ min: 2, max: 40, allowEmpty: false }),
    route: exports.v.string({ min: 1, max: 300, allowEmpty: false }),
});
const auditDiffPayload = exports.v.object({ seq: exports.v.int({ min: 1, max: 1_000_000_000 }) });
const backupRunPayload = exports.v.object({
    directory: exports.v.string({ min: 1, max: 400, allowEmpty: false, trim: false }),
});
const backupListPayload = exports.v.object({
    directory: exports.v.string({ max: 400, trim: false }),
});
const backupRestorePayload = exports.v.object({
    path: exports.v.string({ min: 1, max: 400, allowEmpty: false, trim: false }),
    skipSafetyCopy: exports.v.optional(exports.v.boolean()),
});
const importEntityPayload = exports.v.object({
    entity: exports.v.string({ min: 3, max: 40, allowEmpty: false }),
});
const importParsePayload = exports.v.object({
    entity: exports.v.string({ min: 3, max: 40, allowEmpty: false }),
    path: exports.v.string({ min: 1, max: 400, allowEmpty: false, trim: false }),
});
const importValidatePayload = exports.v.object({
    batchId: exports.v.uuid(),
    mapping: exports.v.record(),
    updateExisting: exports.v.optional(exports.v.boolean()),
});
const importCommitPayload = exports.v.object({ batchId: exports.v.uuid() });
const printablePayload = exports.v.object({
    docType: exports.v.enum([
        'invoice',
        'bill',
        'quote',
        'purchase_order',
        'delivery_note',
        'credit_note',
        'statement',
    ]),
    id: exports.v.string({ min: 1, max: 64, allowEmpty: false }),
});
const printableSavePayload = exports.v.object({
    docType: exports.v.enum([
        'invoice',
        'bill',
        'quote',
        'purchase_order',
        'delivery_note',
        'credit_note',
        'statement',
    ]),
    id: exports.v.string({ min: 1, max: 64, allowEmpty: false }),
    path: exports.v.optional(exports.v.string({ max: 1000 })),
});
/**
 * T07/T08 payloads.
 *
 * The paged lists share one shape: a page window capped at 200 plus the handful of
 * optional filters the screens offer. `pageSize` is validated here and nowhere
 * else, exactly like the finance lists — a caller asking for 5 000 rows gets a
 * `VALIDATION` naming `pageSize`.
 */
const opsPage = {
    page: exports.v.optional(exports.v.int({ min: 1, max: 10_000 })),
    pageSize: exports.v.optional(exports.v.int({ min: 1, max: 200 })),
};
const opsListPayload = exports.v.object({
    q: exports.v.optional(exports.v.string({ max: 120 })),
    status: exports.v.optional(exports.v.string({ max: 24 })),
    from: exports.v.optional(exports.v.date()),
    to: exports.v.optional(exports.v.date()),
    productId: exports.v.optional(exports.v.uuid()),
    locationId: exports.v.optional(exports.v.uuid()),
    warehouseId: exports.v.optional(exports.v.uuid()),
    customerId: exports.v.optional(exports.v.uuid()),
    vendorId: exports.v.optional(exports.v.uuid()),
    poId: exports.v.optional(exports.v.uuid()),
    lowOnly: exports.v.optional(exports.v.boolean()),
    ...opsPage,
});
const stockMovePayload = exports.v.object({
    type: exports.v.enum(['receipt', 'issue', 'transfer', 'adjustment', 'production_in', 'production_out']),
    productId: exports.v.uuid(),
    fromLocationId: exports.v.optional(exports.v.uuid()),
    toLocationId: exports.v.optional(exports.v.uuid()),
    // Signed, and bounded so a fat-fingered quantity cannot overflow the cents maths.
    qtyMilli: exports.v.int({ min: -1_000_000_000_000, max: 1_000_000_000_000 }),
    unitCostCents: exports.v.optional(exports.v.int({ min: 0, max: 1_000_000_000_000 })),
    reason: exports.v.optional(exports.v.string({ max: 500 })),
    movedAt: exports.v.optional(exports.v.date()),
    reference: exports.v.optional(exports.v.string({ max: 120 })),
    uom: exports.v.optional(exports.v.string({ max: 24 })),
    sourceType: exports.v.optional(exports.v.string({ max: 40 })),
    sourceId: exports.v.optional(exports.v.string({ max: 64 })),
    allowNegative: exports.v.optional(exports.v.boolean()),
});
const opsLinePayload = exports.v.object({
    productId: exports.v.optional(exports.v.uuid()),
    description: exports.v.string({ min: 1, max: 500 }),
    qtyMilli: exports.v.int({ min: 1, max: 1_000_000_000_000 }),
    unitPriceCents: exports.v.int({ min: 0, max: 1_000_000_000_000 }),
    discountBp: exports.v.optional(exports.v.int({ min: 0, max: 10_000 })),
    taxId: exports.v.optional(exports.v.uuid()),
});
const poSavePayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    vendorId: exports.v.uuid(),
    date: exports.v.date(),
    expectedDate: exports.v.optional(exports.v.date()),
    warehouseId: exports.v.optional(exports.v.uuid()),
    notes: exports.v.optional(exports.v.string({ max: 2000 })),
    lines: exports.v.array(opsLinePayload, { min: 1, max: 200 }),
});
const receiptSavePayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    poId: exports.v.optional(exports.v.uuid()),
    vendorId: exports.v.uuid(),
    date: exports.v.date(),
    warehouseId: exports.v.uuid(),
    locationId: exports.v.optional(exports.v.uuid()),
    notes: exports.v.optional(exports.v.string({ max: 2000 })),
    lines: exports.v.array(exports.v.object({
        poLineId: exports.v.optional(exports.v.uuid()),
        productId: exports.v.uuid(),
        qtyMilli: exports.v.int({ min: 1, max: 1_000_000_000_000 }),
        unitCostCents: exports.v.optional(exports.v.int({ min: 0, max: 1_000_000_000_000 })),
        lotRef: exports.v.optional(exports.v.string({ max: 120 })),
    }), { min: 1, max: 200 }),
});
const quoteSavePayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    customerId: exports.v.uuid(),
    date: exports.v.date(),
    expiryDate: exports.v.date(),
    notes: exports.v.optional(exports.v.string({ max: 2000 })),
    terms: exports.v.optional(exports.v.string({ max: 2000 })),
    lines: exports.v.array(opsLinePayload, { min: 1, max: 200 }),
});
const orderSavePayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    customerId: exports.v.uuid(),
    date: exports.v.date(),
    warehouseId: exports.v.optional(exports.v.uuid()),
    notes: exports.v.optional(exports.v.string({ max: 2000 })),
    terms: exports.v.optional(exports.v.string({ max: 2000 })),
    quoteId: exports.v.optional(exports.v.uuid()),
    lines: exports.v.array(opsLinePayload, { min: 1, max: 200 }),
});
const deliverySavePayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    orderId: exports.v.optional(exports.v.uuid()),
    customerId: exports.v.uuid(),
    date: exports.v.date(),
    warehouseId: exports.v.uuid(),
    notes: exports.v.optional(exports.v.string({ max: 2000 })),
    lines: exports.v.array(exports.v.object({
        soLineId: exports.v.optional(exports.v.uuid()),
        productId: exports.v.uuid(),
        qtyMilli: exports.v.int({ min: 1, max: 1_000_000_000_000 }),
    }), { min: 1, max: 200 }),
});
const priceResolvePayload = exports.v.object({
    productId: exports.v.uuid(),
    customerId: exports.v.uuid(),
    qtyMilli: exports.v.optional(exports.v.int({ min: 1, max: 1_000_000_000_000 })),
    at: exports.v.optional(exports.v.date()),
});
const overridePayload = exports.v.object({
    id: exports.v.uuid(),
    overrideExpiry: exports.v.optional(exports.v.boolean()),
    overrideCredit: exports.v.optional(exports.v.boolean()),
    reason: exports.v.optional(exports.v.string({ max: 500 })),
});
const statementPayload = exports.v.object({
    vendorId: exports.v.uuid(),
    from: exports.v.date(),
    to: exports.v.date(),
});
const analysisPayload = exports.v.object({
    groupBy: exports.v.enum(['vendor', 'product', 'month']),
    from: exports.v.date(),
    to: exports.v.date(),
});
const moveHistoryPayload = exports.v.object({
    productId: exports.v.uuid(),
    locationId: exports.v.optional(exports.v.uuid()),
    ...opsPage,
});
const markInvoicedPayload = exports.v.object({
    orderId: exports.v.uuid(),
    invoiceId: exports.v.uuid(),
    lines: exports.v.array(exports.v.object({
        productId: exports.v.optional(exports.v.uuid()),
        qtyMilli: exports.v.int({ min: 0, max: 1_000_000_000_000 }),
    }), { min: 0, max: 200 }),
});
const uomSavePayload = exports.v.object({
    productId: exports.v.optional(exports.v.uuid()),
    fromUom: exports.v.string({ min: 1, max: 24 }),
    toUom: exports.v.string({ min: 1, max: 24 }),
    factorMilli: exports.v.int({ min: 1, max: 1_000_000_000 }),
});
const pricelistSavePayload = exports.v.object({
    id: exports.v.optional(exports.v.uuid()),
    name: exports.v.string({ min: 1, max: 120 }),
    currency: exports.v.optional(exports.v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ })),
    validFrom: exports.v.optional(exports.v.date()),
    validTo: exports.v.optional(exports.v.date()),
    isDefault: exports.v.optional(exports.v.boolean()),
    isActive: exports.v.optional(exports.v.boolean()),
    items: exports.v.optional(exports.v.array(exports.v.object({
        productId: exports.v.uuid(),
        priceCents: exports.v.int({ min: 0, max: 1_000_000_000_000 }),
        minQtyMilli: exports.v.optional(exports.v.int({ min: 0, max: 1_000_000_000_000 })),
    }), { max: 5000 })),
});
/**
 * Payload validators keyed by channel. A channel with no entry accepts any
 * payload and relies on its handler — every channel added from T03 onwards must
 * register one here (CONVENTIONS §7 step 2).
 */
exports.SCHEMAS = {
    'app.bootstrap': emptyObject,
    'app.quit': emptyObject,
    'app.prefs.save': prefsPayload,
    'auth.login': loginPayload,
    'auth.unlock': exports.v.object({
        password: exports.v.string({ min: 1, max: 200, allowEmpty: false, trim: false }),
    }),
    'auth.lock': emptyObject,
    'auth.logout': emptyObject,
    'auth.session': emptyObject,
    'auth.password.change': passwordChangePayload,
    'auth.heartbeat': heartbeatPayload,
    'onboarding.status': emptyObject,
    'onboarding.preview': exports.v.object({ presetId: exports.v.string({ min: 2, max: 40 }) }),
    'users.create': userCreatePayload,
    'users.update': userUpdatePayload,
    'users.setActive': userSetActivePayload,
    'users.resetPassword': userResetPasswordPayload,
    'roles.duplicate': roleDuplicatePayload,
    'permissions.catalog': emptyObject,
    'settings.get': settingsGetPayload,
    'audit.list': auditListPayload,
    'audit.verify': emptyObject,
    'license.status': emptyObject,
    'license.activate': licenseActivatePayload,
    'license.deactivate': licenseDeactivatePayload,
    'license.machineId': emptyObject,
    // ── T03/T04 ────────────────────────────────────────────────────────────────
    'entity.list': entityListPayload,
    'entity.get': entityGetPayload,
    'entity.save': entitySavePayload,
    'entity.archive': entityArchivePayload,
    'entity.restore': entityGetPayload,
    'entity.delete': entityGetPayload,
    'entity.export': entityExportPayload,
    'onboarding.complete': onboardingCompletePayload,
    'settings.company.save': companySavePayload,
    'settings.company.logo': logoPayload,
    'settings.numbering.list': emptyObject,
    'settings.numbering.save': numberingSavePayload,
    'settings.numbering.preview': numberingDocPayload,
    'settings.numbering.reset': numberingResetPayload,
    'settings.currency.setBase': currencyBasePayload,
    'settings.presets.list': emptyObject,
    'settings.presets.preview': onboardingPreviewPayload,
    'settings.presets.apply': presetApplyPayload,
    'settings.demoData.seed': emptyObject,
    'settings.demoData.remove': emptyObject,
    'settings.security.save': securitySavePayload,
    'notifications.list': notificationsListPayload,
    'notifications.markRead': notificationsMarkReadPayload,
    // ── T05/T06 ────────────────────────────────────────────────────────────────
    'finance.coa.tree': exports.v.object({
        includeArchived: exports.v.optional(exports.v.boolean()),
    }),
    'finance.coa.save': coaSavePayload,
    'finance.coa.archive': idReasonPayload,
    'finance.journals.codes': emptyObject,
    'finance.journals.list': journalFilterPayload,
    'finance.journals.get': idPayload,
    'finance.journals.save': journalSavePayload,
    'finance.journals.post': idPayload,
    'finance.journals.reverse': idReasonPayload,
    'finance.journals.delete': idPayload,
    'finance.invoices.list': documentListPayload,
    'finance.invoices.save': invoiceSavePayload,
    'finance.invoices.get': idPayload,
    'finance.invoices.post': idPayload,
    'finance.invoices.void': idReasonPayload,
    'finance.invoices.duplicate': idPayload,
    'finance.bills.list': documentListPayload,
    'finance.bills.save': billSavePayload,
    'finance.bills.get': idPayload,
    'finance.bills.post': idPayload,
    'finance.bills.void': idReasonPayload,
    'finance.payments.list': paymentListPayload,
    'finance.payments.create': paymentCreatePayload,
    'finance.payments.allocate': paymentAllocatePayload,
    'finance.payments.get': idPayload,
    'finance.documents.compute': computeDocumentPayload,
    'finance.reports.trialBalance': reportAsOfPayload,
    'finance.reports.pnl': reportRangePayload,
    'finance.reports.balanceSheet': reportAsOfPayload,
    'finance.reports.cashFlow': reportRangePayload,
    'finance.reports.generalLedger': ledgerPayload,
    'finance.periods.list': emptyObject,
    'finance.periods.lock': periodReasonPayload,
    'finance.periods.unlock': periodReasonPayload,
    'finance.periods.close': fiscalYearPayload,
    'documents.pdf.preview': printablePayload,
    'documents.pdf.save': printableSavePayload,
    'documents.print': printablePayload,
    'documents.export': entityExportPayload,
    'settings.perf.generate': perfGeneratePayload,
    'settings.perf.benchmark': emptyObject,
    'data.archive.preview': archiveBeforePayload,
    'data.archive.run': archiveRunPayload,
    'data.archive.restore': idPayload,
    'data.archive.stats': emptyObject,
    'data.archive.vacuum': emptyObject,
    'search.global': searchPayload,
    'search.palette': searchPalettePayload,
    'search.recent.list': emptyObject,
    'search.recent.push': recentPushPayload,
    'search.recent.clear': emptyObject,
    'dashboard.summary': dashboardPayload,
    'data.import.pick': emptyObject,
    'data.import.parse': importParsePayload,
    'data.import.validate': importValidatePayload,
    'data.import.commit': importCommitPayload,
    'data.import.template': importEntityPayload,
    'audit.diff': auditDiffPayload,
    'backup.run': backupRunPayload,
    'backup.list': backupListPayload,
    'backup.restore': backupRestorePayload,
    'backup.verify': exports.v.object({ path: exports.v.string({ min: 1, max: 400, allowEmpty: false, trim: false }) }),
    'backup.pickFolder': emptyObject,
    'crm.lead.convert': crmLeadConvertPayload,
    'crm.lead.convertPreview': crmLeadConvertPayload,
    'crm.deal.moveStage': crmMoveStagePayload,
    'crm.deal.closeWon': crmCloseWonPayload,
    'crm.deal.closeLost': crmCloseLostPayload,
    'crm.deal.board': crmBoardPayload,
    'crm.deal.get': idPayload,
    'crm.deal.fromWon': exports.v.object({ id: exports.v.uuid(), customerId: exports.v.uuid() }),
    'crm.activity.save': crmActivityPayload,
    'crm.activity.complete': crmActivityCompletePayload,
    'crm.timeline': crmTimelinePayload,
    'crm.pipelines.list': emptyObject,
    'crm.pipelines.save': crmPipelineSavePayload,
    'crm.stages.save': crmStageSavePayload,
    'crm.stages.reorder': crmStageReorderPayload,
    'crm.lossReasons.list': emptyObject,
    'crm.lossReasons.save': crmLossReasonSavePayload,
    'crm.analytics': crmAnalyticsPayload,
    // ── T07 inventory ──────────────────────────────────────────────────────────
    'inventory.stock.onHand': exports.v.object({
        productId: exports.v.uuid(),
        locationId: exports.v.optional(exports.v.uuid()),
    }),
    'inventory.stock.available': exports.v.object({
        productId: exports.v.uuid(),
        locationId: exports.v.uuid(),
    }),
    'inventory.moves.list': opsListPayload,
    'inventory.moves.post': stockMovePayload,
    'inventory.moves.reverse': idReasonPayload,
    'inventory.valuation': exports.v.object({ asOf: exports.v.optional(exports.v.date()) }),
    'inventory.quants.rebuild': emptyObject,
    'inventory.lowStock': emptyObject,
    'inventory.quants.list': opsListPayload,
    'inventory.moves.history': moveHistoryPayload,
    'inventory.aging': exports.v.object({ asOf: exports.v.optional(exports.v.date()) }),
    'inventory.stock.overview': exports.v.object({ groupBy: exports.v.optional(exports.v.string({ max: 20 })) }),
    'inventory.uom.list': exports.v.object({ productId: exports.v.optional(exports.v.uuid()) }),
    'inventory.uom.save': uomSavePayload,
    // ── T08 purchasing ─────────────────────────────────────────────────────────
    'purchasing.po.list': opsListPayload,
    'purchasing.po.get': idPayload,
    'purchasing.po.save': poSavePayload,
    'purchasing.po.confirm': idPayload,
    'purchasing.po.cancel': idReasonPayload,
    'purchasing.po.outstanding': exports.v.object({ vendorId: exports.v.optional(exports.v.uuid()) }),
    'purchasing.receipt.list': opsListPayload,
    'purchasing.receipt.get': idPayload,
    'purchasing.receipt.create': receiptSavePayload,
    'purchasing.receipt.post': idPayload,
    'purchasing.receipt.cancel': idReasonPayload,
    'purchasing.bill.fromReceipt': idPayload,
    'purchasing.match.preview': idPayload,
    'purchasing.vendors.statement': statementPayload,
    'purchasing.analysis': analysisPayload,
    // ── T08 sales ──────────────────────────────────────────────────────────────
    'sales.price.resolve': priceResolvePayload,
    'sales.quote.list': opsListPayload,
    'sales.quote.get': idPayload,
    'sales.quote.save': quoteSavePayload,
    'sales.quote.send': idPayload,
    'sales.quote.accept': idPayload,
    'sales.quote.expire': idPayload,
    'sales.quote.convert': overridePayload,
    'sales.order.list': opsListPayload,
    'sales.order.get': idPayload,
    'sales.order.save': orderSavePayload,
    'sales.order.confirm': overridePayload,
    'sales.order.cancel': idReasonPayload,
    'sales.order.availability': exports.v.object({ orderId: exports.v.uuid() }),
    'sales.order.invoice': idPayload,
    'sales.order.markInvoiced': markInvoicedPayload,
    'sales.delivery.list': opsListPayload,
    'sales.delivery.get': idPayload,
    'sales.delivery.create': deliverySavePayload,
    'sales.delivery.post': idPayload,
    'sales.customers.outstanding': exports.v.object({ customerId: exports.v.optional(exports.v.uuid()) }),
    'sales.pricelist.list': emptyObject,
    'sales.pricelist.items': idPayload,
    'sales.pricelist.saveItems': pricelistSavePayload,
    // ── the 3-way match preview that T06 declared but never implemented ───────
    'finance.bills.match': idPayload,
};
/** Validates a payload for a channel, falling back to "accept anything". */
function validatePayload(channel, payload) {
    const validator = exports.SCHEMAS[channel];
    if (!validator)
        return pass(payload);
    return validator.validate(payload, channel);
}
//# sourceMappingURL=schemas.js.map