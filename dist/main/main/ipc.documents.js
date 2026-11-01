"use strict";
/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDocumentChannels = registerDocumentChannels;
const errors_1 = require("./errors");
const ipc_entity_1 = require("./ipc.entity");
const documents_1 = require("./services/documents");
const PRINTABLE = [
    'invoice',
    'bill',
    'quote',
    'purchase_order',
    'delivery_note',
    'credit_note',
    'statement',
];
function docTypeOf(value) {
    if (typeof value !== 'string' || !PRINTABLE.includes(value)) {
        throw (0, errors_1.validation)('docType', 'That document type cannot be printed.');
    }
    return value;
}
/** Registers the document channels. */
function registerDocumentChannels(register) {
    register({
        channel: 'documents.pdf.preview',
        handler: (payload) => (0, documents_1.previewDocument)(docTypeOf(payload.docType), payload.id),
    });
    register({
        channel: 'documents.pdf.save',
        handler: (payload) => (0, documents_1.saveDocumentPdf)(docTypeOf(payload.docType), payload.id, payload.path ?? ''),
    });
    register({
        channel: 'documents.print',
        handler: (payload) => (0, documents_1.printDocument)(docTypeOf(payload.docType), payload.id),
    });
    register({
        channel: 'documents.export',
        handler: (payload) => (0, ipc_entity_1.exportEntity)(payload),
    });
}
//# sourceMappingURL=ipc.documents.js.map