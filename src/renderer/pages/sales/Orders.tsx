/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Sales orders — fulfilment board and list (T08, US-35, gap closure).
 *
 * The three quantities on a line — ordered, delivered, invoiced — are the whole
 * fulfilment story. The board groups orders by their derived status, so the
 * column header's count and Σ value come from the same rows that sit under it;
 * nothing is aggregated in a second pass.
 *
 * Actions live in the drawer and each one is a *single* call that the server
 * validates:
 *
 *   - **Confirm** — allocates a number and, if the customer is over their credit
 *     limit, refuses until the operator supplies a reason and holds the override
 *     permission.
 *   - **Deliver** — builds the delivery from the order's open lines, posts it,
 *     and lets the server decide whether stock was available.
 *   - **Invoice** — asks the server for a prefill (it knows what is deliverable
 *     but not yet invoiced) and saves it as a draft. Posting stays in Finance.
 *
 * Nothing on this screen writes a status by hand. `partially_delivered` is what
 * the quantities say it is.
 */

import { CheckCircle2, FileText, PackageCheck, Plus, Truck } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import type { InvoiceInput } from '@shared/finance';
import type { DeliveryDetail, SoDetail, SoRow, SoStatus } from '@shared/ops';
import type { Paged } from '@shared/types';

import { Drawer } from '../../components/Drawer';
import { LineGrid, blankLine, toLineInputs, type LineDraft } from '../../components/LineGrid';
import { Modal } from '../../components/Modal';
import { OpsTable, money, qty, type OpsColumn } from '../../components/OpsTable';
import { PageHeader } from '../../components/PageHeader';
import { TableSkeleton } from '../../components/patterns';
import { Button, Chip, Input, ProgressBar, Segmented, Select, Textarea } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import { today } from '../../lib/finance';
import { date as fmtDate } from '../../lib/format';
import { toast } from '../../lib/toast';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useNewParam } from '../../lib/useNewParam';
import { useSession } from '../../store';

type View = 'board' | 'list';

interface CustomerOption {
  readonly id: string;
  readonly name: string;
}

interface ProductOption {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
}

interface TaxOption {
  readonly id: string;
  readonly name: string;
  readonly rate_bp: number;
}

interface WarehouseOption {
  readonly id: string;
  readonly name: string;
}

const BOARD_STAGES: readonly { readonly id: SoStatus; readonly label: string }[] = [
  { id: 'draft', label: 'Draft' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'partially_delivered', label: 'Part delivered' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'invoiced', label: 'Invoiced' },
];

const COLUMNS: readonly OpsColumn<SoRow>[] = [
  { key: 'number', label: 'Order', width: 'w-32', render: (row) => <span className="font-mono text-meta">{row.number ?? 'Draft'}</span> },
  { key: 'customer', label: 'Customer', render: (row) => <span className="text-text">{row.customerName}</span> },
  { key: 'date', label: 'Date', width: 'w-28', render: (row) => fmtDate(row.date) },
  {
    key: 'delivered',
    label: 'Delivered',
    width: 'w-40',
    render: (row) => (
      <span className="flex items-center gap-2">
        <ProgressBar value={row.orderedMilli === 0 ? 0 : row.deliveredMilli / row.orderedMilli} />
        <span className="tnum text-meta text-muted">
          {qty(row.deliveredMilli)} / {qty(row.orderedMilli)}
        </span>
      </span>
    ),
  },
  { key: 'invoiced', label: 'Invoiced', align: 'right', width: 'w-28', render: (row) => qty(row.invoicedMilli) },
  { key: 'total', label: 'Value', align: 'right', width: 'w-28', render: (row) => money(row.totalCents) },
  {
    key: 'status',
    label: 'Status',
    width: 'w-40',
    render: (row) => <span className="text-muted">{row.status.replace(/_/g, ' ')}</span>,
  },
];

