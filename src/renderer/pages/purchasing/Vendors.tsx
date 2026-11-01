/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Vendors (T08, US-32, gap closure).
 *
 * Terms days drive the default bill due date, so they are a column rather than a
 * detail: "Net 30" is the single most-queried fact about a supplier.
 *
 * The create/edit dialog is the shared `RecordFormModal`. A vendor has twelve
 * columns and this screen needs to set nine of them; a bespoke form would be a
 * ninth place for the "terms are a number of days, not a date" rule to be
 * re-implemented slightly wrong.
 */

import { Plus } from 'lucide-react';
import { useCallback, useState } from 'react';

import type { Paged } from '@shared/types';

import { OpsTable, type OpsColumn } from '../../components/OpsTable';
import { RecordFormModal, type RecordField } from '../../components/RecordForm';
import { Button } from '../../components/ui';
import { invoke } from '../../lib/api';
import { useNewParam } from '../../lib/useNewParam';
import { useSession } from '../../store';

interface VendorRow {
  readonly id: string;
  readonly code: string | null;
  readonly name: string;
  readonly payment_terms_days: number;
  readonly currency: string | null;
  readonly tax_id: string | null;
  readonly email: string | null;
  readonly is_active: number;
}

const FIELDS: readonly RecordField[] = [
  { key: 'code', label: 'Code', kind: 'text', placeholder: 'ACME', help: 'Optional, but unique when set.' },
  { key: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'Acme Supplies Ltd' },
  { key: 'legal_name', label: 'Legal name', kind: 'text', span: 2 },
  { key: 'email', label: 'Email', kind: 'text', placeholder: 'accounts@acme.example' },
  { key: 'phone', label: 'Phone', kind: 'text' },
  { key: 'tax_id', label: 'Tax id', kind: 'text', placeholder: 'VAT number' },
  {
    key: 'payment_terms_days',
    label: 'Payment terms (days)',
    kind: 'number',
    help: '0 means due on receipt. This sets every bill due date.',
  },
  {
    key: 'currency',
    label: 'Currency',
    kind: 'select',
    options: [
      { value: 'USD', label: 'USD' },
      { value: 'EUR', label: 'EUR' },
      { value: 'GBP', label: 'GBP' },
    ],
    help: 'Leave blank to bill in the base currency.',
  },
  { key: 'notes', label: 'Notes', kind: 'textarea', span: 2 },
  { key: 'is_active', label: 'Active', kind: 'checkbox', help: 'Active — selectable on a purchase order' },
];

const COLUMNS: readonly OpsColumn<VendorRow>[] = [
  { key: 'code', label: 'Code', width: 'w-24', render: (row) => <span className="font-mono text-meta">{row.code ?? '—'}</span> },
  { key: 'name', label: 'Vendor', render: (row) => <span className="text-text">{row.name}</span> },
  {
    key: 'terms',
    label: 'Terms',
    width: 'w-28',
    render: (row) => (row.payment_terms_days === 0 ? 'Due on receipt' : `Net ${String(row.payment_terms_days)}`),
  },
  { key: 'currency', label: 'Currency', width: 'w-24', render: (row) => row.currency ?? 'Base' },
  { key: 'tax', label: 'Tax id', width: 'w-40', render: (row) => row.tax_id ?? '—' },
  { key: 'active', label: 'Status', width: 'w-24', render: (row) => (Number(row.is_active) === 1 ? 'Active' : 'Archived') },
];

export function Vendors(): JSX.Element {
  const canWrite = useSession((state) => state.can('purchasing.vendor.write'));
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<VendorRow | null>(null);
  const [reload, setReload] = useState(0);
  useNewParam(() => {
    setEditing(null);
    setOpen(true);
  });

  const fetcher = useCallback(
    async ({ page, pageSize, q }: { page: number; pageSize: number; q?: string }) => {
      return invoke<Paged<VendorRow>>('entity.list', {
        entity: 'vendors',
        q,
        sort: { key: 'name', dir: 'asc' },
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
    },
    [reload],
  );

  return (
    <>
      <OpsTable<VendorRow>
        title="Vendors"
        subtitle="Payment terms decide each bill's due date."
        countLabel="vendors"
        queryKey={`ops:vendors:${String(reload)}`}
        fetcher={fetcher}
        columns={COLUMNS}
        rowKey={(row) => row.id}
        searchPlaceholder="Search vendor"
        emptyTitle="No vendors yet"
        emptyHint="Add a vendor before raising a purchase order."
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
              New vendor
            </Button>
          ) : null
        }
        onRowClick={
          canWrite
            ? (row) => {
                setEditing(row);
                setOpen(true);
              }
            : undefined
        }
      />

      <RecordFormModal
        open={open}
        onOpenChange={setOpen}
        entity="vendors"
        title="Vendor"
        description="Terms are a number of days, not a date — the due date is computed per bill."
        fields={FIELDS}
        initial={editing}
        defaults={{ is_active: 1, payment_terms_days: 30 }}
        invalidatePrefixes={['ops:', 'pb:', 'search:']}
        onSaved={() => setReload((value) => value + 1)}
      />
    </>
  );
}
