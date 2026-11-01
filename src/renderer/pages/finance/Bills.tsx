/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Bills (T06).
 *
 * Same list and editor as invoices, with the vendor side of the ledger: a posted
 * bill debits expense and input tax and credits accounts payable, and it carries
 * the supplier's own reference so a three-way match can find it later.
 */

import { DocumentList } from './DocumentList';

export function Bills(): JSX.Element {
  return <DocumentList docType="bill" />;
}
