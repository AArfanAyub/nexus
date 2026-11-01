/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The five error types the main process is allowed to throw (CONVENTIONS §6).
 *
 * Lives in its own module rather than in `ipc.ts` so services and the licence
 * verifier can throw without importing the dispatcher (which imports them) —
 * `ipc.ts` re-exports everything here, so the documented import path still works.
 */

import type { ErrorCode } from '../shared/types';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

/** Payload shape problem. `details.field` names the offending field. */
export const validation = (field: string, message: string): AppError =>
  new AppError('VALIDATION', message, { field });

/** A record that the caller believes exists, does not. */
export const notFound = (what: string): AppError => new AppError('NOT_FOUND', `${what} not found`);

/** The session lacks the permission the channel declares. */
export const forbidden = (permission: string): AppError =>
  new AppError('FORBIDDEN', `You do not have permission to do this (${permission}).`, { permission });

/** The request is legal but the record is in the wrong state. */
export const conflict = (message: string): AppError => new AppError('CONFLICT', message);

/** No session, or the credentials are wrong. */
export const authRequired = (message = 'Please sign in to continue.'): AppError =>
  new AppError('AUTH_REQUIRED', message);

/** Licence problem: invalid signature, wrong machine, wrong edition. */
export const licenseError = (message: string): AppError => new AppError('LICENSE', message);

/** Narrowing helper for `catch` blocks. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