export function SalesOrders(): JSX.Element {
  const canCreate = useSession((state) => state.can('sales.order.create'));
  const [view, setView] = useState<View>('board');
  const [reload, setReload] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  useNewParam(() => setBuilderOpen(true));

  const fetcher = useCallback(
    async ({ page, pageSize, q, status }: { page: number; pageSize: number; q?: string; status?: string }) =>
      invoke<Paged<SoRow>>('sales.order.list', { q, status, page, pageSize }),
    [reload],
  );

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  return (
    <>
      {view === 'list' ? (
        <OpsTable<SoRow>
          title="Sales orders"
          subtitle="Deliver first, then invoice what was delivered."
          countLabel="orders"
          queryKey={`ops:sos:${String(reload)}`}
          fetcher={fetcher}
          columns={COLUMNS}
          filters={[
            {
              key: 'status',
              label: 'statuses',
              options: BOARD_STAGES.map((stage) => ({ value: stage.id, label: stage.label })),
            },
          ]}
          rowKey={(row) => row.id}
          searchPlaceholder="Search order or customer"
          emptyTitle="No sales orders"
          emptyHint="Confirm an order, deliver it, then invoice the delivered quantity."
          primaryAction={
            canCreate ? (
              <Button variant="primary" iconLeft={<Plus size={14} />} onClick={() => setBuilderOpen(true)}>
                New order
              </Button>
            ) : null
          }
          secondaryActions={
            <Segmented
              ariaLabel="Order view"
              value={view}
              onChange={(value) => setView(value as View)}
              options={[
                { value: 'board', label: 'Board' },
                { value: 'list', label: 'List' },
              ]}
            />
          }
          onRowClick={(row) => setOpenId(row.id)}
        />
      ) : (
        <FulfilmentBoard
          reload={reload}
          onOpen={setOpenId}
          onNew={() => setBuilderOpen(true)}
          canCreate={canCreate}
          onViewChange={setView}
        />
      )}

      <OrderDrawer
        id={openId}
        onClose={() => setOpenId(null)}
        onChanged={refresh}
      />

      <OrderBuilder
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        onSaved={(order) => {
          refresh();
          setBuilderOpen(false);
          setOpenId(order.id);
        }}
      />
    </>
  );
}

// ── board ────────────────────────────────────────────────────────────────────

interface BoardProps {
  readonly reload: number;
  readonly onOpen: (id: string) => void;
  readonly onNew: () => void;
  readonly canCreate: boolean;
  readonly onViewChange: (view: View) => void;
}

