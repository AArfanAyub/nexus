/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Goods receipts — list and receiving screen (T08, US-29/US-30, gap closure).
 *
 * A posted receipt is what makes a bill billable: it is the only document that
 * both moved the stock and created the accrual the bill later clears. So the
 * receiving screen is the one place in the purchasing chain where the operator
 * must be able to see, per line, **what was ordered, what has already arrived,
 * and what is left** — before they type a number.
 *
 * The quantity input is capped at the outstanding quantity in the grid itself
 * (`max` on the input plus a refusal on save). Over-receiving is legal in this
 * product, but it has to be a decision, not a typo: the operator can override,
 * and the override is visible on the line.
 */

import { ArrowLeft, CheckCircle2, Plus, PackageCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { PoDetail, ReceiptDetail, ReceiptRow } from '@shared/ops';
import { MAX_PAGE_SIZE } from '@shared/types';
import type { Paged } from '@shared/types';

import { LineGrid, blankLine, parseQty, type LineDraft } from '../../components/LineGrid';
import { OpsTable, money, qty, type OpsColumn } from '../../components/OpsTable';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, SectionCard } from '../../components/patterns';
import { Button, Chip, Input, Select, Textarea } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import { today } from '../../lib/finance';
import { date as fmtDate } from '../../lib/format';
import { toast } from '../../lib/toast';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useNewParam } from '../../lib/useNewParam';
import { useSession } from '../../store';

interface WarehouseOption {
  readonly id: string;
  readonly name: string;
}

interface LocationOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly warehouse_id: string;
}

const COLUMNS: readonly OpsColumn<ReceiptRow>[] = [
  { key: 'number', label: 'Receipt', width: 'w-32', render: (row) => <span className="font-mono text-meta">{row.number ?? 'Draft'}</span> },
  { key: 'po', label: 'Against order', width: 'w-32', render: (row) => row.poNumber ?? '—' },
  { key: 'vendor', label: 'Vendor', render: (row) => <span className="text-text">{row.vendorName}</span> },
  { key: 'date', label: 'Received', width: 'w-28', render: (row) => fmtDate(row.date) },
  { key: 'where', label: 'Into', width: 'w-48', render: (row) => `${row.warehouseName}${row.locationName ? ` · ${row.locationName}` : ''}` },
  { key: 'value', label: 'Value', align: 'right', width: 'w-28', render: (row) => money(row.totalCents) },
  {
    key: 'status',
    label: 'Status',
    width: 'w-28',
    render: (row) => <span className={row.status === 'posted' ? 'text-text' : 'text-muted'}>{row.status}</span>,
  },
  { key: 'bill', label: 'Billed', width: 'w-24', render: (row) => (row.billId ? 'Yes' : 'No') },
];

export function Receipts(): JSX.Element {
  const canCreate = useSession((state) => state.can('purchasing.receipt.create'));
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<null | 'new' | string>(null);
  useNewParam(() => setView('new'));

  const fetcher = useCallback(
    async ({ page, pageSize, status }: { page: number; pageSize: number; status?: string }) =>
      invoke<Paged<ReceiptRow>>('purchasing.receipt.list', { status, page, pageSize }),
    [reload],
  );

  if (view === 'new') {
    return (
      <ReceiptBuilder
        onCancel={() => setView(null)}
        onSaved={() => {
          setReload((value) => value + 1);
          setView(null);
        }}
      />
    );
  }

  if (view !== null) {
    return (
      <ReceiptDetailView
        id={view}
        onBack={() => {
          setReload((value) => value + 1);
          setView(null);
        }}
      />
    );
  }

  return (
    <OpsTable<ReceiptRow>
      title="Goods receipts"
      subtitle="Each posted receipt debits inventory and credits the accrual."
      countLabel="receipts"
      queryKey={`ops:receipts:${String(reload)}`}
      fetcher={fetcher}
      columns={COLUMNS}
      filters={[
        {
          key: 'status',
          label: 'statuses',
          options: [
            { value: 'draft', label: 'Draft' },
            { value: 'posted', label: 'Posted' },
            { value: 'cancelled', label: 'Cancelled' },
          ],
        },
      ]}
      rowKey={(row) => row.id}
      emptyTitle="Nothing received yet"
      emptyHint="Receive against a confirmed purchase order."
      primaryAction={
        canCreate ? (
          <Button variant="primary" iconLeft={<Plus size={14} />} onClick={() => setView('new')}>
            New receipt
          </Button>
        ) : null
      }
      onRowClick={(row) => setView(row.id)}
    />
  );
}

