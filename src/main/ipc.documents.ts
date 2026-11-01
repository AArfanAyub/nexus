/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Document channels: preview, save, print, export (T06).
 *
 * All four are registered as **read-only** in `channels.ts`: they write files,
 * not rows, so wrapping them in a database transaction would be a lie, and it
 * would also forbid the `await` that `printToPDF` requires (the dispatcher
 * rejects a promise from a mutating handler).
 */

import type { PrintableDocType } from '../shared/finance';
import type { EntityName } from '../shared/types';
import { validation } from './errors';
import { exportEntity, type ExportInput } from './ipc.entity';
import type { RegisterFn } from './ipc';
import { previewDocument, printDocument, saveDocumentPdf } from './services/documents';

const PRINTABLE: readonly PrintableDocType[] = [
  'invoice',
  'bill',
  'quote',
  'purchase_order',
  'delivery_note',
  'credit_note',
  'statement',
];

function docTypeOf(value: unknown): PrintableDocType {
  if (typeof value !== 'string' || !PRINTABLE.includes(value as PrintableDocType)) {
    throw validation('docType', 'That document type cannot be printed.');
  }
  return value as PrintableDocType;
}

/** Registers the document channels. */
export function registerDocumentChannels(register: RegisterFn): void {
  register<{ docType: string; id: string }, { html: string }>({
    channel: 'documents.pdf.preview',
    handler: (payload) => previewDocument(docTypeOf(payload.docType), payload.id),
  });

  register<{ docType: string; id: string; path?: string }, unknown>({
    channel: 'documents.pdf.save',
    handler: (payload) => saveDocumentPdf(docTypeOf(payload.docType), payload.id, payload.path ?? ''),
  });

  register<{ docType: string; id: string }, unknown>({
    channel: 'documents.print',
    handler: (payload) => printDocument(docTypeOf(payload.docType), payload.id),
  });

  register<ExportInput & { entity: EntityName }, unknown>({
    channel: 'documents.export',
    handler: (payload) => exportEntity(payload),
  });
}
