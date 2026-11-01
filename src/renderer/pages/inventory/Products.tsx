/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Products (T07, US-24/US-28) — list, create, edit.
 *
 * The columns are the ones that decide whether stock works: the cost method
 * (because it decides how COGS is valued), the reorder point (because it decides
 * the low-stock flag) and the margin, which is what a salesperson looks at.
 *
 * Create and edit share one `RecordFormModal`, driven by the field spec below.
 */

import { useCallback, useState } from 'react';

import type { Paged } from '@shared/types';

import { OpsTable, money, qty, type OpsColumn } from '../../components/OpsTable';
import { RecordFormModal, type RecordField } from '../../components/RecordForm';
import { Button } from '../../components/ui';
import { invoke } from '../../lib/api';
import { useNewParam } from '../../lib/useNewParam';

interface ProductRow {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly uom: string;
  readonly cost_method: string;
  readonly base_price_cents: number;
  readonly standard_cost_cents: number;
  readonly reorder_point_milli: number;
  readonly is_stock_tracked: number;
  readonly is_active: number;
}

const FIELDS: readonly RecordField[] = [
  { key: 'sku', label: 'SKU', kind: 'text', required: true, help: 'Must be unique.' },
  { key: 'name', label: 'Name', kind: 'text', required: true },
  { key: 'uom', label: 'Unit of measure', kind: 'text', placeholder: 'unit, kg, box' },
  {
    key: 'cost_method',
    label: 'Cost method',
    kind: 'select',
    help: 'FIFO keeps cost layers; average re-averages on every receipt.',
    options: [
      { value: 'avco', label: 'Moving average' },
      { value: 'fifo', label: 'FIFO' },
      { value: 'standard', label: 'Standard cost' },
    ],
  },
  { key: 'base_price_cents', label: 'Sale price', kind: 'money' },
  { key: 'standard_cost_cents', label: 'Cost', kind: 'money' },
  { key: 'reorder_point_milli', label: 'Reorder point', kind: 'quantity', help: 'In stock units.' },
  { key: 'is_stock_tracked', label: 'Track stock', kind: 'checkbox', help: 'Turn off for services.' },
  { key: 'is_active', label: 'Active', kind: 'checkbox' },
];

const COLUMNS: readonly OpsColumn<ProductRow>[] = [
  { key: 'sku', label: 'SKU', width: 'w-32', render: (row) => <span className="font-mono text-meta">{row.sku}</span> },
  { key: 'name', label: 'Product', render: (row) => <span className="text-text">{row.name}</span> },
  { key: 'uom', label: 'UoM', width: 'w-20', render: (row) => row.uom },
  { key: 'cost', label: 'Cost method', width: 'w-28', render: (row) => row.cost_method.toUpperCase() },
  { key: 'price', label: 'List price', align: 'right', width: 'w-28', render: (row) => money(row.base_price_cents) },
  {
    key: 'margin',
    label: 'Margin',
    align: 'right',
    width: 'w-24',
    render: (row) => {
      if (row.base_price_cents <= 0) return '—';
      const margin = ((row.base_price_cents - row.standard_cost_cents) / row.base_price_cents) * 100;
      return `${margin.toFixed(1)} %`;
    },
  },
  {
    key: 'reorder',
    label: 'Reorder at',
    align: 'right',
    width: 'w-28',
    render: (row) => (row.reorder_point_milli > 0 ? qty(row.reorder_point_milli) : '—'),
  },
  {
    key: 'active',
    label: 'Status',
    width: 'w-24',
    render: (row) => (Number(row.is_active) === 1 ? 'Active' : 'Archived'),
  },
];

export function Products(): JSX.Element {
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [creating, setCreating] = useState(false);
  // `⌘K → New product` arrives as `?new=1`; the page owns the dialog, so the
  // palette only ever has to navigate.
  useNewParam(() => {
    setEditing(null);
    setCreating(true);
  });

  const fetcher = useCallback(async ({ page, pageSize, q }: { page: number; pageSize: number; q?: string }) => {
    const result = await invoke<Paged<ProductRow>>('entity.list', {
      entity: 'products',
      q,
      sort: { key: 'name', dir: 'asc' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return result;
  }, []);

  return (
    <>
      <OpsTable<ProductRow>
        title="Products"
        subtitle="Cost method decides how every issue is valued."
        countLabel="products"
        queryKey="ops:products"
        fetcher={fetcher}
        columns={COLUMNS}
        rowKey={(row) => row.id}
        onRowClick={(row) => setEditing(row)}
        searchPlaceholder="Search SKU or name"
        emptyTitle="No products yet"
        emptyHint="Create one here, or import a price list from Settings → Data."
        primaryAction={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            New product
          </Button>
        }
      />

      <RecordFormModal
        open={creating}
        onOpenChange={setCreating}
        entity="products"
        title="Product"
        description="Stock-tracked products appear on the stock ledger; services do not."
        fields={FIELDS}
        defaults={{ is_active: 1, is_stock_tracked: 1, cost_method: 'avco', uom: 'unit' }}
      />
      <RecordFormModal
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        entity="products"
        title="Product"
        fields={FIELDS}
        initial={editing}
      />
    </>
  );
}
