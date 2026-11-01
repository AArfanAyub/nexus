/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Stock (T07, US-25…US-28, gap closure).
 *
 * Four views of the same ledger:
 *
 *   - **On hand** — a cache, rebuilt on demand. Never offers a quantity input:
 *     on-hand is derived, so the only way to change it is to post a move. That is
 *     why "Rebuild" is safe to offer at all — it throws the cache away and
 *     recomputes it from the moves.
 *   - **Ledger** — the moves themselves, with a *running balance*. The balance is
 *     the server's `runningMilli`, computed in the same ordered pass that
 *     produced the rows, so the last row always equals the on-hand figure on the
 *     first tab. Two independently-computed numbers that must agree is a bug
 *     waiting to happen; one number read twice is not.
 *   - **Valuation** — recomputed from moves and layers.
 *   - **Low stock** — at or below the reorder point.
 *
 * "New move" opens the wizard, which is the only write affordance on this screen
 * and the only place the sign convention lives.
 */

import { Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import type { LowStockRow, MoveHistoryRow, QuantRow, ValuationReport } from '@shared/ops';
import type { Paged } from '@shared/types';

import { MoveWizard } from '../../components/MoveWizard';
import { OpsTable, money, qty, type OpsColumn } from '../../components/OpsTable';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, Pagination, TableSkeleton } from '../../components/patterns';
import { Button, Chip, Segmented, Select } from '../../components/ui';
import { toast } from '../../lib/toast';
import { invoke, isApiError } from '../../lib/api';
import { date as fmtDate } from '../../lib/format';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useNewParam } from '../../lib/useNewParam';
import { useSession } from '../../store';

type Tab = 'onhand' | 'ledger' | 'valuation' | 'low';

interface ProductOption {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
}

const QUANT_COLUMNS: readonly OpsColumn<QuantRow>[] = [
  { key: 'sku', label: 'SKU', width: 'w-32', render: (row) => <span className="font-mono text-meta">{row.sku}</span> },
  { key: 'product', label: 'Product', render: (row) => <span className="text-text">{row.productName}</span> },
  {
    key: 'location',
    label: 'Location',
    width: 'w-48',
    render: (row) => (
      <span className="text-muted">
        {row.warehouseName} · {row.locationName}
      </span>
    ),
  },
  {
    key: 'qty',
    label: 'On hand',
    align: 'right',
    width: 'w-28',
    render: (row) => (
      <span className={row.isLow ? 'text-danger' : undefined}>
        {qty(row.qtyMilli)} {row.uom}
      </span>
    ),
  },
  { key: 'value', label: 'Value', align: 'right', width: 'w-28', render: (row) => money(row.valueCents) },
  {
    key: 'reorder',
    label: 'Reorder at',
    align: 'right',
    width: 'w-28',
    render: (row) => (row.reorderPointMilli > 0 ? qty(row.reorderPointMilli) : '—'),
  },
];

const LEDGER_COLUMNS: readonly OpsColumn<MoveHistoryRow>[] = [
  { key: 'date', label: 'Moved', width: 'w-28', render: (row) => fmtDate(row.movedAt.slice(0, 10)) },
  {
    key: 'type',
    label: 'Type',
    width: 'w-28',
    render: (row) => <Chip tone={row.type === 'receipt' || row.type === 'production_in' ? 'success' : row.type === 'adjustment' ? 'warning' : 'neutral'}>{row.type.replace(/_/g, ' ')}</Chip>,
  },
  {
    key: 'where',
    label: 'From → Into',
    render: (row) => (
      <span className="text-muted">
        {row.fromLocationName ?? '—'} <span aria-hidden="true">→</span> {row.toLocationName ?? '—'}
      </span>
    ),
  },
  {
    key: 'qty',
    label: 'Qty',
    align: 'right',
    width: 'w-28',
    render: (row) => (
      <span className={row.qtyMilli < 0 ? 'text-danger' : 'text-text'}>
        {row.qtyMilli > 0 ? '+' : ''}
        {qty(row.qtyMilli)} {row.uom}
      </span>
    ),
  },
  {
    key: 'balance',
    label: 'Balance',
    align: 'right',
    width: 'w-28',
    render: (row) => <span className="tnum text-text">{qty(row.runningMilli)}</span>,
  },
  { key: 'cost', label: 'Unit cost', align: 'right', width: 'w-28', render: (row) => money(row.unitCostCents) },
  { key: 'value', label: 'Value', align: 'right', width: 'w-28', render: (row) => money(row.valueCents) },
  { key: 'ref', label: 'Reference', width: 'w-40', render: (row) => <span className="text-meta text-muted">{row.reference ?? row.reason ?? '—'}</span> },
];

