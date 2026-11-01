/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Purchase orders — list, builder and detail (T08, US-29, gap closure).
 *
 * Three screens in one file because they are one job: raise an order, look at
 * what came back against it, and act on the difference. Splitting the builder
 * into its own route means the operator loses the list they came from.
 *
 * The status column is derived from the receipts, not set by hand, so
 * `partially_received` cannot disagree with the quantity next to it.
 *
 * The builder uses the shared `LineGrid` and the shared A4 preview: the preview
 * is rendered by the main process from a `purchase_order` document model, so
 * what the buyer checks before confirming is byte-for-byte what the supplier
 * receives. A client-side "preview" would be a second implementation of the
 * layout, and the second one is always the wrong one.
 */

import { ArrowLeft, Ban, Plus, Printer, Send } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import type { BillRow } from '@shared/finance';
import type { PoDetail, PoLineRow, PoRow, ReceiptRow } from '@shared/ops';
import type { Paged } from '@shared/types';

import { LineGrid, blankLine, toPoLineInputs, type LineDraft } from '../../components/LineGrid';
import { Modal } from '../../components/Modal';
import { OpsTable, money, qty, type OpsColumn } from '../../components/OpsTable';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, SectionCard, TableSkeleton } from '../../components/patterns';
import { Button, Chip, Input, ProgressBar, Select, Textarea } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import { today } from '../../lib/finance';
import { date as fmtDate } from '../../lib/format';
import { toast } from '../../lib/toast';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useNewParam } from '../../lib/useNewParam';
import { useSession } from '../../store';

interface VendorOption {
  readonly id: string;
  readonly name: string;
  readonly currency: string | null;
}

interface WarehouseOption {
  readonly id: string;
  readonly name: string;
}

interface TaxOption {
  readonly id: string;
  readonly name: string;
  readonly rate_bp: number;
}

interface ProductOption {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly base_price_cents: number;
}

const COLUMNS: readonly OpsColumn<PoRow>[] = [
  { key: 'number', label: 'Order', width: 'w-32', render: (row) => <span className="font-mono text-meta">{row.number ?? 'Draft'}</span> },
  { key: 'vendor', label: 'Vendor', render: (row) => <span className="text-text">{row.vendorName}</span> },
  { key: 'date', label: 'Ordered', width: 'w-28', render: (row) => fmtDate(row.date) },
  { key: 'expected', label: 'Expected', width: 'w-28', render: (row) => (row.expectedDate ? fmtDate(row.expectedDate) : '—') },
  {
    key: 'received',
    label: 'Received',
    width: 'w-40',
    render: (row) => (
      <span className="flex items-center gap-2">
        <ProgressBar value={row.orderedMilli === 0 ? 0 : row.receivedMilli / row.orderedMilli} />
        <span className="tnum text-meta text-muted">
          {qty(row.receivedMilli)} / {qty(row.orderedMilli)}
        </span>
      </span>
    ),
  },
  { key: 'total', label: 'Value', align: 'right', width: 'w-28', render: (row) => money(row.totalCents) },
  {
    key: 'status',
    label: 'Status',
    width: 'w-36',
    render: (row) => <span className="text-muted">{row.status.replace(/_/g, ' ')}</span>,
  },
];

const FILTERS = [
  {
    key: 'status',
    label: 'statuses',
    options: [
      { value: 'draft', label: 'Draft' },
      { value: 'confirmed', label: 'Confirmed' },
      { value: 'partially_received', label: 'Partially received' },
      { value: 'received', label: 'Received' },
      { value: 'cancelled', label: 'Cancelled' },
    ],
  },
];

export function PurchaseOrders(): JSX.Element {
  const canCreate = useSession((state) => state.can('purchasing.po.create'));
  const [reload, setReload] = useState(0);
  /** `null` = list · `'new'` = builder · a string id = detail. */
  const [view, setView] = useState<null | 'new' | string>(null);
  useNewParam(() => setView('new'));

  const fetcher = useCallback(
    async ({ page, pageSize, q, status }: { page: number; pageSize: number; q?: string; status?: string }) =>
      invoke<Paged<PoRow>>('purchasing.po.list', { q, status, page, pageSize }),
    [reload],
  );

  if (view === 'new') {
    return (
      <PoBuilder
        onCancel={() => setView(null)}
        onSaved={(po) => {
          setReload((value) => value + 1);
          setView(po.id);
        }}
      />
    );
  }

  if (view !== null) {
    return (
      <PoDetailView
        id={view}
        onBack={() => {
          setReload((value) => value + 1);
          setView(null);
        }}
        onNewReceipt={() => {
          setReload((value) => value + 1);
        }}
      />
    );
  }

  return (
    <OpsTable<PoRow>
      title="Purchase orders"
      subtitle="Receive against an order and it becomes a billable receipt."
      countLabel="orders"
      queryKey={`ops:pos:${String(reload)}`}
      fetcher={fetcher}
      columns={COLUMNS}
      filters={FILTERS}
      rowKey={(row) => row.id}
      searchPlaceholder="Search order or vendor"
      emptyTitle="No purchase orders"
      emptyHint="Raise an order, confirm it, then receive against it."
      primaryAction={
        canCreate ? (
          <Button variant="primary" iconLeft={<Plus size={14} />} onClick={() => setView('new')}>
            New order
          </Button>
        ) : null
      }
      onRowClick={(row) => setView(row.id)}
    />
  );
}