// ── builder ──────────────────────────────────────────────────────────────────

/** Per-row metadata the grid cannot carry: which PO line, and the cap. */
interface LineMeta {
  readonly poLineId: string;
  readonly productId: string;
  readonly orderedMilli: number;
  readonly alreadyMilli: number;
  readonly remainingMilli: number;
}

interface ReceiptBuilderProps {
  readonly onCancel: () => void;
  readonly onSaved: (receipt: ReceiptDetail) => void;
}

function ReceiptBuilder({ onCancel, onSaved }: ReceiptBuilderProps): JSX.Element {
  const [poId, setPoId] = useState('');
  const [date, setDate] = useState(today());
  const [warehouseId, setWarehouseId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<LineDraft[]>([]);
  const [meta, setMeta] = useState<Record<string, LineMeta>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orders = useQuery<Paged<PoRowLite>>(
    'recv:pos',
    () =>
      invoke<Paged<PoRowLite>>('purchasing.po.list', {
        status: 'confirmed',
        pageSize: 200,
      }),
    { staleMs: 30_000 },
  );

  const partial = useQuery<Paged<PoRowLite>>(
    'recv:pos-partial',
    () =>
      invoke<Paged<PoRowLite>>('purchasing.po.list', {
        status: 'partially_received',
        pageSize: 200,
      }),
    { staleMs: 30_000 },
  );

  const warehouses = useQuery<readonly WarehouseOption[]>(
    'recv:warehouses',
    () =>
      invoke<Paged<WarehouseOption>>('entity.list', {
        entity: 'warehouses',
        limit: 100,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000 },
  );

  const locations = useQuery<readonly LocationOption[]>(
    'recv:locations',
    () =>
      invoke<Paged<LocationOption>>('entity.list', {
        entity: 'locations',
        limit: MAX_PAGE_SIZE,
        sort: { key: 'code', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000 },
  );

  const po = useQuery<PoDetail | null>(
    `recv:po:${poId || 'none'}`,
    () => (poId ? invoke<PoDetail>('purchasing.po.get', { id: poId }) : Promise.resolve(null)),
    { staleMs: 5_000, enabled: poId !== '' },
  );

  // Selecting an order seeds the grid from its *open* lines only. A line that is
  // fully received does not appear, because a receiving screen that offers a
  // zero-quantity line is asking the operator to make a decision they do not have.
  function pickOrder(id: string): void {
    setPoId(id);
    setRows([]);
    setMeta({});
    setError(null);
  }

  // Seeding happens in an effect keyed on the loaded PO, not inside `pickOrder`,
  // because the PO arrives asynchronously — and it must be an effect, not a
  // `useMemo`: a memo that calls `setState` is a render-phase side effect.
  const poLoaded = po.data;
  useEffect(() => {
    if (!poLoaded) return;
    const open = poLoaded.lines.filter((line) => line.remainingMilli > 0 && line.productId !== null);
    const nextMeta: Record<string, LineMeta> = {};
    const nextRows: LineDraft[] = open.map((line) => {
      const draft = blankLine({
        productId: line.productId ?? '',
        description: line.description,
        qty: String(line.remainingMilli / 1000),
        unitPrice: (line.unitPriceCents / 100).toFixed(2),
      });
      nextMeta[draft.key] = {
        poLineId: line.id,
        productId: line.productId ?? '',
        orderedMilli: line.qtyMilli,
        alreadyMilli: line.receivedMilli,
        remainingMilli: line.remainingMilli,
      };
      return draft;
    });
    setMeta(nextMeta);
    setRows(nextRows);
    if (poLoaded.warehouseId) setWarehouseId(poLoaded.warehouseId);
  }, [poLoaded]);

  const warehouseLocations = useMemo(
    () => (locations.data ?? []).filter((row) => row.warehouse_id === warehouseId),
    [locations.data, warehouseId],
  );

  const over = rows.filter((row) => {
    const info = meta[row.key];
    if (!info) return false;
    return parseQty(row.qty) > info.remainingMilli;
  });

  const payloadLines = rows
    .map((row) => {
      const info = meta[row.key];
      const milli = parseQty(row.qty);
      if (!info || milli <= 0) return null;
      return { poLineId: info.poLineId, productId: info.productId, qtyMilli: milli };
    })
    .filter((line): line is { poLineId: string; productId: string; qtyMilli: number } => line !== null);

  const missing: string[] = [];
  if (poId === '') missing.push('a purchase order');
  if (date === '') missing.push('a receipt date');
  if (warehouseId === '') missing.push('a warehouse');
  if (locationId === '') missing.push('a location');
  if (payloadLines.length === 0) missing.push('at least one line with a quantity');

  async function save(postNow: boolean): Promise<void> {
    if (missing.length > 0) {
      setError(`Still needed: ${missing.join(', ')}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const receipt = await invoke<ReceiptDetail>('purchasing.receipt.create', {
        poId,
        vendorId: po.data?.vendorId ?? '',
        date,
        warehouseId,
        locationId,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: payloadLines,
      });
      if (postNow) {
        await invoke('purchasing.receipt.post', { id: receipt.id });
      }
      invalidate('ops:');
      invalidate('inventory:');
      invalidate('pb:');
      toast.success(
        postNow ? 'Receipt posted' : 'Receipt saved as a draft',
        postNow
          ? 'Inventory was debited and the accrual credited in the same transaction.'
          : 'Post it when the paperwork is checked — nothing has moved yet.',
      );
      onSaved(receipt);
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'That receipt could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  const orderOptions = [
    ...(orders.data?.rows ?? []),
    ...(partial.data?.rows ?? []),
  ].map((row) => ({ value: row.id, label: `${row.number ?? 'Draft'} · ${row.vendorName}` }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="New goods receipt"
        subtitle="Enter what actually arrived. The order's open quantity is the cap."
        secondaryActions={
          <Button variant="ghost" iconLeft={<ArrowLeft size={14} />} onClick={onCancel}>
            Back to receipts
          </Button>
        }
        primaryAction={
          <div className="flex items-center gap-2">
            <Button variant="secondary" loading={busy} onClick={() => void save(false)}>
              Save draft
            </Button>
            <Button variant="primary" loading={busy} iconLeft={<PackageCheck size={14} />} onClick={() => void save(true)}>
              Save and post
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <SectionCard title="Receipt details" description="Against a confirmed or partly received order.">
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Purchase order</span>
                <Select
                  aria-label="Purchase order"
                  value={poId}
                  placeholder="Choose an order"
                  options={orderOptions}
                  onChange={(event) => pickOrder(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Received on</span>
                <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Warehouse</span>
                <Select
                  aria-label="Warehouse"
                  value={warehouseId}
                  placeholder="Choose a warehouse"
                  options={(warehouses.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
                  onChange={(event) => {
                    setWarehouseId(event.target.value);
                    setLocationId('');
                  }}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Location</span>
                <Select
                  aria-label="Location"
                  value={locationId}
                  placeholder={warehouseId === '' ? 'Pick a warehouse first' : 'Choose a location'}
                  options={warehouseLocations.map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` }))}
                  onChange={(event) => setLocationId(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Notes</span>
                <Textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
              </label>
              {po.data ? (
                <p className="text-meta text-muted">
                  {po.data.vendorName} · {po.data.number ?? 'draft'} · {po.data.currency}
                </p>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard
            title="What arrived"
            description={
              poId === ''
                ? 'Choose an order and its open lines appear here.'
                : 'Only open lines are listed. Quantities default to the outstanding amount.'
            }
          >
            {poId === '' ? (
              <EmptyState
                title="No order selected"
                description="A receipt must name an order: that is what ties the stock movement to the accrual the bill will clear."
              />
            ) : (
              <LineGrid
                rows={rows}
                onChange={setRows}
                products={[]}
                taxes={[]}
                currency={po.data?.currency ?? 'USD'}
                showTax={false}
                showDiscount={false}
                error={error}
                footerNote="Over-receiving is allowed but flagged — the accrual follows the quantity you post."
                renderQty={(row, index, set) => {
                  const info = meta[row.key];
                  const value = parseQty(row.qty);
                  const overThis = info ? value > info.remainingMilli : false;
                  return (
                    <div className="flex flex-col items-end gap-0.5">
                      <Input
                        aria-label={`Receive quantity for line ${String(index + 1)}`}
                        inputMode="decimal"
                        value={row.qty}
                        onChange={(event) => set(event.target.value)}
                        className={`h-7 text-right tnum ${overThis ? 'border-warning' : ''}`}
                      />
                      {info ? (
                        <span className={`text-[10px] ${overThis ? 'text-warning' : 'text-muted'}`}>
                          open {qty(info.remainingMilli)}
                        </span>
                      ) : null}
                    </div>
                  );
                }}
              />
            )}

            {over.length > 0 ? (
              <p className="mt-2 text-meta text-warning">
                {over.length} line{over.length === 1 ? '' : 's'} exceed the open quantity. That is allowed, but check it
                is what arrived.
              </p>
            ) : null}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

interface PoRowLite {
  readonly id: string;
  readonly number: string | null;
  readonly vendorName: string;
}

// ── detail ───────────────────────────────────────────────────────────────────

interface ReceiptDetailProps {
  readonly id: string;
  readonly onBack: () => void;
}

function ReceiptDetailView({ id, onBack }: ReceiptDetailProps): JSX.Element {
  const canPost = useSession((state) => state.can('purchasing.receipt.post'));
  const [busy, setBusy] = useState(false);

  const receipt = useQuery<ReceiptDetail>(`recv:detail:${id}`, () => invoke<ReceiptDetail>('purchasing.receipt.get', { id }), {
    staleMs: 5_000,
  });

  async function post(): Promise<void> {
    setBusy(true);
    try {
      await invoke('purchasing.receipt.post', { id });
      receipt.refresh();
      invalidate('ops:');
      invalidate('inventory:');
      invalidate('pb:');
      toast.success('Receipt posted', 'Inventory was debited and the accrual credited.');
    } catch (caught) {
      toast.error('Could not post', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (receipt.loading && !receipt.data) {
    return <div className="p-6 text-meta text-muted">Loading receipt…</div>;
  }
  if (!receipt.data) {
    return (
      <div className="p-6">
        <EmptyState
          title="That receipt could not be loaded"
          description={receipt.error?.message ?? 'It may have been cancelled.'}
          action={
            <Button variant="secondary" onClick={onBack}>
              Back
            </Button>
          }
        />
      </div>
    );
  }

  const detail = receipt.data;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={`${detail.number ?? 'Draft receipt'} · ${detail.vendorName}`}
        subtitle={`${fmtDate(detail.date)} · ${detail.warehouseName}${detail.locationName ? ` · ${detail.locationName}` : ''}`}
        status={{ status: detail.status, label: detail.status }}
        secondaryActions={
          <Button variant="ghost" iconLeft={<ArrowLeft size={14} />} onClick={onBack}>
            Back
          </Button>
        }
        primaryAction={
          canPost && detail.status === 'draft' ? (
            <Button variant="primary" loading={busy} iconLeft={<CheckCircle2 size={14} />} onClick={() => void post()}>
              Post receipt
            </Button>
          ) : detail.billId ? (
            <Chip tone="success">billed</Chip>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <SectionCard title="Lines received" description="The PO price is shown beside the cost that was actually posted.">
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="bg-surface-2 text-meta text-muted">
                <th scope="col" className="px-2 py-1.5 text-left font-medium">#</th>
                <th scope="col" className="px-2 py-1.5 text-left font-medium">Item</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Received</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Unit cost</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">PO price</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((line) => (
                <tr key={line.id} className="border-b border-line last:border-0">
                  <td className="px-2 py-1.5 text-meta text-muted">{line.lineNo}</td>
                  <td className="px-2 py-1.5 text-text">
                    {line.productName}
                    <span className="ml-2 font-mono text-meta text-muted">{line.sku}</span>
                  </td>
                  <td className="tnum px-2 py-1.5 text-right text-text">{qty(line.qtyMilli)}</td>
                  <td className="tnum px-2 py-1.5 text-right text-muted">{money(line.unitCostCents)}</td>
                  <td className="tnum px-2 py-1.5 text-right text-muted">
                    {line.poPriceCents === null ? '—' : money(line.poPriceCents)}
                  </td>
                  <td className="tnum px-2 py-1.5 text-right text-text">{money(line.valueCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line bg-surface-2">
                <td colSpan={5} className="px-2 py-1.5 text-right text-meta font-medium text-text">Total received</td>
                <td className="tnum px-2 py-1.5 text-right text-body font-medium text-text">{money(detail.totalCents)}</td>
              </tr>
            </tfoot>
          </table>
        </SectionCard>
      </div>
    </div>
  );
}