const LOW_COLUMNS: readonly OpsColumn<LowStockRow>[] = [
  { key: 'sku', label: 'SKU', width: 'w-32', render: (row) => <span className="font-mono text-meta">{row.sku}</span> },
  { key: 'product', label: 'Product', render: (row) => <span className="text-text">{row.productName}</span> },
  { key: 'onhand', label: 'On hand', align: 'right', width: 'w-28', render: (row) => qty(row.onHandMilli) },
  {
    key: 'reorder',
    label: 'Reorder at',
    align: 'right',
    width: 'w-28',
    render: (row) => qty(row.reorderPointMilli),
  },
  {
    key: 'short',
    label: 'Short by',
    align: 'right',
    width: 'w-28',
    render: (row) => <span className="text-danger">{qty(row.shortfallMilli)}</span>,
  },
];

const VALUATION_COLUMNS: readonly OpsColumn<ValuationReport['rows'][number]>[] = [
  { key: 'sku', label: 'SKU', width: 'w-32', render: (row) => <span className="font-mono text-meta">{row.sku}</span> },
  { key: 'product', label: 'Product', render: (row) => <span className="text-text">{row.productName}</span> },
  { key: 'method', label: 'Method', width: 'w-24', render: (row) => row.costMethod.toUpperCase() },
  { key: 'qty', label: 'On hand', align: 'right', width: 'w-28', render: (row) => qty(row.qtyMilli) },
  {
    key: 'unit',
    label: 'Unit cost',
    align: 'right',
    width: 'w-28',
    render: (row) => money(row.unitCostCents),
  },
  { key: 'value', label: 'Value', align: 'right', width: 'w-28', render: (row) => money(row.valueCents) },
];

const PAGE_SIZE = 50;

