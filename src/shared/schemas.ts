/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Hand-written payload validators. No `zod`, no dependency, no code
 * generation — 200 lines that cannot break on an upgrade.
 *
 * These validate SHAPE ONLY. Business rules belong in the service layer
 * (CONVENTIONS §6: "validate in ipc.ts (shape) and in the service (business)").
 */

import { isValidDate, isValidTimestamp } from './dates';
import { MAX_PAGE_SIZE } from './types';
import type { Channel } from './channels';

export interface Issue {
  readonly path: string;
  readonly message: string;
}

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly Issue[] };

export interface Validator<T> {
  readonly validate: (input: unknown, path?: string) => Validated<T>;
}

const pass = <T>(value: T): Validated<T> => ({ ok: true, value });
const fail = (path: string, message: string): Validated<never> => ({
  ok: false,
  issues: [{ path, message }],
});

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function describe(input: unknown): string {
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'a list';
  return `a ${typeof input}`;
}

export interface StringOptions {
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp;
  readonly trim?: boolean;
  readonly allowEmpty?: boolean;
}

function stringValidator(options: StringOptions = {}): Validator<string> {
  const { min = 0, max = 4096, pattern, trim = true, allowEmpty = true } = options;
  return {
    validate: (input, path = '') => {
      if (typeof input !== 'string') return fail(path, `Expected text but received ${describe(input)}`);
      const value = trim ? input.trim() : input;
      if (!allowEmpty && value.length === 0) return fail(path, 'This field is required');
      if (value.length < min) return fail(path, `Must be at least ${String(min)} characters`);
      if (value.length > max) return fail(path, `Must be at most ${String(max)} characters`);
      if (pattern && !pattern.test(value)) return fail(path, 'Contains characters that are not allowed here');
      return pass(value);
    },
  };
}

function intValidator(options: { min?: number; max?: number } = {}): Validator<number> {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
  return {
    validate: (input, path = '') => {
      if (typeof input !== 'number' || !Number.isInteger(input)) {
        return fail(path, `Expected a whole number but received ${describe(input)}`);
      }
      if (input < min) return fail(path, `Must be ${String(min)} or more`);
      if (input > max) return fail(path, `Must be ${String(max)} or less`);
      return pass(input);
    },
  };
}

function numberValidator(options: { min?: number; max?: number } = {}): Validator<number> {
  const { min = -Number.MAX_VALUE, max = Number.MAX_VALUE } = options;
  return {
    validate: (input, path = '') => {
      if (typeof input !== 'number' || !Number.isFinite(input)) {
        return fail(path, `Expected a number but received ${describe(input)}`);
      }
      if (input < min) return fail(path, `Must be ${String(min)} or more`);
      if (input > max) return fail(path, `Must be ${String(max)} or less`);
      return pass(input);
    },
  };
}

function enumValidator<const T extends readonly string[]>(values: T): Validator<T[number]> {
  return {
    validate: (input, path = '') => {
      if (typeof input !== 'string' || !values.includes(input)) {
        return fail(path, `Must be one of: ${values.join(', ')}`);
      }
      return pass(input as T[number]);
    },
  };
}

function booleanValidator(): Validator<boolean> {
  return {
    validate: (input, path = '') =>
      typeof input === 'boolean' ? pass(input) : fail(path, `Expected true or false but received ${describe(input)}`),
  };
}

function arrayValidator<T>(
  item: Validator<T>,
  options: { min?: number; max?: number } = {},
): Validator<readonly T[]> {
  const { min = 0, max = 5000 } = options;
  return {
    validate: (input, path = '') => {
      if (!Array.isArray(input)) return fail(path, `Expected a list but received ${describe(input)}`);
      if (input.length < min) return fail(path, `Must contain at least ${String(min)} item(s)`);
      if (input.length > max) return fail(path, `Must contain at most ${String(max)} item(s)`);
      const values: T[] = [];
      const issues: Issue[] = [];
      input.forEach((entry, index) => {
        const result = item.validate(entry, `${path}[${String(index)}]`);
        if (result.ok) values.push(result.value);
        else issues.push(...result.issues);
      });
      if (issues.length > 0) return { ok: false, issues };
      return pass(values);
    },
  };
}

function objectValidator<T extends Record<string, unknown>>(shape: {
  readonly [K in keyof T]: Validator<T[K]>;
}): Validator<T> {
  return {
    validate: (input, path = '') => {
      if (!isPlainObject(input)) return fail(path, `Expected an object but received ${describe(input)}`);
      const output: Record<string, unknown> = {};
      const issues: Issue[] = [];
      for (const key of Object.keys(shape)) {
        const validator = shape[key];
        if (!validator) continue;
        const childPath = path === '' ? key : `${path}.${key}`;
        const result = validator.validate(input[key], childPath);
        if (result.ok) {
          if (result.value !== undefined) output[key] = result.value;
        } else {
          issues.push(...result.issues);
        }
      }
      if (issues.length > 0) return { ok: false, issues };
      return pass(output as T);
    },
  };
}

function optional<T>(inner: Validator<T>): Validator<T | undefined> {
  return {
    validate: (input, path = '') => (input === undefined ? pass(undefined) : inner.validate(input, path)),
  };
}

/** Accepts `undefined`, `null` or a valid value — the shape of an optional FK. */
function nullable<T>(inner: Validator<T>): Validator<T | null | undefined> {
  return {
    validate: (input, path = '') =>
      input === undefined || input === null ? pass(input) : inner.validate(input, path),
  };
}

function anything<T = unknown>(): Validator<T> {
  return { validate: (input) => pass(input as T) };
}