function FulfilmentBoard({ reload, onOpen, onNew, canCreate, onViewChange }: BoardProps): JSX.Element {
  const orders = useQuery<Paged<SoRow>>(
    `ops:sos-board:${String(reload)}`,
    () => invoke<Paged<SoRow>>('sales.order.list', { pageSize: 200 }),
    { staleMs: 10_000 },
  );

  const rows = orders.data?.rows ?? [];

  const columns = useMemo(() => {
    return BOARD_STAGES.map((stage) => {
      const cards = rows.filter((row) => row.status === stage.id);
      const value = cards.reduce((sum, row) => sum + row.totalCents, 0);
      return { ...stage, cards, value };
    });
  }, [rows]);

  if (orders.loading && rows.length === 0) {
    return (
      <div className="p-6">
        <TableSkeleton rows={8} columns={4} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Sales orders"
        subtitle="Columns are derived from the delivered and invoiced quantities — nothing here is set by hand."
        count={orders.data?.total ?? 0}
        countLabel="orders"
        primaryAction={
          canCreate ? (
            <Button variant="primary" iconLeft={<Plus size={14} />} onClick={onNew}>
              New order
            </Button>
          ) : null
        }
        secondaryActions={
          <Segmented
            ariaLabel="Order view"
            value="board"
            onChange={(value) => onViewChange(value as View)}
            options={[
              { value: 'board', label: 'Board' },
              { value: 'list', label: 'List' },
            ]}
          />
        }
      />

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-6 pb-6">
        <div className="flex h-full gap-3">
          {columns.map((column) => (
            <section
              key={column.id}
              className="flex h-full w-64 shrink-0 flex-col rounded-card border border-line bg-surface-2/40"
              aria-label={`${column.label} orders`}
            >
              <header className="shrink-0 border-b border-line px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-meta font-medium text-text">
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: `var(--${column.id === 'draft' ? 'muted' : column.id === 'invoiced' ? 'success' : 'accent'})` }}
                    />
                    {column.label}
                  </span>
                  <Chip tone="neutral">{column.cards.length}</Chip>
                </div>
                <p className="tnum mt-0.5 text-meta text-muted">{money(column.value)}</p>
              </header>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                {column.cards.length === 0 ? (
                  <p className="px-1 py-6 text-center text-meta text-muted">Nothing here.</p>
                ) : (
                  column.cards.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => onOpen(row.id)}
                      className="w-full rounded-card border border-line bg-surface p-2 text-left transition-colors duration-fast hover:border-line-strong hover:bg-elevated"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="truncate text-body text-text">{row.customerName}</span>
                        <span className="tnum shrink-0 text-meta text-muted">{money(row.totalCents)}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] text-muted">{row.number ?? 'Draft'}</span>
                        <span className="text-[11px] text-muted">{fmtDate(row.date)}</span>
                      </div>
                      <div className="mt-1.5">
                        <ProgressBar value={row.orderedMilli === 0 ? 0 : row.deliveredMilli / row.orderedMilli} />
                        <p className="mt-0.5 tnum text-[11px] text-muted">
                          delivered {qty(row.deliveredMilli)} · invoiced {qty(row.invoicedMilli)} of {qty(row.orderedMilli)}
                        </p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── order drawer ─────────────────────────────────────────────────────────────

interface OrderDrawerProps {
  readonly id: string | null;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}

function OrderDrawer({ id, onClose, onChanged }: OrderDrawerProps): JSX.Element {
  const canConfirm = useSession((state) => state.can('sales.order.write'));
  const canDeliver = useSession((state) => state.can('sales.delivery.create'));
  const canPostDelivery = useSession((state) => state.can('sales.delivery.post'));
  const canInvoice = useSession((state) => state.can('sales.order.create'));

  const [busy, setBusy] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [creditReason, setCreditReason] = useState('');
  const [warehouseId, setWarehouseId] = useState('');

  const order = useQuery<SoDetail | null>(
    `so:detail:${id ?? 'none'}`,
    () => (id ? invoke<SoDetail>('sales.order.get', { id }) : Promise.resolve(null)),
    { staleMs: 5_000, enabled: id !== null },
  );

  const warehouses = useQuery<readonly WarehouseOption[]>(
    'so:warehouses',
    () =>
      invoke<Paged<WarehouseOption>>('entity.list', {
        entity: 'warehouses',
        limit: 100,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000, enabled: id !== null },
  );

  const detail = order.data;

  async function confirm(override = false): Promise<void> {
    if (!id) return;
    setBusy(true);
    try {
      await invoke<SoDetail>('sales.order.confirm', {
        id,
        ...(override ? { overrideCredit: true, reason: creditReason.trim() } : {}),
      });
      order.refresh();
      onChanged();
      setCreditOpen(false);
      setCreditReason('');
      toast.success('Order confirmed', 'A number was allocated and stock is now reserved.');
    } catch (caught) {
      const message = isApiError(caught) ? caught.message : 'Could not confirm.';
      if (/credit/i.test(message) && !override) setCreditOpen(true);
      else toast.error('Could not confirm', message);
    } finally {
      setBusy(false);
    }
  }

  async function deliver(): Promise<void> {
    if (!detail) return;
    const warehouse = warehouseId || detail.warehouseId || '';
    if (warehouse === '') {
      toast.error('Pick a warehouse', 'A delivery has to come from somewhere.');
      return;
    }
    const lines = detail.lines
      .filter((line) => line.remainingMilli > 0 && line.productId !== null)
      .map((line) => ({
        soLineId: line.id,
        productId: line.productId as string,
        qtyMilli: line.remainingMilli,
      }));
    if (lines.length === 0) {
      toast.info('Nothing left to deliver', 'Every line on this order has been shipped.');
      return;
    }
    setBusy(true);
    try {
      const delivery = await invoke<DeliveryDetail>('sales.delivery.create', {
        orderId: detail.id,
        customerId: detail.customerId,
        date: today(),
        warehouseId: warehouse,
        lines,
      });
      await invoke<DeliveryDetail>('sales.delivery.post', { id: delivery.id });
      order.refresh();
      onChanged();
      invalidate('ops:');
      invalidate('inventory:');
      toast.success(
        'Delivery posted',
        `${delivery.number ?? 'Draft'} moved ${String(lines.length)} line${lines.length === 1 ? '' : 's'} out of stock.`,
      );
    } catch (caught) {
      toast.error('Could not deliver', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function invoice(): Promise<void> {
    if (!detail) return;
    setBusy(true);
    try {
      // The prefill comes from the server: it is the only place that knows what
      // has been delivered but not yet invoiced.
      const draft = await invoke<InvoiceInput>('sales.order.invoice', { id: detail.id });
      const saved = await invoke<{ id: string; number: string | null }>('finance.invoices.save', draft);
      order.refresh();
      onChanged();
      invalidate('invoices');
      toast.success(
        'Draft invoice created',
        `${saved.number ?? 'Draft'} was built from the delivered quantity. Review and post it in Finance.`,
      );
    } catch (caught) {
      toast.error('Could not invoice', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Drawer
        open={id !== null}
        onOpenChange={(open) => (open ? undefined : onClose())}
        title={detail ? `${detail.number ?? 'Draft order'} · ${detail.customerName}` : 'Loading order…'}
        subtitle={detail ? `${fmtDate(detail.date)} · ${detail.currency} · ${detail.lines.length} lines` : undefined}
        status={detail ? { status: detail.status, label: detail.status.replace(/_/g, ' ') } : undefined}
        width={680}
        footer={
          detail ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
              <div className="flex flex-wrap items-center gap-2">
                {canConfirm && detail.status === 'draft' ? (
                  <Button variant="secondary" size="sm" loading={busy} iconLeft={<CheckCircle2 size={13} />} onClick={() => void confirm()}>
                    Confirm
                  </Button>
                ) : null}
                {canDeliver && canPostDelivery && (detail.status === 'confirmed' || detail.status === 'partially_delivered') ? (
                  <Button variant="secondary" size="sm" loading={busy} iconLeft={<Truck size={13} />} onClick={() => void deliver()}>
                    Deliver rest
                  </Button>
                ) : null}
                {canInvoice && (detail.status === 'delivered' || detail.status === 'partially_delivered') ? (
                  <Button variant="primary" size="sm" loading={busy} iconLeft={<FileText size={13} />} onClick={() => void invoice()}>
                    Invoice delivered
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null
        }
      >
        {detail ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-y-1.5 text-body">
              <dt className="text-muted">Total</dt>
              <dd className="text-right tnum text-text">{money(detail.totalCents)}</dd>
              <dt className="text-muted">Delivered</dt>
              <dd className="text-right tnum text-text">
                {qty(detail.deliveredMilli)} of {qty(detail.orderedMilli)}
              </dd>
              <dt className="text-muted">Invoiced</dt>
              <dd className="text-right tnum text-text">{qty(detail.invoicedMilli)}</dd>
              {detail.quoteId ? (
                <>
                  <dt className="text-muted">From quotation</dt>
                  <dd className="text-right text-meta text-muted">{detail.quoteId.slice(0, 8)}</dd>
                </>
              ) : null}
            </dl>

            {(detail.status === 'confirmed' || detail.status === 'partially_delivered') && detail.warehouseId === null ? (
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Deliver from</span>
                <Select
                  aria-label="Warehouse"
                  value={warehouseId}
                  placeholder="Choose a warehouse"
                  options={(warehouses.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
                  onChange={(event) => setWarehouseId(event.target.value)}
                />
              </label>
            ) : null}

            <table className="w-full border-collapse text-body">
              <thead>
                <tr className="bg-surface-2 text-meta text-muted">
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">Item</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Ordered</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Delivered</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Invoiced</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">To invoice</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line) => (
                  <tr key={line.id} className="border-b border-line last:border-0">
                    <td className="max-w-[16rem] truncate px-2 py-1.5 text-text">{line.description}</td>
                    <td className="tnum px-2 py-1.5 text-right text-text">{qty(line.qtyMilli)}</td>
                    <td className="tnum px-2 py-1.5 text-right text-muted">{qty(line.deliveredMilli)}</td>
                    <td className="tnum px-2 py-1.5 text-right text-muted">{qty(line.invoicedMilli)}</td>
                    <td className={`tnum px-2 py-1.5 text-right ${line.toInvoiceMilli > 0 ? 'text-text' : 'text-muted'}`}>
                      {qty(line.toInvoiceMilli)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="text-meta text-muted">
              <PackageCheck size={13} className="mr-1 inline" aria-hidden="true" />
              Delivering moves stock and posts cost of goods sold. Invoicing raises a draft — nothing reaches the ledger
              until it is posted in Finance.
            </p>
          </div>
        ) : (
          <TableSkeleton rows={5} columns={5} />
        )}
      </Drawer>

      <Modal
        open={creditOpen}
        onOpenChange={setCreditOpen}
        title="This order is over the credit limit"
        description="Confirming it needs the override permission and a reason, both of which are recorded in the audit log."
        size="sm"
        busy={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreditOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={creditReason.trim().length < 3}
              onClick={() => void confirm(true)}
            >
              Override and confirm
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1">
          <span className="micro">Reason (recorded in the audit log)</span>
          <Input
            autoFocus
            value={creditReason}
            onChange={(event) => setCreditReason(event.target.value)}
            placeholder="Approved by the finance director"
          />
        </label>
      </Modal>
    </>
  );
}

// ── builder ──────────────────────────────────────────────────────────────────

interface OrderBuilderProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: (order: SoDetail) => void;
}

function OrderBuilder({ open, onOpenChange, onSaved }: OrderBuilderProps): JSX.Element {
  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(today());
  const [warehouseId, setWarehouseId] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<LineDraft[]>(() => [blankLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customers = useQuery<readonly CustomerOption[]>(
    'sob:customers',
    () =>
      invoke<Paged<CustomerOption>>('entity.list', {
        entity: 'customers',
        limit: 200,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000, enabled: open },
  );

  const products = useQuery<readonly ProductOption[]>(
    'sob:products',
    () =>
      invoke<Paged<ProductOption>>('entity.list', {
        entity: 'products',
        limit: 200,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000, enabled: open },
  );

  const taxes = useQuery<readonly TaxOption[]>(
    'sob:taxes',
    () =>
      invoke<Paged<TaxOption>>('entity.list', {
        entity: 'taxes',
        limit: 100,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000, enabled: open },
  );

  const warehouses = useQuery<readonly WarehouseOption[]>(
    'sob:warehouses',
    () =>
      invoke<Paged<WarehouseOption>>('entity.list', {
        entity: 'warehouses',
        limit: 100,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000, enabled: open },
  );

  const productOptions = useMemo(
    () => (products.data ?? []).map((row) => ({ value: row.id, label: `${row.sku} · ${row.name}` })),
    [products.data],
  );
  const taxOptions = useMemo(
    () => (taxes.data ?? []).map((row) => ({ value: row.id, label: `${row.name} (${(row.rate_bp / 100).toFixed(2)}%)` })),
    [taxes.data],
  );

  const lines = toLineInputs(rows, true);

  async function save(): Promise<void> {
    if (customerId === '') {
      setError('Pick a customer.');
      return;
    }
    if (lines.length === 0) {
      setError('Add at least one line.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await invoke<SoDetail>('sales.order.save', {
        customerId,
        date,
        ...(warehouseId ? { warehouseId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines,
      });
      invalidate('ops:');
      toast.success('Order saved', `${saved.number ?? 'Draft'} is a draft. Confirm it to reserve stock.`);
      onSaved(saved);
      setRows([blankLine()]);
      setCustomerId('');
      setNotes('');
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'That order could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New sales order"
      description="A draft reserves nothing. Confirming allocates a number and checks the credit limit."
      size="xl"
      busy={busy}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save draft
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-3">
          <label className="col-span-1 flex flex-col gap-1">
            <span className="text-meta font-medium text-text">Customer</span>
            <Select
              aria-label="Customer"
              value={customerId}
              placeholder="Choose a customer"
              options={(customers.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
              onChange={(event) => setCustomerId(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-meta font-medium text-text">Date</span>
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-meta font-medium text-text">Deliver from</span>
            <Select
              aria-label="Warehouse"
              value={warehouseId}
              placeholder="Any warehouse"
              options={(warehouses.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
              onChange={(event) => setWarehouseId(event.target.value)}
            />
          </label>
        </div>

        <LineGrid
          rows={rows}
          onChange={setRows}
          products={productOptions}
          taxes={taxOptions}
          currency="USD"
          showDiscount
          error={error}
          footerNote="Prices resolve from the customer's price list on save; tax and totals are computed by the server."
        />

        <label className="flex flex-col gap-1">
          <span className="text-meta font-medium text-text">Notes</span>
          <Textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
