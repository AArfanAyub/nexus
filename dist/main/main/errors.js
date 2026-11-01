"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.licenseError = exports.authRequired = exports.conflict = exports.forbidden = exports.notFound = exports.validation = exports.AppError = void 0;
exports.isAppError = isAppError;
class AppError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = 'AppError';
        this.code = code;
        this.details = details;
    }
}
exports.AppError = AppError;
/** Payload shape problem. `details.field` names the offending field. */
const validation = (field, message) => new AppError('VALIDATION', message, { field });
exports.validation = validation;
/** A record that the caller believes exists, does not. */
const notFound = (what) => new AppError('NOT_FOUND', `${what} not found`);
exports.notFound = notFound;
/** The session lacks the permission the channel declares. */
const forbidden = (permission) => new AppError('FORBIDDEN', `You do not have permission to do this (${permission}).`, { permission });
exports.forbidden = forbidden;
/** The request is legal but the record is in the wrong state. */
const conflict = (message) => new AppError('CONFLICT', message);
exports.conflict = conflict;
/** No session, or the credentials are wrong. */
const authRequired = (message = 'Please sign in to continue.') => new AppError('AUTH_REQUIRED', message);
exports.authRequired = authRequired;
/** Licence problem: invalid signature, wrong machine, wrong edition. */
const licenseError = (message) => new AppError('LICENSE', message);
exports.licenseError = licenseError;
/** Narrowing helper for `catch` blocks. */
function isAppError(error) {
    return error instanceof AppError;
}
//# sourceMappingURL=errors.js.map