/** The validator vocabulary. Every payload below is built from exactly these. */
export const v = {
  string: stringValidator,
  /** Non-empty trimmed text — the common case for a name. */
  text: (max = 200): Validator<string> => stringValidator({ min: 1, max, allowEmpty: false }),
  uuid: (): Validator<string> =>
    stringValidator({
      min: 36,
      max: 36,
      pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    }),
  int: intValidator,
  /** Integer minor units. May be negative (a credit, a variance). */
  cents: (): Validator<number> => intValidator({ min: -999_999_999_999, max: 999_999_999_999 }),
  /** Integer milli-units of quantity. */
  milli: (): Validator<number> => intValidator({ min: -999_999_999_999, max: 999_999_999_999 }),
  /** Basis points, 0..100000 (0%..1000%). */
  bp: (): Validator<number> => intValidator({ min: -100_000, max: 100_000 }),
  number: numberValidator,
  boolean: booleanValidator,
  /** `YYYY-MM-DD`. */
  date: (): Validator<string> => ({
    validate: (input, path = '') =>
      typeof input === 'string' && isValidDate(input)
        ? pass(input)
        : fail(path, 'Expected a date in YYYY-MM-DD form'),
  }),
  /** Full ISO-8601 UTC timestamp. */
  timestamp: (): Validator<string> => ({
    validate: (input, path = '') =>
      typeof input === 'string' && isValidTimestamp(input)
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
  record: <T = unknown>(): Validator<Readonly<Record<string, T>>> => ({
    validate: (input, path = '') => {
      if (input === undefined) return pass({});
      if (!isPlainObject(input)) return fail(path, `Expected an object but received ${describe(input)}`);
      return pass(input as Readonly<Record<string, T>>);
    },
  }),
};

// ── per-channel payloads ─────────────────────────────────────────────────────

const emptyObject: Validator<Record<string, never>> = {
  validate: (input, path = '') =>
    input === undefined || isPlainObject(input)
      ? pass({} as Record<string, never>)
      : fail(path, `Expected an object but received ${describe(input)}`),
};

const loginPayload = v.object<{ username: string; password: string }>({
  username: v.string({ min: 1, max: 64, allowEmpty: false }),
  password: v.string({ min: 1, max: 200, allowEmpty: false, trim: false }),
});

const prefsPayload = v.object<{
  theme?: 'light' | 'dark';
  density?: 'compact' | 'comfortable';
  accent?: 'blue' | 'teal' | 'violet' | 'amber';
  sidebarCollapsed?: boolean;
  locale?: string;
  licenseNoticeDismissed?: boolean;
}>({
  theme: v.optional(v.enum(['light', 'dark'] as const)),
  density: v.optional(v.enum(['compact', 'comfortable'] as const)),
  accent: v.optional(v.enum(['blue', 'teal', 'violet', 'amber'] as const)),
  sidebarCollapsed: v.optional(v.boolean()),
  locale: v.optional(v.string({ min: 2, max: 16 })),
  licenseNoticeDismissed: v.optional(v.boolean()),
});

const passwordChangePayload = v.object<{ currentPassword: string; newPassword: string }>({
  currentPassword: v.string({ min: 1, max: 200, allowEmpty: false, trim: false }),
  newPassword: v.string({ min: 8, max: 200, allowEmpty: false, trim: false }),
});

const userCreatePayload = v.object<{
  username: string;
  fullName: string;
  email?: string;
  password: string;
  roleIds: readonly string[];
}>({
  username: v.string({ min: 3, max: 64, pattern: /^[a-zA-Z0-9._-]+$/ }),
  fullName: v.string({ min: 1, max: 120, allowEmpty: false }),
  email: v.optional(v.string({ max: 160, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ })),
  password: v.string({ min: 8, max: 200, allowEmpty: false, trim: false }),
  roleIds: v.array(v.uuid(), { min: 1, max: 20 }),
});

const userUpdatePayload = v.object<{
  id: string;
  fullName?: string;
  email?: string;
  roleIds?: readonly string[];
  prefs?: Readonly<Record<string, unknown>>;
}>({
  id: v.uuid(),
  fullName: v.optional(v.string({ min: 1, max: 120, allowEmpty: false })),
  email: v.optional(v.string({ max: 160, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ })),
  roleIds: v.optional(v.array(v.uuid(), { max: 20 })),
  prefs: v.optional(v.record()),
});

const userSetActivePayload = v.object<{ id: string; active: boolean; reason?: string }>({
  id: v.uuid(),
  active: v.boolean(),
  reason: v.optional(v.string({ max: 200 })),
});

const userResetPasswordPayload = v.object<{ id: string; newPassword: string; mustChange: boolean }>({
  id: v.uuid(),
  newPassword: v.string({ min: 8, max: 200, allowEmpty: false, trim: false }),
  mustChange: v.boolean(),
});

const roleDuplicatePayload = v.object<{ id: string; name: string }>({
  id: v.uuid(),
  name: v.string({ min: 2, max: 60, allowEmpty: false }),
});

const auditListPayload = v.object<{
  actorId?: string;
  entity?: string;
  entityId?: string;
  action?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}>({
  actorId: v.optional(v.uuid()),
  entity: v.optional(v.string({ max: 60 })),
  entityId: v.optional(v.string({ max: 64 })),
  action: v.optional(v.string({ max: 60 })),
  from: v.optional(v.timestamp()),
  to: v.optional(v.timestamp()),
  limit: v.optional(v.int({ min: 1, max: 500 })),
  offset: v.optional(v.int({ min: 0, max: 1_000_000 })),
});

const licenseActivatePayload = v.object<{ key: string }>({
  // Short on purpose: the owner's perpetual code is `arfanayub0`, and a signed
  // customer key is far longer. The verifier decides what is acceptable.
  key: v.string({ min: 6, max: 4096, allowEmpty: false }),
});

const licenseDeactivatePayload = v.object<{ reason?: string }>({
  reason: v.optional(v.string({ max: 200 })),
});

const settingsGetPayload = v.object<{ keys?: readonly string[] }>({
  keys: v.optional(v.array(v.string({ min: 1, max: 80 }), { max: 200 })),
});

const heartbeatPayload = v.object<{ at: string }>({ at: v.timestamp() });

// ── T03/T04: entity family, onboarding, settings ─────────────────────────────

const entityListPayload = v.object<{
  entity: string;
  q?: string;
  filters?: Readonly<Record<string, string | number | boolean | null>>;
  sort?: { key: string; dir: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
  viewId?: string;
}>({
  entity: v.string({ min: 2, max: 40 }),
  q: v.optional(v.string({ max: 200 })),
  filters: v.optional(v.anything()),
  sort: v.optional(v.anything()),
  // R1: a list never materialises more than MAX_PAGE_SIZE rows at a time.
  limit: v.optional(v.int({ min: 1, max: MAX_PAGE_SIZE })),
  offset: v.optional(v.int({ min: 0, max: 10_000_000 })),
  viewId: v.optional(v.uuid()),
});

const entityGetPayload = v.object<{ entity: string; id: string }>({
  entity: v.string({ min: 2, max: 40 }),
  id: v.string({ min: 1, max: 64, allowEmpty: false }),
});

const entitySavePayload = v.object<{
  entity: string;
  id?: string;
  values: Readonly<Record<string, unknown>>;
  custom?: Readonly<Record<string, unknown>>;
}>({
  entity: v.string({ min: 2, max: 40 }),
  id: v.optional(v.string({ min: 1, max: 64 })),
  values: v.record(),
  custom: v.optional(v.record()),
});

const entityArchivePayload = v.object<{ entity: string; id: string; reason?: string }>({
  entity: v.string({ min: 2, max: 40 }),
  id: v.string({ min: 1, max: 64, allowEmpty: false }),
  reason: v.optional(v.string({ max: 200 })),
});

const entityExportPayload = v.object<{
  entity: string;
  format: 'csv' | 'xlsx';
  filters?: Readonly<Record<string, string | number | boolean | null>>;
  sort?: { key: string; dir: 'asc' | 'desc' };
  columns?: readonly string[];
}>({
  entity: v.string({ min: 2, max: 40 }),
  format: v.enum(['csv', 'xlsx'] as const),
  filters: v.optional(v.anything()),
  sort: v.optional(v.anything()),
  columns: v.optional(v.array(v.string({ min: 1, max: 60 }), { max: 100 })),
});

const onboardingPreviewPayload = v.object<{ presetId: string }>({
  presetId: v.string({ min: 2, max: 40 }),
});

const onboardingCompletePayload = v.object<{
  company: { name: string; legalName?: string; taxId?: string; address?: unknown };
  presetId: string;
  currency: string;
  fiscalStartMonth: number;
  admin: { username: string; fullName: string; email?: string; password: string };
  licenseKey?: string;
  loadDemo?: boolean;
}>({
  company: v.object({
    name: v.string({ min: 2, max: 120, allowEmpty: false }),
    legalName: v.optional(v.string({ max: 160 })),
    taxId: v.optional(v.string({ max: 40 })),
    address: v.optional(v.anything()),
  }),
  presetId: v.string({ min: 2, max: 40 }),
  currency: v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
  fiscalStartMonth: v.int({ min: 1, max: 12 }),
  admin: v.object({
    username: v.string({ min: 3, max: 64, pattern: /^[a-zA-Z0-9._-]+$/ }),
    fullName: v.string({ min: 1, max: 120, allowEmpty: false }),
    email: v.optional(v.string({ max: 160 })),
    password: v.string({ min: 8, max: 200, allowEmpty: false, trim: false }),
  }),
  licenseKey: v.optional(v.string({ max: 4096 })),
  loadDemo: v.optional(v.boolean()),
});

const companySavePayload = v.object<{
  name?: string;
  legalName?: string | null;
  taxId?: string | null;
  address?: unknown;
  dateFormat?: string;
  numberFormat?: string;
}>({
  name: v.optional(v.string({ min: 2, max: 120, allowEmpty: false })),
  legalName: v.optional(v.string({ max: 160 })),
  taxId: v.optional(v.string({ max: 40 })),
  address: v.optional(v.anything()),
  dateFormat: v.optional(v.string({ min: 4, max: 20 })),
  numberFormat: v.optional(v.string({ min: 4, max: 20 })),
});

const logoPayload = v.object<{ dataUrl: string }>({
  dataUrl: v.string({ min: 32, max: 400_000, allowEmpty: false, trim: false }),
});

const numberingSavePayload = v.object<{
  docType: string;
  prefix: string;
  padding: number;
  suffix?: string;
}>({
  docType: v.string({ min: 2, max: 32, pattern: /^[a-z][a-z0-9_]+$/ }),
  prefix: v.string({ max: 12 }),
  padding: v.int({ min: 1, max: 8 }),
  suffix: v.optional(v.string({ max: 12 })),
});

const numberingDocPayload = v.object<{ docType: string }>({
  docType: v.string({ min: 2, max: 32, pattern: /^[a-z][a-z0-9_]+$/ }),
});

const numberingResetPayload = v.object<{ docType: string; reason: string }>({
  docType: v.string({ min: 2, max: 32, pattern: /^[a-z][a-z0-9_]+$/ }),
  reason: v.string({ min: 3, max: 200, allowEmpty: false }),
});

const currencyBasePayload = v.object<{ code: string }>({
  code: v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
});

const presetApplyPayload = v.object<{ presetId: string; confirm: boolean }>({
  presetId: v.string({ min: 2, max: 40 }),
  confirm: v.boolean(),
});

const securitySavePayload = v.object<{
  idleTimeoutMin?: number;
  minPasswordLength?: number;
  requireSymbol?: boolean;
  maxAttempts?: number;
  lockoutMin?: number;
}>({
  idleTimeoutMin: v.optional(v.int({ min: 1, max: 240 })),
  minPasswordLength: v.optional(v.int({ min: 8, max: 64 })),
  requireSymbol: v.optional(v.boolean()),
  maxAttempts: v.optional(v.int({ min: 3, max: 20 })),
  lockoutMin: v.optional(v.int({ min: 1, max: 1440 })),
});

const notificationsListPayload = v.object<{ unreadOnly?: boolean; limit?: number }>({
  unreadOnly: v.optional(v.boolean()),
  limit: v.optional(v.int({ min: 1, max: 200 })),
});

const notificationsMarkReadPayload = v.object<{ ids?: readonly string[]; all?: boolean }>({
  ids: v.optional(v.array(v.string({ min: 1, max: 64 }), { max: 200 })),
  all: v.optional(v.boolean()),
});

// ── finance (T05/T06) ───────────────────────────────────────────────────────

const idPayload = v.object<{ id: string }>({ id: v.uuid() });

const idReasonPayload = v.object<{ id: string; reason: string }>({
  id: v.uuid(),
  reason: v.string({ min: 3, max: 400, allowEmpty: false }),
});

const coaSavePayload = v.object<{
  id?: string;
  code: string;
  name: string;
  type: string;
  parentId?: string | null;
  isPostable?: boolean;
  currency?: string | null;
  description?: string | null;
}>({
  id: v.optional(v.uuid()),
  code: v.string({ min: 2, max: 16, pattern: /^[0-9A-Z][0-9A-Z.-]+$/, allowEmpty: false }),
  name: v.string({ min: 2, max: 120, allowEmpty: false }),
  type: v.enum(['asset', 'liability', 'equity', 'income', 'expense'] as const),
  parentId: v.nullable(v.uuid()),
  isPostable: v.optional(v.boolean()),
  currency: v.nullable(v.string({ min: 3, max: 3 })),
  description: v.nullable(v.string({ max: 400 })),
});

const journalLinePayload = v.object<{
  accountId?: string;
  accountCode?: string;
  debitCents?: number;
  creditCents?: number;
  description?: string | null;
  currency?: string;
  rateBp?: number;
  partnerType?: string | null;
  partnerId?: string | null;
  taxId?: string | null;
}>({
  accountId: v.optional(v.uuid()),
  accountCode: v.optional(v.string({ min: 2, max: 16 })),
  debitCents: v.optional(v.cents()),
  creditCents: v.optional(v.cents()),
  description: v.nullable(v.string({ max: 400 })),
  currency: v.optional(v.string({ min: 3, max: 3 })),
  rateBp: v.optional(v.int({ min: 1, max: 100_000_000 })),
  partnerType: v.nullable(v.enum(['customer', 'vendor'] as const)),
  partnerId: v.nullable(v.uuid()),
  taxId: v.nullable(v.uuid()),
});

const journalSavePayload = v.object<{
  id?: string;
  date: string;
  journalCode: string;
  memo?: string | null;
  lines: readonly unknown[];
  sourceType: string;
  sourceId?: string | null;
  status?: string;
}>({
  id: v.optional(v.uuid()),
  date: v.date(),
  journalCode: v.string({ min: 2, max: 8, allowEmpty: false }),
  memo: v.nullable(v.string({ max: 400 })),
  lines: v.array(journalLinePayload, { min: 2, max: 500 }),
  sourceType: v.string({ min: 2, max: 40, allowEmpty: false }),
  sourceId: v.nullable(v.string({ max: 64 })),
  status: v.optional(v.enum(['draft', 'posted'] as const)),
});

const journalFilterPayload = v.object<{
  from?: string;
  to?: string;
  journalId?: string;
  sourceType?: string;
  status?: string;
  minCents?: number;
  maxCents?: number;
  q?: string;
  page?: number;
  pageSize?: number;
}>({
  from: v.optional(v.date()),
  to: v.optional(v.date()),
  journalId: v.optional(v.uuid()),
  sourceType: v.optional(v.string({ max: 40 })),
  status: v.optional(v.enum(['draft', 'posted', 'reversed'] as const)),
  minCents: v.optional(v.cents()),
  maxCents: v.optional(v.cents()),
  q: v.optional(v.string({ max: 120 })),
  page: v.optional(v.int({ min: 1, max: 10_000 })),
  pageSize: v.optional(v.int({ min: 1, max: 200 })),
});

const documentLineShape = {
  productId: v.nullable(v.uuid()),
  description: v.string({ min: 1, max: 400, allowEmpty: false }),
  qtyMilli: v.milli(),
  unitPriceCents: v.cents(),
  discountBp: v.optional(v.bp()),
  taxId: v.nullable(v.uuid()),
  accountId: v.nullable(v.uuid()),
} as const;

const documentLinePayload = v.object<{
  productId?: string | null;
  description: string;
  qtyMilli: number;
  unitPriceCents: number;
  discountBp?: number;
  taxId?: string | null;
  accountId?: string | null;
}>(documentLineShape);

/*
 * A bill line carries two extra columns that only exist for the three-way
 * match: the price the purchase order agreed and the quantity the receipt
 * actually delivered. `objectValidator` copies declared keys only, so leaving
 * them off this schema silently stripped them and the match compared nothing
 * against nothing — every bill "passed" and the accrual was never cleared.
 */
const billLinePayload = v.object<{
  productId?: string | null;
  description: string;
  qtyMilli: number;
  unitPriceCents: number;
  discountBp?: number;
  taxId?: string | null;
  accountId?: string | null;
  poPriceCents?: number;
  receivedQtyMilli?: number;
}>({
  ...documentLineShape,
  poPriceCents: v.optional(v.cents()),
  receivedQtyMilli: v.optional(v.milli()),
});

const invoiceSavePayload = v.object<{
  id?: string;
  customerId: string;
  date: string;
  dueDate: string;
  currency: string;
  notes?: string | null;
  terms?: string | null;
  lines: readonly unknown[];
  sourceType?: string | null;
  sourceId?: string | null;
}>({
  id: v.optional(v.uuid()),
  customerId: v.uuid(),
  date: v.date(),
  dueDate: v.date(),
  currency: v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
  notes: v.nullable(v.string({ max: 2000 })),
  terms: v.nullable(v.string({ max: 2000 })),
  lines: v.array(documentLinePayload, { min: 1, max: 200 }),
  sourceType: v.nullable(v.string({ max: 40 })),
  sourceId: v.nullable(v.string({ max: 64 })),
});

const billSavePayload = v.object<{
  id?: string;
  vendorId: string;
  vendorRef?: string | null;
  date: string;
  dueDate: string;
  currency: string;
  notes?: string | null;
  lines: readonly unknown[];
  poId?: string | null;
  receiptIds?: readonly string[];
}>({
  id: v.optional(v.uuid()),
  vendorId: v.uuid(),
  vendorRef: v.nullable(v.string({ max: 120 })),
  date: v.date(),
  dueDate: v.date(),
  currency: v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
  notes: v.nullable(v.string({ max: 2000 })),
  lines: v.array(billLinePayload, { min: 1, max: 200 }),
  poId: v.nullable(v.uuid()),
  receiptIds: v.optional(v.array(v.uuid(), { max: 50 })),
});

const paymentCreatePayload = v.object<{
  direction: string;
  partnerType: string;
  partnerId: string;
  date: string;
  method: string;
  reference?: string | null;
  amountCents: number;
  currency: string;
  bankAccountId?: string | null;
  notes?: string | null;
}>({
  direction: v.enum(['in', 'out'] as const),
  partnerType: v.enum(['customer', 'vendor'] as const),
  partnerId: v.uuid(),
  date: v.date(),
  method: v.enum(['bank', 'cash', 'card', 'cheque', 'transfer', 'other'] as const),
  reference: v.nullable(v.string({ max: 120 })),
  amountCents: v.cents(),
  currency: v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
  bankAccountId: v.nullable(v.uuid()),
  notes: v.nullable(v.string({ max: 2000 })),
});

const paymentAllocatePayload = v.object<{
  id: string;
  allocations: readonly unknown[];
}>({
  id: v.uuid(),
  allocations: v.array(
    v.object<{ invoiceId?: string; billId?: string; amountCents: number }>({
      invoiceId: v.optional(v.uuid()),
      billId: v.optional(v.uuid()),
      amountCents: v.cents(),
    }),
    { min: 1, max: 100 },
  ),
});

const reportRangePayload = v.object<{ from: string; to: string; comparative?: boolean }>({
  from: v.date(),
  to: v.date(),
  comparative: v.optional(v.boolean()),
});

const reportAsOfPayload = v.object<{ asOf: string; comparative?: boolean }>({
  asOf: v.date(),
  comparative: v.optional(v.boolean()),
});

const ledgerPayload = v.object<{
  accountId: string;
  from: string;
  to: string;
  page?: number;
  pageSize?: number;
}>({
  accountId: v.uuid(),
  from: v.date(),
  to: v.date(),
  page: v.optional(v.int({ min: 1, max: 10_000 })),
  pageSize: v.optional(v.int({ min: 1, max: 200 })),
});

const periodReasonPayload = v.object<{ id: string; reason: string }>({
  id: v.uuid(),
  reason: v.string({ min: 3, max: 400, allowEmpty: false }),
});

/**
 * The shared shape of every AR/AP list call (R1).
 *
 * `pageSize` is capped at 200 here and nowhere else — a caller that asks for
 * 5 000 rows gets a validation error naming `pageSize`, not a 40 MB reply.
 * `status` is optional because `overdue` and `partially_paid` are *derived*
 * states, so the service filters them after computing, then slices.
 */
const documentListPayload = v.object<{
  from?: string;
  to?: string;
  customerId?: string;
  vendorId?: string;
  status?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}>({
  from: v.optional(v.date()),
  to: v.optional(v.date()),
  customerId: v.optional(v.uuid()),
  vendorId: v.optional(v.uuid()),
  status: v.optional(v.string({ max: 20 })),
  q: v.optional(v.string({ max: 120 })),
  page: v.optional(v.int({ min: 1, max: 10_000 })),
  pageSize: v.optional(v.int({ min: 1, max: 200 })),
});

const computeDocumentPayload = v.object<{
  currency: string;
  lines: readonly unknown[];
}>({
  currency: v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
  lines: v.array(documentLinePayload, { min: 0, max: 200 }),
});

const paymentListPayload = v.object<{
  from?: string;
  to?: string;
  partnerType?: string;
  partnerId?: string;
  direction?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}>({
  from: v.optional(v.date()),
  to: v.optional(v.date()),
  partnerType: v.optional(v.enum(['customer', 'vendor'] as const)),
  partnerId: v.optional(v.uuid()),
  direction: v.optional(v.enum(['in', 'out'] as const)),
  q: v.optional(v.string({ max: 120 })),
  page: v.optional(v.int({ min: 1, max: 10_000 })),
  pageSize: v.optional(v.int({ min: 1, max: 200 })),
});

const fiscalYearPayload = v.object<{ fiscalYearId: string }>({ fiscalYearId: v.uuid() });

const perfGeneratePayload = v.object<{
  customers?: number;
  products?: number;
  invoices?: number;
  seed?: number;
}>({
  customers: v.optional(v.int({ min: 0, max: 20_000 })),
  products: v.optional(v.int({ min: 0, max: 20_000 })),
  invoices: v.optional(v.int({ min: 0, max: 50_000 })),
  seed: v.optional(v.int({ min: 0, max: 2_147_483_647 })),
});

const archiveBeforePayload = v.object<{ before: string }>({ before: v.date() });

const archiveRunPayload = v.object<{
  before: string;
  tables?: readonly string[];
  reason?: string;
  limit?: number;
}>({
  before: v.date(),
  tables: v.optional(v.array(v.string({ min: 2, max: 40 }), { max: 10 })),
  reason: v.optional(v.string({ max: 400 })),
  limit: v.optional(v.int({ min: 1, max: 50_000 })),
});

const searchPayload = v.object<{ q: string; limit?: number; kinds?: readonly string[] }>({
  q: v.string({ max: 120, allowEmpty: true, trim: false }),
  limit: v.optional(v.int({ min: 1, max: 50 })),
  kinds: v.optional(v.array(v.string({ min: 2, max: 40 }), { max: 12 })),
});

const searchPalettePayload = v.object<{ q: string }>({
  q: v.string({ max: 120, allowEmpty: true, trim: false }),
});

// ── T09 CRM ─────────────────────────────────────────────────────────────────

const crmBoardPayload = v.object<{
  pipelineId?: string;
  ownerId?: string;
  stageId?: string;
  closeFrom?: string;
  closeTo?: string;
  q?: string;
  perColumn?: number;
}>({
  pipelineId: v.optional(v.uuid()),
  ownerId: v.optional(v.uuid()),
  stageId: v.optional(v.uuid()),
  closeFrom: v.optional(v.date()),
  closeTo: v.optional(v.date()),
  q: v.optional(v.string({ max: 120 })),
  perColumn: v.optional(v.int({ min: 1, max: 200 })),
});

const crmMoveStagePayload = v.object<{ id: string; stageId: string; note?: string | null }>({
  id: v.uuid(),
  stageId: v.uuid(),
  note: v.nullable(v.string({ max: 400 })),
});

const crmCloseWonPayload = v.object<{ id: string; note?: string | null }>({
  id: v.uuid(),
  note: v.nullable(v.string({ max: 400 })),
});

const crmCloseLostPayload = v.object<{ id: string; reason: string; note?: string | null }>({
  id: v.uuid(),
  reason: v.string({ min: 1, max: 200, allowEmpty: false }),
  note: v.nullable(v.string({ max: 400 })),
});

/**
 * The conversion payload. Every branch is validated here as well as in the
 * service, because `objectValidator` copies declared keys only — a field missing
 * from this shape is dropped before the service ever sees it, and the account
 * would then be created with no name.
 */
const crmLeadConvertPayload = v.object<{
  leadId: string;
  account: unknown;
  contact: unknown;
  deal: unknown;
}>({
  leadId: v.uuid(),
  account: v.object<{ name: string; industry?: string | null; domain?: string | null; phone?: string | null; ownerId?: string | null; customerId?: string | null }>({
    name: v.string({ min: 1, max: 200, allowEmpty: false }),
    industry: v.nullable(v.string({ max: 120 })),
    domain: v.nullable(v.string({ max: 200 })),
    phone: v.nullable(v.string({ max: 40 })),
    ownerId: v.nullable(v.uuid()),
    customerId: v.nullable(v.uuid()),
  }),
  contact: v.object<{ firstName: string; lastName?: string | null; title?: string | null; email?: string | null; phone?: string | null; isPrimary?: boolean }>({
    firstName: v.string({ min: 1, max: 120, allowEmpty: false }),
    lastName: v.nullable(v.string({ max: 120 })),
    title: v.nullable(v.string({ max: 120 })),
    email: v.nullable(v.string({ max: 200 })),
    phone: v.nullable(v.string({ max: 40 })),
    isPrimary: v.optional(v.boolean()),
  }),
  deal: v.object<{ name: string; pipelineId: string; stageId?: string | null; valueCents: number; currency?: string; expectedCloseDate?: string | null; ownerId?: string | null }>({
    name: v.string({ min: 1, max: 200, allowEmpty: false }),
    pipelineId: v.uuid(),
    stageId: v.nullable(v.uuid()),
    valueCents: v.cents(),
    currency: v.optional(v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ })),
    expectedCloseDate: v.nullable(v.date()),
    ownerId: v.nullable(v.uuid()),
  }),
});

const crmTimelinePayload = v.object<{
  entity?: string;
  entityId?: string;
  openOnly?: boolean;
  from?: string;
  to?: string;
  ownerId?: string;
  limit?: number;
  offset?: number;
}>({
  entity: v.optional(v.string({ max: 40 })),
  entityId: v.optional(v.string({ max: 64 })),
  openOnly: v.optional(v.boolean()),
  from: v.optional(v.date()),
  to: v.optional(v.date()),
  ownerId: v.optional(v.uuid()),
  limit: v.optional(v.int({ min: 1, max: 200 })),
  offset: v.optional(v.int({ min: 0, max: 1_000_000 })),
});

const crmActivityPayload = v.object<{
  id?: string;
  type: string;
  subject: string;
  body?: string | null;
  entity: string;
  entityId: string;
  ownerId?: string | null;
  dueAt?: string | null;
}>({
  id: v.optional(v.uuid()),
  type: v.enum(['call', 'email', 'meeting', 'task', 'note', 'system'] as const),
  subject: v.string({ min: 1, max: 200, allowEmpty: false }),
  body: v.nullable(v.string({ max: 4000 })),
  entity: v.string({ min: 2, max: 40, allowEmpty: false }),
  entityId: v.string({ min: 1, max: 64, allowEmpty: false }),
  ownerId: v.nullable(v.uuid()),
  dueAt: v.nullable(v.timestamp()),
});

const crmActivityCompletePayload = v.object<{ id: string; done?: boolean }>({
  id: v.uuid(),
  done: v.optional(v.boolean()),
});

const crmPipelineSavePayload = v.object<{ id?: string; name: string; isDefault?: boolean }>({
  id: v.optional(v.uuid()),
  name: v.string({ min: 1, max: 120, allowEmpty: false }),
  isDefault: v.optional(v.boolean()),
});

const crmStageSavePayload = v.object<{
  id?: string;
  pipelineId: string;
  name: string;
  sortOrder?: number;
  probabilityBp: number;
  isWon?: boolean;
  isLost?: boolean;
  color?: string;
}>({
  id: v.optional(v.uuid()),
  pipelineId: v.uuid(),
  name: v.string({ min: 1, max: 120, allowEmpty: false }),
  sortOrder: v.optional(v.int({ min: 0, max: 999 })),
  probabilityBp: v.bp(),
  isWon: v.optional(v.boolean()),
  isLost: v.optional(v.boolean()),
  color: v.optional(v.enum(['info', 'accent', 'warning', 'success', 'danger', 'neutral'] as const)),
});

const crmStageReorderPayload = v.object<{ pipelineId: string; ids: readonly string[] }>({
  pipelineId: v.uuid(),
  ids: v.array(v.uuid(), { min: 1, max: 60 }),
});

const crmLossReasonSavePayload = v.object<{ id?: string; label: string; isActive?: boolean }>({
  id: v.optional(v.uuid()),
  label: v.string({ min: 1, max: 120, allowEmpty: false }),
  isActive: v.optional(v.boolean()),
});

const crmAnalyticsPayload = v.object<{ from: string; to: string; pipelineId?: string }>({
  from: v.date(),
  to: v.date(),
  pipelineId: v.optional(v.uuid()),
});

// ── T10 dashboard, admin ────────────────────────────────────────────────────

const dashboardPayload = v.object<{ period?: string; from?: string; to?: string }>({
  period: v.optional(v.enum(['month', 'quarter', 'ytd', 'custom'] as const)),
  from: v.optional(v.date()),
  to: v.optional(v.date()),
});

const recentPushPayload = v.object<{ id: string; title: string; subtitle: string; kind: string; route: string }>({
  id: v.string({ min: 1, max: 64, allowEmpty: false }),
  title: v.string({ min: 1, max: 200, allowEmpty: false }),
  subtitle: v.string({ max: 200 }),
  kind: v.string({ min: 2, max: 40, allowEmpty: false }),
  route: v.string({ min: 1, max: 300, allowEmpty: false }),
});

const auditDiffPayload = v.object<{ seq: number }>({ seq: v.int({ min: 1, max: 1_000_000_000 }) });

const backupRunPayload = v.object<{ directory: string }>({
  directory: v.string({ min: 1, max: 400, allowEmpty: false, trim: false }),
});

const backupListPayload = v.object<{ directory: string }>({
  directory: v.string({ max: 400, trim: false }),
});

const backupRestorePayload = v.object<{ path: string; skipSafetyCopy?: boolean }>({
  path: v.string({ min: 1, max: 400, allowEmpty: false, trim: false }),
  skipSafetyCopy: v.optional(v.boolean()),
});

const importEntityPayload = v.object<{ entity: string }>({
  entity: v.string({ min: 3, max: 40, allowEmpty: false }),
});

const importParsePayload = v.object<{ entity: string; path: string }>({
  entity: v.string({ min: 3, max: 40, allowEmpty: false }),
  path: v.string({ min: 1, max: 400, allowEmpty: false, trim: false }),
});

const importValidatePayload = v.object<{
  batchId: string;
  mapping: unknown;
  updateExisting?: boolean;
}>({
  batchId: v.uuid(),
  mapping: v.record<string>(),
  updateExisting: v.optional(v.boolean()),
});

const importCommitPayload = v.object<{ batchId: string }>({ batchId: v.uuid() });

const printablePayload = v.object<{ docType: string; id: string }>({
  docType: v.enum([
    'invoice',
    'bill',
    'quote',
    'purchase_order',
    'delivery_note',
    'credit_note',
    'statement',
  ] as const),
  id: v.string({ min: 1, max: 64, allowEmpty: false }),
});

const printableSavePayload = v.object<{ docType: string; id: string; path?: string }>({
  docType: v.enum([
    'invoice',
    'bill',
    'quote',
    'purchase_order',
    'delivery_note',
    'credit_note',
    'statement',
  ] as const),
  id: v.string({ min: 1, max: 64, allowEmpty: false }),
  path: v.optional(v.string({ max: 1000 })),
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
  page: v.optional(v.int({ min: 1, max: 10_000 })),
  pageSize: v.optional(v.int({ min: 1, max: 200 })),
} as const;

const opsListPayload = v.object<{
  q?: string;
  status?: string;
  from?: string;
  to?: string;
  productId?: string;
  locationId?: string;
  warehouseId?: string;
  customerId?: string;
  vendorId?: string;
  poId?: string;
  lowOnly?: boolean;
  page?: number;
  pageSize?: number;
}>({
  q: v.optional(v.string({ max: 120 })),
  status: v.optional(v.string({ max: 24 })),
  from: v.optional(v.date()),
  to: v.optional(v.date()),
  productId: v.optional(v.uuid()),
  locationId: v.optional(v.uuid()),
  warehouseId: v.optional(v.uuid()),
  customerId: v.optional(v.uuid()),
  vendorId: v.optional(v.uuid()),
  poId: v.optional(v.uuid()),
  lowOnly: v.optional(v.boolean()),
  ...opsPage,
});

const stockMovePayload = v.object<{
  type: string;
  productId: string;
  fromLocationId?: string;
  toLocationId?: string;
  qtyMilli: number;
  unitCostCents?: number;
  reason?: string;
  movedAt?: string;
  reference?: string;
  uom?: string;
  sourceType?: string;
  sourceId?: string;
  allowNegative?: boolean;
}>({
  type: v.enum(['receipt', 'issue', 'transfer', 'adjustment', 'production_in', 'production_out'] as const),
  productId: v.uuid(),
  fromLocationId: v.optional(v.uuid()),
  toLocationId: v.optional(v.uuid()),
  // Signed, and bounded so a fat-fingered quantity cannot overflow the cents maths.
  qtyMilli: v.int({ min: -1_000_000_000_000, max: 1_000_000_000_000 }),
  unitCostCents: v.optional(v.int({ min: 0, max: 1_000_000_000_000 })),
  reason: v.optional(v.string({ max: 500 })),
  movedAt: v.optional(v.date()),
  reference: v.optional(v.string({ max: 120 })),
  uom: v.optional(v.string({ max: 24 })),
  sourceType: v.optional(v.string({ max: 40 })),
  sourceId: v.optional(v.string({ max: 64 })),
  allowNegative: v.optional(v.boolean()),
});

const opsLinePayload = v.object<{
  productId?: string;
  description: string;
  qtyMilli: number;
  unitPriceCents: number;
  discountBp?: number;
  taxId?: string;
}>({
  productId: v.optional(v.uuid()),
  description: v.string({ min: 1, max: 500 }),
  qtyMilli: v.int({ min: 1, max: 1_000_000_000_000 }),
  unitPriceCents: v.int({ min: 0, max: 1_000_000_000_000 }),
  discountBp: v.optional(v.int({ min: 0, max: 10_000 })),
  taxId: v.optional(v.uuid()),
});

const poSavePayload = v.object<{
  id?: string;
  vendorId: string;
  date: string;
  expectedDate?: string;
  warehouseId?: string;
  notes?: string;
  lines: readonly unknown[];
}>({
  id: v.optional(v.uuid()),
  vendorId: v.uuid(),
  date: v.date(),
  expectedDate: v.optional(v.date()),
  warehouseId: v.optional(v.uuid()),
  notes: v.optional(v.string({ max: 2000 })),
  lines: v.array(opsLinePayload, { min: 1, max: 200 }),
});

const receiptSavePayload = v.object<{
  id?: string;
  poId?: string;
  vendorId: string;
  date: string;
  warehouseId: string;
  locationId?: string;
  notes?: string;
  lines: readonly unknown[];
}>({
  id: v.optional(v.uuid()),
  poId: v.optional(v.uuid()),
  vendorId: v.uuid(),
  date: v.date(),
  warehouseId: v.uuid(),
  locationId: v.optional(v.uuid()),
  notes: v.optional(v.string({ max: 2000 })),
  lines: v.array(
    v.object<{ poLineId?: string; productId: string; qtyMilli: number; unitCostCents?: number; lotRef?: string }>({
      poLineId: v.optional(v.uuid()),
      productId: v.uuid(),
      qtyMilli: v.int({ min: 1, max: 1_000_000_000_000 }),
      unitCostCents: v.optional(v.int({ min: 0, max: 1_000_000_000_000 })),
      lotRef: v.optional(v.string({ max: 120 })),
    }),
    { min: 1, max: 200 },
  ),
});

const quoteSavePayload = v.object<{
  id?: string;
  customerId: string;
  date: string;
  expiryDate: string;
  notes?: string;
  terms?: string;
  lines: readonly unknown[];
}>({
  id: v.optional(v.uuid()),
  customerId: v.uuid(),
  date: v.date(),
  expiryDate: v.date(),
  notes: v.optional(v.string({ max: 2000 })),
  terms: v.optional(v.string({ max: 2000 })),
  lines: v.array(opsLinePayload, { min: 1, max: 200 }),
});

const orderSavePayload = v.object<{
  id?: string;
  customerId: string;
  date: string;
  warehouseId?: string;
  notes?: string;
  terms?: string;
  quoteId?: string;
  lines: readonly unknown[];
}>({
  id: v.optional(v.uuid()),
  customerId: v.uuid(),
  date: v.date(),
  warehouseId: v.optional(v.uuid()),
  notes: v.optional(v.string({ max: 2000 })),
  terms: v.optional(v.string({ max: 2000 })),
  quoteId: v.optional(v.uuid()),
  lines: v.array(opsLinePayload, { min: 1, max: 200 }),
});

const deliverySavePayload = v.object<{
  id?: string;
  orderId?: string;
  customerId: string;
  date: string;
  warehouseId: string;
  notes?: string;
  lines: readonly unknown[];
}>({
  id: v.optional(v.uuid()),
  orderId: v.optional(v.uuid()),
  customerId: v.uuid(),
  date: v.date(),
  warehouseId: v.uuid(),
  notes: v.optional(v.string({ max: 2000 })),
  lines: v.array(
    v.object<{ soLineId?: string; productId: string; qtyMilli: number }>({
      soLineId: v.optional(v.uuid()),
      productId: v.uuid(),
      qtyMilli: v.int({ min: 1, max: 1_000_000_000_000 }),
    }),
    { min: 1, max: 200 },
  ),
});

const priceResolvePayload = v.object<{ productId: string; customerId: string; qtyMilli?: number; at?: string }>({
  productId: v.uuid(),
  customerId: v.uuid(),
  qtyMilli: v.optional(v.int({ min: 1, max: 1_000_000_000_000 })),
  at: v.optional(v.date()),
});

const overridePayload = v.object<{
  id: string;
  overrideExpiry?: boolean;
  overrideCredit?: boolean;
  reason?: string;
}>({
  id: v.uuid(),
  overrideExpiry: v.optional(v.boolean()),
  overrideCredit: v.optional(v.boolean()),
  reason: v.optional(v.string({ max: 500 })),
});

const statementPayload = v.object<{ vendorId: string; from: string; to: string }>({
  vendorId: v.uuid(),
  from: v.date(),
  to: v.date(),
});

const analysisPayload = v.object<{ groupBy: 'vendor' | 'product' | 'month'; from: string; to: string }>({
  groupBy: v.enum(['vendor', 'product', 'month'] as const),
  from: v.date(),
  to: v.date(),
});

const moveHistoryPayload = v.object<{ productId: string; locationId?: string; page?: number; pageSize?: number }>({
  productId: v.uuid(),
  locationId: v.optional(v.uuid()),
  ...opsPage,
});

const markInvoicedPayload = v.object<{
  orderId: string;
  invoiceId: string;
  lines: readonly unknown[];
}>({
  orderId: v.uuid(),
  invoiceId: v.uuid(),
  lines: v.array(
    v.object<{ productId?: string; qtyMilli: number }>({
      productId: v.optional(v.uuid()),
      qtyMilli: v.int({ min: 0, max: 1_000_000_000_000 }),
    }),
    { min: 0, max: 200 },
  ),
});

const uomSavePayload = v.object<{ productId?: string; fromUom: string; toUom: string; factorMilli: number }>({
  productId: v.optional(v.uuid()),
  fromUom: v.string({ min: 1, max: 24 }),
  toUom: v.string({ min: 1, max: 24 }),
  factorMilli: v.int({ min: 1, max: 1_000_000_000 }),
});

const pricelistSavePayload = v.object<{
  id?: string;
  name: string;
  currency?: string;
  validFrom?: string;
  validTo?: string;
  isDefault?: boolean;
  isActive?: boolean;
  items?: readonly unknown[];
}>({
  id: v.optional(v.uuid()),
  name: v.string({ min: 1, max: 120 }),
  currency: v.optional(v.string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ })),
  validFrom: v.optional(v.date()),
  validTo: v.optional(v.date()),
  isDefault: v.optional(v.boolean()),
  isActive: v.optional(v.boolean()),
  items: v.optional(
    v.array(
      v.object<{ productId: string; priceCents: number; minQtyMilli?: number }>({
        productId: v.uuid(),
        priceCents: v.int({ min: 0, max: 1_000_000_000_000 }),
        minQtyMilli: v.optional(v.int({ min: 0, max: 1_000_000_000_000 })),
      }),
      { max: 5000 },
    ),
  ),
});

