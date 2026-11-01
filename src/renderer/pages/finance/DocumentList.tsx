/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The AR/AP list screen, shared by invoices and bills (T06, R1, R2).
 *
 * Reading order is the R2 pattern and nothing else:
 *   header (title + count + one primary + ghost secondaries)
 *   → status tabs with counts
 *   → toolbar (search, chips, density, export)
 *   → table
 *   → sticky bulk bar
 *   → pagination.
 *
 * Scale (R1): the server pages, `pageSize` is capped at 200 in the validator,
 * and the row count in the header comes from `total`, never from `rows.length`.
 * The status counts are six `pageSize: 1` calls, which is a covering count, not
 * six page loads.
 *
 * Status is *derived* (posted + paid − allocated, compared with today), so the
 * server filters it after computing and the tabs therefore show real totals
 * rather than an approximation.
 */

import { AlertCircle, Copy, CheckCircle2, Ban, Eye } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { ArStatus, BillRow, InvoiceRow } from '@shared/finance';

import { Drawer } from '../../components/Drawer';
import { Modal } from '../../components/Modal';
import { PageHeader } from '../../components/PageHeader';
import { BulkBar, EmptyState, MoneyCell, Pagination, StatusTabs, TableSkeleton, Toolbar } from '../../components/patterns';
import { Badge, Button, IconButton, Input, Tooltip } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import {
  AR_STATUSES,
  addDays,
  fetchBills,
  fetchInvoices,
  fk,
  today,
  useStatusCounts,
} from '../../lib/finance';
import { amount, date as fmtDate, humanise, titleCase } from '../../lib/format';
import { toast } from '../../lib/toast';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useSession } from '../../store';
import { DocumentEditor } from './DocumentEditor';

const PAGE_SIZE = 50;

export interface DocumentListProps {
  readonly docType: 'invoice' | 'bill';
}

type Row = InvoiceRow | BillRow;

const TABS: readonly { readonly id: '' | ArStatus; readonly label: string }[] = [
  { id: '', label: 'All' },
  { id: 'draft', label: 'Draft' },
  { id: 'posted', label: 'Posted' },
  { id: 'partially_paid', label: 'Part paid' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'paid', label: 'Paid' },
  { id: 'void', label: 'Void' },
];