export function Stock(): JSX.Element {
  const canMove = useSession((state) => state.can('inventory.move.create'));
  const canRebuild = useSession((state) => state.can('inventory.stock.adjust'));

  const [tab, setTab] = useState<Tab>('onhand');
  const [lowOnly, setLowOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  useNewParam(() => setWizardOpen(true));

  // Ledger tab state
  const [productId, setProductId] = useState('');
  const [ledgerPage, setLedgerPage] = useState(1);

  const products = useQuery<readonly ProductOption[]>(
    'stock:products',
    () =>
      invoke<Paged<ProductOption>>('entity.list', {
        entity: 'products',
        limit: 200,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000, enabled: tab === 'ledger' },
  );

  const quantFetcher = useCallback(
    async ({ page, pageSize, q }: { page: number; pageSize: number; q?: string }) =>
      invoke<Paged<QuantRow>>('inventory.quants.list', { q, lowOnly, page, pageSize }),
    [lowOnly],
  );

  const ledger = useQuery<Paged<MoveHistoryRow>>(
    `stock:ledger:${productId}:${String(ledgerPage)}`,
    () =>
      invoke<Paged<MoveHistoryRow>>('inventory.moves.history', {
        productId,
        page: ledgerPage,
        pageSize: PAGE_SIZE,
      }),
    { staleMs: 10_000, enabled: tab === 'ledger' && productId !== '' },
  );

  const valuation = useQuery<ValuationReport>('ops:valuation', () => invoke<ValuationReport>('inventory.valuation', {}), {
    staleMs: 30_000,
    enabled: tab === 'valuation',
  });

  const low = useQuery<readonly LowStockRow[]>('ops:lowstock', () => invoke<readonly LowStockRow[]>('inventory.lowStock', {}), {
    staleMs: 30_000,
    enabled: tab === 'low',
  });

  const selectedProduct = useMemo(
    () => (products.data ?? []).find((row) => row.id === productId),
    [products.data, productId],
  );

  async function rebuild(): Promise<void> {
    setBusy(true);
    try {
      const result = await invoke<{ rows: number; moves: number }>('inventory.quants.rebuild', {});
      invalidate('ops:');
      invalidate('inventory:');
      toast.success('Stock rebuilt', `${String(result.rows)} balances recomputed from ${String(result.moves)} moves.`);
    } catch (caught) {
      toast.error('Could not rebuild stock', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  const tabs = (
    <Segmented
      ariaLabel="Stock view"
      value={tab}
      onChange={(value) => setTab(value as Tab)}
      options={[
        { value: 'onhand', label: 'On hand' },
        { value: 'ledger', label: 'Ledger' },
        { value: 'valuation', label: 'Valuation' },
        { value: 'low', label: 'Low stock' },
      ]}
    />
  );

  const newMove = canMove ? (
    <Button variant="primary" iconLeft={<Plus size={14} />} onClick={() => setWizardOpen(true)}>
      New move
    </Button>
  ) : null;

  const wizard = (
    <MoveWizard
      open={wizardOpen}
      onOpenChange={setWizardOpen}
      productId={tab === 'ledger' && productId !== '' ? productId : undefined}
      onPosted={() => {
        invalidate('ops:');
        invalidate('inventory:');
      }}
    />
  );

  if (tab === 'valuation') {
    return (
      <>
        <OpsTable<ValuationReport['rows'][number]>
          title="Stock valuation"
          subtitle="Recomputed from the ledger — the on-hand cache is not trusted for money."
          countLabel="products"
          queryKey="ops:valuation-table"
          fetcher={async () => ({ rows: valuation.data?.rows ?? [], total: valuation.data?.rows.length ?? 0 })}
          columns={VALUATION_COLUMNS}
          rowKey={(row) => row.productId}
          emptyTitle={valuation.loading ? 'Valuing stock…' : 'Nothing on hand'}
          emptyHint="Receive stock and it will appear here, valued by its cost method."
          primaryAction={newMove}
          secondaryActions={
            <>
              {tabs}
              <span className="tnum text-meta text-muted">Total {money(valuation.data?.totalValueCents ?? 0)}</span>
            </>
          }
        />
        {wizard}
      </>
    );
  }

  if (tab === 'low') {
    return (
      <>
        <OpsTable<LowStockRow>
          title="Low stock"
          subtitle="Products at or below their reorder point."
          countLabel="products"
          queryKey="ops:lowstock-table"
          fetcher={async () => ({ rows: low.data ?? [], total: low.data?.length ?? 0 })}
          columns={LOW_COLUMNS}
          rowKey={(row) => row.productId}
          emptyTitle={low.loading ? 'Checking levels…' : 'Everything is above its reorder point'}
          emptyHint="Set a reorder point on a product to be warned before it runs out."
          primaryAction={newMove}
          secondaryActions={tabs}
        />
        {wizard}
      </>
    );
  }

  if (tab === 'ledger') {
    const rows = ledger.data?.rows ?? [];
    const total = ledger.data?.total ?? 0;
    const closing = rows.length > 0 ? (rows[0]?.runningMilli ?? 0) : 0;

    return (
      <div className="flex h-full min-h-0 flex-col">
        <PageHeader
          title="Stock ledger"
          subtitle={
            productId === ''
              ? 'Choose a product to see every move behind its balance.'
              : `${selectedProduct?.sku ?? ''} · balance after the newest move on this page: ${qty(closing)} ${selectedProduct ? '' : ''}`
          }
          count={productId === '' ? undefined : total}
          countLabel="moves"
          primaryAction={newMove}
          secondaryActions={tabs}
          toolbar={
            <Select
              aria-label="Product"
              value={productId}
              placeholder="Choose a product"
              options={(products.data ?? []).map((row) => ({ value: row.id, label: `${row.sku} · ${row.name}` }))}
              onChange={(event) => {
                setProductId(event.target.value);
                setLedgerPage(1);
              }}
              className="h-8 w-64"
            />
          }
        />
        <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
          {productId === '' ? (
            <EmptyState
              title="No product selected"
              description="The ledger is per product: a running balance only means something for one item at one location."
            />
          ) : ledger.loading && rows.length === 0 ? (
            <TableSkeleton rows={10} columns={8} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No moves for this product"
              description="Receive it, issue it, or adjust it and the ledger will start here."
              action={newMove}
            />
          ) : (
            <>
              <table className="w-full border-separate border-spacing-0 text-body" aria-label="Stock ledger">
                <thead>
                  <tr>
                    {LEDGER_COLUMNS.map((column) => (
                      <th
                        key={column.key}
                        scope="col"
                        className={`micro sticky top-0 z-10 border-b border-border bg-surface px-3 py-2 ${
                          column.align === 'right' ? 'text-right' : 'text-left'
                        } ${column.width ?? ''}`}
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-border/60">
                      {LEDGER_COLUMNS.map((column) => (
                        <td
                          key={column.key}
                          className={`truncate px-3 py-2 ${column.align === 'right' ? 'text-right tnum' : 'text-left'}`}
                        >
                          {column.render(row)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={ledgerPage} pageSize={PAGE_SIZE} total={total} onPage={setLedgerPage} />
            </>
          )}
        </div>
        {wizard}
      </div>
    );
  }

  return (
    <>
      <OpsTable<QuantRow>
        title="Stock on hand"
        subtitle="Derived from posted moves. Rebuild to recompute the cache."
        countLabel="balances"
        queryKey="ops:stock"
        fetcher={quantFetcher}
        columns={QUANT_COLUMNS}
        rowKey={(row) => `${row.productId}:${row.locationId}`}
        searchPlaceholder="Search SKU or product"
        emptyTitle="Nothing on hand"
        emptyHint="Post a receipt or a stock adjustment and the balance appears here."
        primaryAction={newMove}
        secondaryActions={
          <>
            {tabs}
            <Chip tone={lowOnly ? 'accent' : 'neutral'}>
              <button type="button" onClick={() => setLowOnly((value) => !value)} aria-pressed={lowOnly}>
                Low only
              </button>
            </Chip>
            {canRebuild ? (
              <Button variant="secondary" loading={busy} onClick={() => void rebuild()}>
                Rebuild
              </Button>
            ) : null}
          </>
        }
      />
      {wizard}
    </>
  );
}