/**
 * Payload validators keyed by channel. A channel with no entry accepts any
 * payload and relies on its handler — every channel added from T03 onwards must
 * register one here (CONVENTIONS §7 step 2).
 */
export const SCHEMAS: Partial<Record<Channel, Validator<unknown>>> = {
  'app.bootstrap': emptyObject,
  'app.quit': emptyObject,
  'app.prefs.save': prefsPayload,
  'auth.login': loginPayload,
  'auth.unlock': v.object<{ password: string }>({
    password: v.string({ min: 1, max: 200, allowEmpty: false, trim: false }),
  }),
  'auth.lock': emptyObject,
  'auth.logout': emptyObject,
  'auth.session': emptyObject,
  'auth.password.change': passwordChangePayload,
  'auth.heartbeat': heartbeatPayload,
  'onboarding.status': emptyObject,
  'onboarding.preview': v.object<{ presetId: string }>({ presetId: v.string({ min: 2, max: 40 }) }),
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
  'finance.coa.tree': v.object<{ includeArchived?: boolean }>({
    includeArchived: v.optional(v.boolean()),
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
  'backup.verify': v.object<{ path: string }>({ path: v.string({ min: 1, max: 400, allowEmpty: false, trim: false }) }),
  'backup.pickFolder': emptyObject,
  'crm.lead.convert': crmLeadConvertPayload,
  'crm.lead.convertPreview': crmLeadConvertPayload,
  'crm.deal.moveStage': crmMoveStagePayload,
  'crm.deal.closeWon': crmCloseWonPayload,
  'crm.deal.closeLost': crmCloseLostPayload,
  'crm.deal.board': crmBoardPayload,
  'crm.deal.get': idPayload,
  'crm.deal.fromWon': v.object<{ id: string; customerId: string }>({ id: v.uuid(), customerId: v.uuid() }),
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
  'inventory.stock.onHand': v.object<{ productId: string; locationId?: string }>({
    productId: v.uuid(),
    locationId: v.optional(v.uuid()),
  }),
  'inventory.stock.available': v.object<{ productId: string; locationId: string }>({
    productId: v.uuid(),
    locationId: v.uuid(),
  }),
  'inventory.moves.list': opsListPayload,
  'inventory.moves.post': stockMovePayload,
  'inventory.moves.reverse': idReasonPayload,
  'inventory.valuation': v.object<{ asOf?: string }>({ asOf: v.optional(v.date()) }),
  'inventory.quants.rebuild': emptyObject,
  'inventory.lowStock': emptyObject,
  'inventory.quants.list': opsListPayload,
  'inventory.moves.history': moveHistoryPayload,
  'inventory.aging': v.object<{ asOf?: string }>({ asOf: v.optional(v.date()) }),
  'inventory.stock.overview': v.object<{ groupBy?: string }>({ groupBy: v.optional(v.string({ max: 20 })) }),
  'inventory.uom.list': v.object<{ productId?: string }>({ productId: v.optional(v.uuid()) }),
  'inventory.uom.save': uomSavePayload,

  // ── T08 purchasing ─────────────────────────────────────────────────────────
  'purchasing.po.list': opsListPayload,
  'purchasing.po.get': idPayload,
  'purchasing.po.save': poSavePayload,
  'purchasing.po.confirm': idPayload,
  'purchasing.po.cancel': idReasonPayload,
  'purchasing.po.outstanding': v.object<{ vendorId?: string }>({ vendorId: v.optional(v.uuid()) }),
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
  'sales.order.availability': v.object<{ orderId: string }>({ orderId: v.uuid() }),
  'sales.order.invoice': idPayload,
  'sales.order.markInvoiced': markInvoicedPayload,
  'sales.delivery.list': opsListPayload,
  'sales.delivery.get': idPayload,
  'sales.delivery.create': deliverySavePayload,
  'sales.delivery.post': idPayload,
  'sales.customers.outstanding': v.object<{ customerId?: string }>({ customerId: v.optional(v.uuid()) }),
  'sales.pricelist.list': emptyObject,
  'sales.pricelist.items': idPayload,
  'sales.pricelist.saveItems': pricelistSavePayload,

  // ── the 3-way match preview that T06 declared but never implemented ───────
  'finance.bills.match': idPayload,
};

/** Validates a payload for a channel, falling back to "accept anything". */
export function validatePayload(channel: Channel, payload: unknown): Validated<unknown> {
  const validator = SCHEMAS[channel];
  if (!validator) return pass(payload);
  return validator.validate(payload, channel);
}
