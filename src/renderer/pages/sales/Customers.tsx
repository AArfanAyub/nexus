/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Customers with their live credit position (T08, US-37, gap closure).
 *
 * Outstanding is computed from the invoices, not stored on the customer — the same
 * rule as every other derived figure in this product. That means the create/edit
 * dialog can set a credit *limit* but never a balance, and the column that shows
 * the balance is read-only by construction.
 */

import { Plus } from 'lucide-react';
import { useCallback, useState } from 'react';

import type { CustomerOutstanding } from '@shared/ops';

import { OpsTable, money, type OpsColumn } from '../../components/OpsTable';
import { RecordFormModal, type RecordField } from '../../components/RecordForm';
import { Button } from '../../components/ui';
import { invoke } from '../../lib/api';
import { useNewParam } from '../../lib/useNewParam';
import { useSession } from '../../store';

const FIELDS: readonly RecordField[] = [
  { key: 'code', label: 'Code', kind: 'text', placeholder: 'ACME-01', help: 'Optional, but unique when set.' },
  { key: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'Acme Corporation' },
  { key: 'legal_name', label: 'Legal name', kind: 'text', span: 2 },
  { key: 'email', label: 'Email', kind: 'text', placeholder: 'ap@acme.example' },
  { key: 'phone', label: 'Phone', kind: 'text' },
  { key: 'tax_id', label: 'Tax id', kind: 'text' },
  {
    key: 'payment_terms_days',
    label: 'Payment terms (days)',
    kind: 'number',
    help: '0 means due on receipt. This sets every invoice due date.',
  },
  { key: 'credit_limit_cents', label: 'Credit limit', kind: 'money', help: '0 means no limit is enforced.' },
  {
    key: 'currency',
    label: 'Currency',
    kind: 'select',
    options: [
      { value: 'USD', label: 'USD' },
      { value: 'EUR', label: 'EUR' },
      { value: 'GBP', label: 'GBP' },
    ],
    help: 'Leave blank to invoice in the base currency.',
  },
  { key: 'notes', label: 'Notes', kind: 'textarea', span: 2 },
  { key: 'is_active', label: 'Active', kind: 'checkbox', help: 'Active — selectable on a quotation or order' },
];

const COLUMNS: readonly OpsColumn<CustomerOutstanding>[] = [
  { key: 'name', label: 'Customer', render: (row) => <span className="text-text">{row.name}</span> },
  {
    key: 'terms',
    label: 'Terms',
    width: 'w-28',
    render: (row) => (row.termsDays === 0 ? 'Due on receipt' : `Net ${String(row.termsDays)}`),
  },
  { key: 'outstanding', label: 'Outstanding', align: 'right', width: 'w-32', render: (row) => money(row.outstandingCents) },
  {
    key: 'overdue',
    label: 'Overdue',
    align: 'right',
    width: 'w-32',
    render: (row) => (row.overdueCents > 0 ? <span className="text-danger">{money(row.overdueCents)}</span> : '—'),
  },
  {
    key: 'limit',
    label: 'Credit limit',
    align: 'right',
    width: 'w-32',
    render: (row) => (row.creditLimitCents > 0 ? money(row.creditLimitCents) : 'None'),
  },
  {
    key: 'state',
    label: 'Status',
    width: 'w-32',
    render: (row) => (row.overLimit ? <span className="text-danger">Over limit</span> : `${String(row.openCount)} open`),
  },
];

export function Customers(): JSX.Element {
  const canWrite = useSession((state) => state.can('sales.customer.write'));
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [reload, setReload] = useState(0);
  useNewParam(() => {
    setEditing(null);
    setOpen(true);
  });

  const fetcher = useCallback(
    async ({ page, pageSize }: { page: number; pageSize: number }) => {
      const rows = await invoke<readonly CustomerOutstanding[]>('sales.customers.outstanding', {});
      return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
    },
    [reload],
  );

  /**
   * The list is `CustomerOutstanding`, which does not carry the columns the form
   * edits. Editing therefore re-reads the customer through `entity.get` rather
   * than guessing which fields the list happened to include.
   */
  async function edit(row: CustomerOutstanding): Promise<void> {
    try {
      const record = await invoke<Record<string, unknown>>('entity.get', { entity: 'customers', id: row.customerId });
      setEditing(record);
      setOpen(true);
    } catch {
      setEditing(null);
      setOpen(true);
    }
  }

  return (
    <>
      <OpsTable<CustomerOutstanding>
        title="Customers"
        subtitle="Outstanding and overdue are computed from the invoice ledger."
        countLabel="customers"
        queryKey={`ops:customers:${String(reload)}`}
        fetcher={fetcher}
        columns={COLUMNS}
        rowKey={(row) => row.customerId}
        emptyTitle="No customers yet"
        emptyHint="Add a customer before raising a quotation."
        primaryAction={
          canWrite ? (
            <Button
              variant="primary"
              iconLeft={<Plus size={14} />}
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              New customer
            </Button>
          ) : null
        }
        onRowClick={canWrite ? (row) => void edit(row) : undefined}
      />

      <RecordFormModal
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setEditing(null);
        }}
        entity="customers"
        title="Customer"
        description="Terms are a number of days; the credit limit is a ceiling, not a balance."
        fields={FIELDS}
        initial={editing}
        defaults={{ is_active: 1, payment_terms_days: 30 }}
        invalidatePrefixes={['ops:', 'search:']}
        onSaved={() => setReload((value) => value + 1)}
      />
    </>
  );
}
