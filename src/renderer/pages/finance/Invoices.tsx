/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Invoices (T06).
 *
 * The route is a thin switch between the list and the editor, because both live
 * at `/finance/invoices` with the record in the query string (`?id=`, `?new=1`).
 * Keeping them on one route means the back button returns to the list *with its
 * filters intact* instead of to a bare page.
 */

import { DocumentList } from './DocumentList';

export function Invoices(): JSX.Element {
  return <DocumentList docType="invoice" />;
}