export function DocumentList({ docType }: DocumentListProps): JSX.Element {
  const [params, setParams] = useSearchParams();
  const isInvoice = docType === 'invoice';
  const baseCurrency = useSession((state) => state.company?.baseCurrency ?? 'USD');
  const canCreate = useSession((state) => state.can(isInvoice ? 'finance.invoice.create' : 'finance.bill.create'));
  const canPost = useSession((state) => state.can(isInvoice ? 'finance.invoice.post' : 'finance.bill.post'));
  const canVoid = useSession((state) => state.can(isInvoice ? 'finance.invoice.void' : 'finance.bill.void'));

  const openId = params.get('id');
  const isNew = params.get('new') === '1';

  const [status, setStatus] = useState<'' | ArStatus>('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState(() => addDays(today(), -365));
  const [to, setTo] = useState(() => today());
  const [page, setPage] = useState(1);
  const [density, setDensity] = useState<'compact' | 'comfortable'>('comfortable');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [peek, setPeek] = useState<Row | null>(null);
  const [voidTarget, setVoidTarget] = useState<Row | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [busy, setBusy] = useState(false);

  const base = useMemo(
    () => ({ from, to, q: q.trim() === '' ? undefined : q.trim() }),
    [from, to, q],
  );

  const filter = useMemo(
    () => ({ ...base, status: status === '' ? undefined : status, page, pageSize: PAGE_SIZE }),
    [base, status, page],
  );

  const list = useQuery<{ readonly rows: readonly Row[]; readonly total: number }>(
    isInvoice ? fk.invoices(filter) : fk.bills(filter),
    () => (isInvoice ? fetchInvoices(filter) : fetchBills(filter)) as Promise<{ readonly rows: readonly Row[]; readonly total: number }>,
    { staleMs: 15_000 },
  );

  const counts = useStatusCounts(isInvoice ? 'invoices' : 'bills', AR_STATUSES, base);

  useEffect(() => {
    setPage(1);
  }, [from, to, q, status]);

  const open = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      next.delete('new');
      if (id) next.set('id', id);
      else next.delete('id');
      setParams(next, { replace: false });
    },
    [params, setParams],
  );

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const pageIds = rows.map((row) => row.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  async function postOne(row: Row): Promise<boolean> {
    try {
      await invoke(isInvoice ? 'finance.invoices.post' : 'finance.bills.post', { id: row.id });
      return true;
    } catch (caught) {
      toast.error(
        `${isInvoice ? 'Invoice' : 'Bill'} ${row.number ?? ''} could not be posted`,
        isApiError(caught) ? caught.message : 'Try again.',
      );
      return false;
    }
  }

  async function postSelected(): Promise<void> {
    const targets = rows.filter((row) => selected.has(row.id) && row.status === 'draft');
    if (targets.length === 0) {
      toast.info('Nothing to post', 'Only drafts can be posted; select at least one.');
      return;
    }
    setBusy(true);
    let posted = 0;
    for (const row of targets) {
      // Sequential on purpose: each post allocates a number inside its own
      // transaction, and a parallel burst would just queue inside SQLite.
      if (await postOne(row)) posted += 1;
    }
    setBusy(false);
    setSelected(new Set());
    invalidate(isInvoice ? 'invoices' : 'bills');
    invalidate('journals');
    invalidate('tb');
    if (posted > 0) {
      toast.success(
        `${String(posted)} ${posted === 1 ? 'document' : 'documents'} posted`,
        'Debits and credits were written in the same transaction as the number.',
      );
    }
  }

  async function duplicate(row: Row): Promise<void> {
    if (!isInvoice) {
      toast.info('Duplicate is available on invoices', 'A bill is re-entered from the supplier document.');
      return;
    }
    setBusy(true);
    try {
      const copy = await invoke<InvoiceRow>('finance.invoices.duplicate', { id: row.id });
      invalidate('invoices');
      toast.success('Draft created', `${copy.number ?? 'Unnumbered'} was copied from ${row.number ?? 'the original'}.`);
      open(copy.id);
    } catch (caught) {
      toast.error('That invoice could not be duplicated', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function voidDocument(): Promise<void> {
    if (!voidTarget) return;
    setBusy(true);
    try {
      await invoke(isInvoice ? 'finance.invoices.void' : 'finance.bills.void', {
        id: voidTarget.id,
        reason: voidReason.trim(),
      });
      invalidate(isInvoice ? 'invoices' : 'bills');
      invalidate('journals');
      invalidate('tb');
      setVoidTarget(null);
      setVoidReason('');
      setPeek(null);
      toast.success('Document voided', 'A reversing entry was posted; the original stays in the ledger.');
    } catch (caught) {
      toast.error('That document could not be voided', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (openId || isNew) {
    return (
      <DocumentEditor
        docType={docType}
        id={isNew ? null : openId}
        onOpen={(id) => {
          if (id === null) {
            const next = new URLSearchParams(params.toString());
            next.delete('id');
            next.delete('new');
            setParams(next, { replace: false });
          } else {
            open(id);
          }
        }}
      />
    );
  }

  const title = isInvoice ? 'Invoices' : 'Bills';
  const outstanding = rows.reduce((sum, row) => sum + (row.status === 'void' ? 0 : row.balanceCents), 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={title}
        subtitle={`${amount(outstanding)} ${baseCurrency} outstanding on this page`}
        count={total}
        countLabel={isInvoice ? 'invoices' : 'bills'}
        primaryAction={
          canCreate ? (
            <Button
              variant="primary"
              onClick={() => {
                const next = new URLSearchParams(params.toString());
                next.set('new', '1');
                next.delete('id');
                setParams(next, { replace: false });
              }}
            >
              {isInvoice ? 'New invoice' : 'New bill'}
            </Button>
          ) : null
        }
        toolbar={
          <>
            <label className="flex items-center gap-1.5 text-meta text-muted">
              From
              <Input
                type="date"
                aria-label="From date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="h-8 w-36"
              />
            </label>
            <label className="flex items-center gap-1.5 text-meta text-muted">
              To
              <Input
                type="date"
                aria-label="To date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="h-8 w-36"
              />
            </label>
          </>
        }
      />

      <StatusTabs
        ariaLabel={`${title} status`}
        value={status}
        onChange={setStatus}
        items={TABS.map((tab) => ({
          id: tab.id,
          label: tab.label,
          count: tab.id === '' ? total : (counts[tab.id] ?? undefined),
        }))}
      />

      <Toolbar
        search={{ value: q, onChange: setQ, placeholder: isInvoice ? 'Number, customer, memo' : 'Number, vendor, reference' }}
        density={{ value: density, onChange: setDensity }}
      />

      <div className="min-h-0 flex-1 overflow-auto" data-density={density}>
        {list.error ? (
          <div
            className="m-5 flex items-start gap-2 rounded-card border border-danger bg-danger-soft p-3 text-body text-danger"
            role="alert"
          >
            <AlertCircle size={16} aria-hidden="true" />
            <span>{list.error.message}</span>
          </div>
        ) : list.loading && rows.length === 0 ? (
          <TableSkeleton rows={10} columns={7} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={status === '' ? `No ${title.toLowerCase()} yet` : `No ${title.toLowerCase()} with that status`}
            description={
              status === ''
                ? `A ${isInvoice ? 'invoice' : 'bill'} becomes a ledger entry only when it is posted. Drafts cost nothing and can be deleted.`
                : 'Change the status filter or widen the date range.'
            }
            action={
              canCreate && status === '' ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    const next = new URLSearchParams(params.toString());
                    next.set('new', '1');
                    setParams(next, { replace: false });
                  }}
                >
                  {isInvoice ? 'New invoice' : 'New bill'}
                </Button>
              ) : null
            }
          />
        ) : (
          <table className="w-full border-collapse text-body" aria-label={title}>
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr>
                <th scope="col" className="w-8 px-2 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select every row on this page"
                    checked={allSelected}
                    onChange={(event) => setSelected(event.target.checked ? new Set(pageIds) : new Set())}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                </th>
                <th scope="col" className="w-32 px-3 py-2 text-left text-meta font-medium text-muted">Number</th>
                <th scope="col" className="px-3 py-2 text-left text-meta font-medium text-muted">
                  {isInvoice ? 'Customer' : 'Vendor'}
                </th>
                <th scope="col" className="w-28 px-3 py-2 text-left text-meta font-medium text-muted">Date</th>
                <th scope="col" className="w-28 px-3 py-2 text-left text-meta font-medium text-muted">Due</th>
                <th scope="col" className="w-24 px-3 py-2 text-left text-meta font-medium text-muted">Status</th>
                <th scope="col" className="w-32 px-3 py-2 text-right text-meta font-medium text-muted">Total</th>
                <th scope="col" className="w-32 px-3 py-2 text-right text-meta font-medium text-muted">Balance</th>
                <th scope="col" className="w-24 px-2 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const partnerName = isInvoice ? (row as InvoiceRow).customerName : (row as BillRow).vendorName;
                const reference = isInvoice ? null : (row as BillRow).vendorRef;
                return (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    onClick={() => setPeek(row)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') open(row.id);
                      if (event.key === ' ') {
                        event.preventDefault();
                        setPeek(row);
                      }
                      if (event.key.toLowerCase() === 'x') toggle(row.id);
                    }}
                    className="group cursor-pointer border-b border-line transition-colors duration-fast hover:bg-surface-2"
                    style={{ height: 'var(--row-h)' }}
                  >
                    <td className="px-2" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.number ?? 'draft'}`}
                        checked={selected.has(row.id)}
                        onChange={() => toggle(row.id)}
                        className="h-4 w-4 accent-[var(--accent)]"
                      />
                    </td>
                    <td className="px-3 font-mono text-code text-text">
                      {row.number ?? <span className="text-muted">Draft</span>}
                    </td>
                    <td className="truncate px-3 text-text">
                      {partnerName}
                      {reference ? <span className="ml-2 text-meta text-muted">· {reference}</span> : null}
                    </td>
                    <td className="px-3 tabular-nums text-muted">{fmtDate(row.date)}</td>
                    <td className="px-3 tabular-nums text-muted">
                      {fmtDate(row.dueDate)}
                      {row.daysOverdue > 0 ? (
                        <span className="ml-1 text-[11px] text-danger">{row.daysOverdue}d</span>
                      ) : null}
                    </td>
                    <td className="px-3">
                      <Badge status={row.status} label={titleCase(row.status)} />
                    </td>
                    <td className="px-3 text-right">
                      <MoneyCell>{amount(row.totalCents)}</MoneyCell>
                    </td>
                    <td className="px-3 text-right">
                      <MoneyCell muted={row.balanceCents === 0}>{amount(row.balanceCents)}</MoneyCell>
                    </td>
                    <td className="px-2 text-right" onClick={(event) => event.stopPropagation()}>
                      <div className="flex justify-end gap-0.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100">
                        <Tooltip label="Peek">
                          <IconButton label={`Peek at ${row.number ?? 'draft'}`} size="sm" onClick={() => setPeek(row)}>
                            <Eye size={13} aria-hidden="true" />
                          </IconButton>
                        </Tooltip>
                        {canPost && row.status === 'draft' ? (
                          <Tooltip label="Post">
                            <IconButton
                              label={`Post ${row.number ?? 'draft'}`}
                              size="sm"
                              onClick={() => {
                                void postOne(row).then((ok) => {
                                  if (ok) {
                                    invalidate(isInvoice ? 'invoices' : 'bills');
                                    invalidate('journals');
                                    invalidate('tb');
                                    toast.success('Posted', 'A number was allocated at post time.');
                                  }
                                });
                              }}
                            >
                              <CheckCircle2 size={13} aria-hidden="true" />
                            </IconButton>
                          </Tooltip>
                        ) : null}
                        {isInvoice ? (
                          <Tooltip label="Duplicate">
                            <IconButton label={`Duplicate ${row.number ?? 'draft'}`} size="sm" onClick={() => void duplicate(row)}>
                              <Copy size={13} aria-hidden="true" />
                            </IconButton>
                          </Tooltip>
                        ) : null}
                        {canVoid && row.status !== 'void' && row.status !== 'draft' ? (
                          <Tooltip label="Void">
                            <IconButton
                              label={`Void ${row.number ?? 'draft'}`}
                              size="sm"
                              onClick={() => {
                                setVoidTarget(row);
                                setVoidReason('');
                              }}
                            >
                              <Ban size={13} aria-hidden="true" />
                            </IconButton>
                          </Tooltip>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <BulkBar count={selected.size} onClear={() => setSelected(new Set())}>
        {canPost ? (
          <Button size="sm" variant="primary" loading={busy} onClick={() => void postSelected()}>
            Post selected
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const first = rows.find((row) => selected.has(row.id));
            if (first) open(first.id);
          }}
        >
          Open the first
        </Button>
      </BulkBar>

      <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />

      {/* ── peek ──────────────────────────────────────────────────────────── */}
      <Drawer
        open={peek !== null}
        onOpenChange={(openNow) => (openNow ? undefined : setPeek(null))}
        title={peek ? `${peek.number ?? 'Draft'} · ${isInvoice ? (peek as InvoiceRow).customerName : (peek as BillRow).vendorName}` : ''}
        subtitle={peek ? `${fmtDate(peek.date)} · due ${fmtDate(peek.dueDate)} · ${peek.currency}` : undefined}
        status={peek ? { status: peek.status, label: titleCase(peek.status) } : undefined}
        footer={
          peek ? (
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPeek(null)}>
                Close
              </Button>
              <Button variant="primary" size="sm" onClick={() => open(peek.id)}>
                Open the document
              </Button>
            </div>
          ) : null
        }
      >
        {peek ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-2 text-body">
              <dt className="text-muted">Total</dt>
              <dd className="text-right">
                <MoneyCell>{amount(peek.totalCents)}</MoneyCell>
              </dd>
              <dt className="text-muted">Paid</dt>
              <dd className="text-right">
                <MoneyCell>{amount(peek.paidCents)}</MoneyCell>
              </dd>
              <dt className="text-muted">Balance</dt>
              <dd className="text-right">
                <MoneyCell>{amount(peek.balanceCents)}</MoneyCell>
              </dd>
              <dt className="text-muted">Tax</dt>
              <dd className="text-right">
                <MoneyCell muted>{amount(peek.taxCents)}</MoneyCell>
              </dd>
              {peek.daysOverdue > 0 ? (
                <>
                  <dt className="text-muted">Overdue by</dt>
                  <dd className="text-right text-danger">{peek.daysOverdue} days</dd>
                </>
              ) : null}
              {!isInvoice && (peek as BillRow).vendorRef ? (
                <>
                  <dt className="text-muted">Their reference</dt>
                  <dd className="text-right">{(peek as BillRow).vendorRef}</dd>
                </>
              ) : null}
              <dt className="text-muted">Posted</dt>
              <dd className="text-right">{peek.postedAt ? fmtDate(peek.postedAt.slice(0, 10)) : 'Not posted'}</dd>
            </dl>

            {peek.notes ? (
              <div className="rounded-card border border-line bg-surface-2 p-3">
                <p className="micro">Notes</p>
                <p className="mt-1 whitespace-pre-wrap text-body text-text">{peek.notes}</p>
              </div>
            ) : null}

            <p className="text-meta text-muted">
              {humanise(peek.status)} documents cannot be edited. Voiding posts a reversing entry, so the audit trail
              keeps both sides of the correction.
            </p>
          </div>
        ) : null}
      </Drawer>

      {/* ── void ──────────────────────────────────────────────────────────── */}
      <Modal
        open={voidTarget !== null}
        onOpenChange={(openNow) => (openNow ? undefined : setVoidTarget(null))}
        title={`Void ${voidTarget?.number ?? 'this document'}`}
        description="A reversing entry is posted with debits and credits swapped. The original stays in the ledger, marked void."
        size="sm"
        destructive
        busy={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setVoidTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} disabled={voidReason.trim().length < 3} onClick={() => void voidDocument()}>
              Void document
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1">
          <span className="micro">Reason (recorded in the audit log)</span>
          <Input
            autoFocus
            value={voidReason}
            onChange={(event) => setVoidReason(event.target.value)}
            placeholder="Raised against the wrong customer"
          />
        </label>
      </Modal>
    </div>
  );
}