// ── builder ──────────────────────────────────────────────────────────────────

interface PoBuilderProps {
  readonly onCancel: () => void;
  readonly onSaved: (po: PoDetail) => void;
}

function PoBuilder({ onCancel, onSaved }: PoBuilderProps): JSX.Element {
  const [vendorId, setVendorId] = useState('');
  const [date, setDate] = useState(today());
  const [expectedDate, setExpectedDate] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<LineDraft[]>(() => [blankLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vendors = useQuery<readonly VendorOption[]>(
    'po:vendors',
    () =>
      invoke<Paged<VendorOption>>('entity.list', {
        entity: 'vendors',
        limit: 200,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000 },
  );

  const warehouses = useQuery<readonly WarehouseOption[]>(
    'po:warehouses',
    () =>
      invoke<Paged<WarehouseOption>>('entity.list', {
        entity: 'warehouses',
        limit: 100,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000 },
  );

  const products = useQuery<readonly ProductOption[]>(
    'po:products',
    () =>
      invoke<Paged<ProductOption>>('entity.list', {
        entity: 'products',
        limit: 200,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000 },
  );

  const taxes = useQuery<readonly TaxOption[]>(
    'po:taxes',
    () =>
      invoke<Paged<TaxOption>>('entity.list', {
        entity: 'taxes',
        limit: 100,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000 },
  );

  const vendor = (vendors.data ?? []).find((row) => row.id === vendorId);
  const currency = vendor?.currency ?? 'USD';

  const productOptions = useMemo(
    () => (products.data ?? []).map((row) => ({ value: row.id, label: `${row.sku} · ${row.name}` })),
    [products.data],
  );

  const taxOptions = useMemo(
    () =>
      (taxes.data ?? []).map((row) => ({
        value: row.id,
        label: `${row.name} (${(row.rate_bp / 100).toFixed(2)}%)`,
      })),
    [taxes.data],
  );

  const lines = toPoLineInputs(rows);
  const missing: string[] = [];
  if (vendorId === '') missing.push('a vendor');
  if (date === '') missing.push('an order date');
  if (lines.length === 0) missing.push('at least one line');
  if (lines.some((line) => line.qtyMilli <= 0)) missing.push('a quantity on every line');

  async function save(): Promise<void> {
    if (missing.length > 0) {
      setError(`Still needed: ${missing.join(', ')}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await invoke<PoDetail>('purchasing.po.save', {
        vendorId,
        date,
        ...(expectedDate ? { expectedDate } : {}),
        ...(warehouseId ? { warehouseId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines,
      });
      invalidate('ops:');
      toast.success('Purchase order saved', `${saved.number ?? 'Draft'} has ${String(saved.lines.length)} line${saved.lines.length === 1 ? '' : 's'}. Confirm it to send.`);
      onSaved(saved);
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'That order could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="New purchase order"
        subtitle="Lines and totals are computed by the server on save — this screen only collects them."
        secondaryActions={
          <Button variant="ghost" iconLeft={<ArrowLeft size={14} />} onClick={onCancel}>
            Back to orders
          </Button>
        }
        primaryAction={
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save draft
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <SectionCard title="Order details" description="Terms come from the vendor; the expected date is a promise, not a rule.">
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Vendor</span>
                <Select
                  aria-label="Vendor"
                  value={vendorId}
                  placeholder="Choose a vendor"
                  options={(vendors.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
                  onChange={(event) => setVendorId(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Order date</span>
                <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Expected</span>
                <Input type="date" value={expectedDate} onChange={(event) => setExpectedDate(event.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Deliver into</span>
                <Select
                  aria-label="Warehouse"
                  value={warehouseId}
                  placeholder="Any warehouse"
                  options={(warehouses.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
                  onChange={(event) => setWarehouseId(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Notes</span>
                <Textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
              </label>
              <p className="text-meta text-muted">Currency {currency}. A draft burns no number; confirming allocates one.</p>
            </div>
          </SectionCard>

          <SectionCard title="Lines" description="Pick a product to fill the description, then set the price you agreed.">
            <LineGrid
              rows={rows}
              onChange={setRows}
              products={productOptions}
              taxes={taxOptions}
              currency={currency}
              showDiscount={false}
              error={error}
              footerNote="Tax and the document total are computed by the server when the order is saved."
            />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

// ── detail ───────────────────────────────────────────────────────────────────

interface PoDetailProps {
  readonly id: string;
  readonly onBack: () => void;
  readonly onNewReceipt: () => void;
}

function PoDetailView({ id, onBack, onNewReceipt }: PoDetailProps): JSX.Element {
  const canConfirm = useSession((state) => state.can('purchasing.po.confirm'));
  const canCancel = useSession((state) => state.can('purchasing.po.cancel'));

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [busy, setBusy] = useState(false);

  const po = useQuery<PoDetail>(`po:detail:${id}`, () => invoke<PoDetail>('purchasing.po.get', { id }), {
    staleMs: 5_000,
  });

  const receipts = useQuery<Paged<ReceiptRow>>(
    `po:receipts:${id}`,
    () => invoke<Paged<ReceiptRow>>('purchasing.receipt.list', { pageSize: 200 }),
    { staleMs: 10_000 },
  );

  const bills = useQuery<Paged<BillRow>>(
    `po:bills:${id}`,
    () => invoke<Paged<BillRow>>('finance.bills.list', { pageSize: 200 }),
    { staleMs: 10_000 },
  );

  // Both cross-link lists are filtered here because the server has no "by PO"
  // filter for receipts or bills, and adding one for a single detail panel would
  // be two channels nobody else calls.
  const linkedReceipts = useMemo(
    () => (receipts.data?.rows ?? []).filter((row) => row.poId === id),
    [receipts.data, id],
  );
  const linkedBills = useMemo(
    () => (bills.data?.rows ?? []).filter((row) => po.data?.billIds.includes(row.id) === true),
    [bills.data, po.data],
  );

  async function confirm(): Promise<void> {
    setBusy(true);
    try {
      const saved = await invoke<PoDetail>('purchasing.po.confirm', { id });
      po.refresh();
      invalidate('ops:');
      toast.success('Order confirmed', `${saved.number ?? ''} can now be received against.`);
    } catch (caught) {
      toast.error('Could not confirm', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    setBusy(true);
    try {
      await invoke<PoDetail>('purchasing.po.cancel', { id, reason: cancelReason.trim() });
      po.refresh();
      invalidate('ops:');
      setCancelOpen(false);
      setCancelReason('');
      toast.success('Order cancelled', 'The reason was written to the audit log.');
    } catch (caught) {
      toast.error('Could not cancel', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function print(): Promise<void> {
    if (!po.data) return;
    try {
      await invoke('documents.pdf.save', { docType: 'purchase_order', id });
      toast.success('PDF saved', 'The same template the preview uses.');
    } catch (caught) {
      toast.error('Could not save the PDF', isApiError(caught) ? caught.message : 'Try again.');
    }
  }

  if (po.loading && !po.data) {
    return (
      <div className="p-6">
        <TableSkeleton rows={6} columns={5} />
      </div>
    );
  }

  if (po.error || !po.data) {
    return (
      <div className="p-6">
        <EmptyState
          title="That order could not be loaded"
          description={po.error?.message ?? 'It may have been cancelled.'}
          action={
            <Button variant="secondary" onClick={onBack}>
              Back to orders
            </Button>
          }
        />
      </div>
    );
  }

  const detail = po.data;
  const canReceive = detail.status === 'confirmed' || detail.status === 'partially_received';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={`${detail.number ?? 'Draft order'} · ${detail.vendorName}`}
        subtitle={`${fmtDate(detail.date)} · ${detail.currency} · ${detail.lines.length} line${detail.lines.length === 1 ? '' : 's'}`}
        status={{ status: detail.status, label: detail.status.replace(/_/g, ' ') }}
        secondaryActions={
          <Button variant="ghost" iconLeft={<ArrowLeft size={14} />} onClick={onBack}>
            Back
          </Button>
        }
        primaryAction={
          <div className="flex items-center gap-2">
            <Button variant="ghost" iconLeft={<Printer size={14} />} onClick={() => void print()}>
              PDF
            </Button>
            {canReceive ? (
              <Button variant="secondary" onClick={onNewReceipt}>
                Receive
              </Button>
            ) : null}
            {canConfirm && detail.status === 'draft' ? (
              <Button variant="primary" loading={busy} iconLeft={<Send size={14} />} onClick={() => void confirm()}>
                Confirm
              </Button>
            ) : null}
            {canCancel && detail.status !== 'cancelled' && detail.status !== 'received' ? (
              <Button variant="danger" iconLeft={<Ban size={14} />} onClick={() => setCancelOpen(true)}>
                Cancel
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <SectionCard title="Lines" description="Received is derived from posted receipts, never typed here.">
            <table className="w-full border-collapse text-body">
              <thead>
                <tr className="bg-surface-2 text-meta text-muted">
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">#</th>
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">Item</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Ordered</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Received</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Open</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Unit price</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line: PoLineRow) => (
                  <tr key={line.id} className="border-b border-line last:border-0">
                    <td className="px-2 py-1.5 text-meta text-muted">{line.lineNo}</td>
                    <td className="px-2 py-1.5 text-text">
                      {line.description}
                      {line.sku ? <span className="ml-2 font-mono text-meta text-muted">{line.sku}</span> : null}
                    </td>
                    <td className="tnum px-2 py-1.5 text-right text-text">{qty(line.qtyMilli)}</td>
                    <td className="tnum px-2 py-1.5 text-right text-muted">{qty(line.receivedMilli)}</td>
                    <td className={`tnum px-2 py-1.5 text-right ${line.remainingMilli > 0 ? 'text-text' : 'text-muted'}`}>
                      {qty(line.remainingMilli)}
                    </td>
                    <td className="tnum px-2 py-1.5 text-right text-muted">{money(line.unitPriceCents)}</td>
                    <td className="tnum px-2 py-1.5 text-right text-text">{money(line.netCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line bg-surface-2">
                  <td colSpan={6} className="px-2 py-1.5 text-right text-meta text-muted">Subtotal</td>
                  <td className="tnum px-2 py-1.5 text-right text-text">{money(detail.subtotalCents)}</td>
                </tr>
                <tr className="bg-surface-2">
                  <td colSpan={6} className="px-2 py-1.5 text-right text-meta text-muted">Tax</td>
                  <td className="tnum px-2 py-1.5 text-right text-text">{money(detail.taxCents)}</td>
                </tr>
                <tr className="bg-surface-2">
                  <td colSpan={6} className="px-2 py-1.5 text-right text-meta font-medium text-text">Total</td>
                  <td className="tnum px-2 py-1.5 text-right text-body font-medium text-text">{money(detail.totalCents)}</td>
                </tr>
              </tfoot>
            </table>
          </SectionCard>

          <div className="flex flex-col gap-4">
            <SectionCard title="Receipts" description="What actually arrived against this order.">
              {linkedReceipts.length === 0 ? (
                <p className="text-meta text-muted">Nothing received yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {linkedReceipts.map((receipt) => (
                    <li key={receipt.id} className="flex items-center justify-between py-1.5">
                      <span className="font-mono text-meta text-text">{receipt.number ?? 'Draft'}</span>
                      <span className="flex items-center gap-2">
                        <span className="tnum text-meta text-muted">{money(receipt.totalCents)}</span>
                        <Chip tone={receipt.status === 'posted' ? 'success' : 'neutral'}>{receipt.status}</Chip>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="Bills" description="Bills raised against this order, and whether they matched.">
              {linkedBills.length === 0 ? (
                <p className="text-meta text-muted">No bill raised yet. Unbilled receipts are an accrual.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {linkedBills.map((bill) => (
                    <li key={bill.id} className="flex items-center justify-between py-1.5">
                      <span className="font-mono text-meta text-text">{bill.number ?? 'Draft'}</span>
                      <span className="flex items-center gap-2">
                        <span className="tnum text-meta text-muted">{money(bill.totalCents)}</span>
                        <Chip tone={bill.status === 'void' ? 'danger' : 'neutral'}>{bill.status}</Chip>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="Progress" description="Received against ordered, across every line.">
              <ProgressBar value={detail.orderedMilli === 0 ? 0 : detail.receivedMilli / detail.orderedMilli} />
              <p className="mt-2 tnum text-meta text-muted">
                {qty(detail.receivedMilli)} of {qty(detail.orderedMilli)} received
                {detail.expectedDate ? ` · expected ${fmtDate(detail.expectedDate)}` : ''}
              </p>
            </SectionCard>
          </div>
        </div>

        {detail.notes ? (
          <SectionCard title="Notes" description="Printed on the supplier's copy.">
            <p className="whitespace-pre-wrap text-body text-text">{detail.notes}</p>
          </SectionCard>
        ) : null}
      </div>

      <Modal
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={`Cancel ${detail.number ?? 'this order'}`}
        description="A received order cannot be cancelled. A partly received one needs the receipts cancelled first."
        size="sm"
        destructive
        busy={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelOpen(false)} disabled={busy}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={cancelReason.trim().length < 3}
              onClick={() => void cancel()}
            >
              Cancel order
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1">
          <span className="micro">Reason (recorded in the audit log)</span>
          <Input
            autoFocus
            value={cancelReason}
            onChange={(event) => setCancelReason(event.target.value)}
            placeholder="Supplier could not fulfil"
          />
        </label>
      </Modal>
    </div>
  );
}
