/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Purchasing → Bills (T08 gap closure, US-31).
 *
 * This screen used to be `export { Bills } from '../finance/Bills'`. That was
 * wrong for one reason: the purchasing team's job is not "list the bills", it is
 * **reconcile** them. A finance clerk cares about what is owed and when; a buyer
 * cares about whether the supplier billed for what was actually ordered and
 * received. Re-exporting the finance page gave them the first question and hid
 * the second one behind a badge they had to click into.
 *
 * So this screen has two jobs and two tabs:
 *
 *   1. **Bills** — vendor-scoped, with a *three-way match panel* per bill:
 *      ordered (PO price) vs received (receipt quantity) vs billed (invoice
 *      line). Each line is marked `ok`, `qty` or `price`, with the delta in both
 *      basis points and cents, and the tolerance that decided it.
 *   2. **Receipts to bill** — posted receipts with no bill against them. This is
 *      the accrual sitting on the balance sheet; every day it stays there is a
 *      day the payables figure is wrong. One click turns a receipt into a draft
 *      bill, carrying the PO price and received quantity across so the match is
 *      *true by construction* rather than reconstructed later.
 *
 * Nothing here posts. Creating a draft is safe and reversible; posting a bill is
 * a finance action and stays on the finance screen with its permission.
 */

import { AlertCircle, FileCheck2, Receipt as ReceiptIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { BillInput, BillRow } from '@shared/finance';
import type { MatchResult, ReceiptRow } from '@shared/ops';
import type { Paged } from '@shared/types';

import { Drawer } from '../../components/Drawer';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, MoneyCell, Pagination, StatusTabs, TableSkeleton, Toolbar } from '../../components/patterns';
import { Badge, Button, Chip, Input, Select } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import { addDays, today } from '../../lib/finance';
import { amount, date as fmtDate, titleCase } from '../../lib/format';
import { toast } from '../../lib/toast';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useSession } from '../../store';

const PAGE_SIZE = 50;

type Tab = 'bills' | 'receipts';

interface VendorOption {
  readonly id: string;
  readonly name: string;
}

const STATUS_TABS: readonly { readonly id: string; readonly label: string }[] = [
  { id: '', label: 'All' },
  { id: 'draft', label: 'Draft' },
  { id: 'posted', label: 'Posted' },
  { id: 'partially_paid', label: 'Part paid' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'paid', label: 'Paid' },
  { id: 'void', label: 'Void' },
];

/** How a match line reads at a glance. */
function matchTone(status: 'ok' | 'qty' | 'price'): 'success' | 'warning' | 'danger' {
  if (status === 'ok') return 'success';
  if (status === 'qty') return 'danger';
  return 'warning';
}

export function PurchasingBills(): JSX.Element {
  const baseCurrency = useSession((state) => state.company?.baseCurrency ?? 'USD');
  const canCreateBill = useSession((state) => state.can('finance.bill.create'));

  const [tab, setTab] = useState<Tab>('bills');
  const [vendorId, setVendorId] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState(() => addDays(today(), -365));
  const [to, setTo] = useState(() => today());
  const [page, setPage] = useState(1);
  const [peek, setPeek] = useState<BillRow | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [vendorId, status, q, from, to, tab]);

  const vendors = useQuery<readonly VendorOption[]>(
    'pb:vendors',
    () =>
      invoke<Paged<VendorOption>>('entity.list', {
        entity: 'vendors',
        limit: 200,
        sort: { key: 'name', dir: 'asc' },
      }).then((result) => result.rows),
    { staleMs: 60_000 },
  );

  const vendorOptions = useMemo(
    () => (vendors.data ?? []).map((row) => ({ value: row.id, label: row.name })),
    [vendors.data],
  );

  const billFilter = useMemo(
    () => ({
      from,
      to,
      ...(vendorId ? { vendorId } : {}),
      ...(status ? { status } : {}),
      ...(q.trim() ? { q: q.trim() } : {}),
      page,
      pageSize: PAGE_SIZE,
    }),
    [from, to, vendorId, status, q, page],
  );

  const bills = useQuery<Paged<BillRow>>(
    `pb:bills:${JSON.stringify(billFilter)}`,
    () => invoke<Paged<BillRow>>('finance.bills.list', billFilter),
    { staleMs: 15_000, enabled: tab === 'bills' },
  );

  const receipts = useQuery<Paged<ReceiptRow>>(
    `pb:receipts:${vendorId}:${page}`,
    () =>
      invoke<Paged<ReceiptRow>>('purchasing.receipt.list', {
        status: 'posted',
        ...(vendorId ? { vendorId } : {}),
        page,
        pageSize: PAGE_SIZE,
      }),
    { staleMs: 15_000, enabled: tab === 'receipts' },
  );

  // The receipt list includes already-billed receipts; the tab is about the ones
  // that are *not* billed yet, so the filter happens here rather than on the
  // server — the server has no "bill_id IS NULL" filter and inventing one for a
  // single screen would be a channel nobody else uses.
  const unbilled = (receipts.data?.rows ?? []).filter((row) => row.billId === null);

  const match = useQuery<MatchResult | null>(
    `pb:match:${peek?.id ?? 'none'}`,
    () => (peek ? invoke<MatchResult>('purchasing.match.preview', { id: peek.id }) : Promise.resolve(null)),
    { staleMs: 5_000, enabled: peek !== null },
  );

  const raiseBill = useCallback(
    async (receipt: ReceiptRow): Promise<void> => {
      setBusy(true);
      try {
        // The prefill comes from the main process, which reads the receipt, the
        // PO line and the vendor's terms. The renderer never assembles a bill.
        const draft = await invoke<BillInput>('purchasing.bill.fromReceipt', { id: receipt.id });
        const saved = await invoke<BillRow>('finance.bills.save', draft);
        invalidate('bills');
        invalidate('pb:');
        invalidate('ops:');
        toast.success(
          'Draft bill created',
          `${saved.number ?? 'Draft'} was built from ${receipt.number ?? 'the receipt'}. Review it, then post it in Finance.`,
        );
        setTab('bills');
      } catch (caught) {
        toast.error('That receipt could not be billed', isApiError(caught) ? caught.message : 'Try again.');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const rows = bills.data?.rows ?? [];
  const total = bills.data?.total ?? 0;
  const unpaidOnPage = rows.reduce((sum, row) => sum + (row.status === 'void' ? 0 : row.balanceCents), 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Bills"
        subtitle={
          tab === 'bills'
            ? `${amount(unpaidOnPage)} ${baseCurrency} outstanding on this page · match each bill against what was ordered and received`
            : `${String(unbilled.length)} posted receipt${unbilled.length === 1 ? '' : 's'} on this page with no bill yet`
        }
        count={tab === 'bills' ? total : unbilled.length}
        countLabel={tab === 'bills' ? 'bills' : 'receipts'}
        toolbar={
          <>
            <Select
              aria-label="Vendor"
              value={vendorId}
              placeholder="All vendors"
              options={vendorOptions}
              onChange={(event) => setVendorId(event.target.value)}
              className="h-8 w-48"
            />
            {tab === 'bills' ? (
              <>
                <Input
                  type="date"
                  aria-label="From"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  className="h-8 w-36"
                />
                <Input
                  type="date"
                  aria-label="To"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  className="h-8 w-36"
                />
              </>
            ) : null}
          </>
        }
      />

      <StatusTabs
        ariaLabel="Bills view"
        value={tab}
        onChange={(value) => setTab(value as Tab)}
        items={[
          { id: 'bills', label: 'Bills', count: total },
          { id: 'receipts', label: 'Receipts to bill', count: unbilled.length },
        ]}
      />

      {tab === 'bills' ? (
        <StatusTabs
          ariaLabel="Bill status"
          value={status}
          onChange={setStatus}
          items={STATUS_TABS.map((entry) => ({ id: entry.id, label: entry.label }))}
        />
      ) : null}

      <Toolbar
        search={
          tab === 'bills'
            ? { value: q, onChange: setQ, placeholder: 'Number, vendor, their reference' }
            : undefined
        }
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        {tab === 'bills' ? (
          bills.error ? (
            <div className="flex items-start gap-2 rounded-card border border-danger bg-danger-soft p-3 text-body text-danger" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{bills.error.message}</span>
            </div>
          ) : bills.loading && rows.length === 0 ? (
            <TableSkeleton rows={10} columns={8} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No bills in this view"
              description="Widen the date range, clear the vendor filter, or bill a receipt from the other tab."
              action={
                <Button variant="secondary" onClick={() => setTab('receipts')}>
                  See receipts to bill
                </Button>
              }
            />
          ) : (
            <table className="w-full border-separate border-spacing-0 text-body" aria-label="Vendor bills">
              <thead>
                <tr>
                  {['Number', 'Vendor', 'Their ref', 'Date', 'Due', 'Status', 'Total', 'Balance'].map((label, index) => (
                    <th
                      key={label}
                      scope="col"
                      className={`micro sticky top-0 z-10 border-b border-border bg-surface px-3 py-2 ${
                        index >= 6 ? 'text-right' : 'text-left'
                      }`}
                    >
                      {label}
                    </th>
                  ))}
                  <th scope="col" className="micro sticky top-0 z-10 w-28 border-b border-border bg-surface px-3 py-2 text-right">
                    Match
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    onClick={() => setPeek(row)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setPeek(row);
                      }
                    }}
                    className="cursor-pointer border-b border-border/60 hover:bg-hover"
                  >
                    <td className="px-3 py-2 font-mono text-code text-text">{row.number ?? 'Draft'}</td>
                    <td className="truncate px-3 py-2 text-text">{row.vendorName}</td>
                    <td className="truncate px-3 py-2 text-meta text-muted">{row.vendorRef ?? '—'}</td>
                    <td className="tnum px-3 py-2 text-muted">{fmtDate(row.date)}</td>
                    <td className="tnum px-3 py-2 text-muted">
                      {fmtDate(row.dueDate)}
                      {row.daysOverdue > 0 ? <span className="ml-1 text-[11px] text-danger">{row.daysOverdue}d</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      <Badge status={row.status} label={titleCase(row.status)} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <MoneyCell>{amount(row.totalCents)}</MoneyCell>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <MoneyCell muted={row.balanceCents === 0}>{amount(row.balanceCents)}</MoneyCell>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="ghost" onClick={(event) => {
                        event.stopPropagation();
                        setPeek(row);
                      }}>
                        Check
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : receipts.error ? (
          <div className="flex items-start gap-2 rounded-card border border-danger bg-danger-soft p-3 text-body text-danger" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{receipts.error.message}</span>
          </div>
        ) : receipts.loading && unbilled.length === 0 ? (
          <TableSkeleton rows={6} columns={6} />
        ) : unbilled.length === 0 ? (
          <EmptyState
            title="Every posted receipt has a bill"
            description="Goods received but not billed is an accrual. When this list is empty, the payables figure matches the receipts."
          />
        ) : (
          <table className="w-full border-separate border-spacing-0 text-body" aria-label="Receipts awaiting a bill">
            <thead>
              <tr>
                {['Receipt', 'Against order', 'Vendor', 'Received', 'Value', ''].map((label, index) => (
                  <th
                    key={`${label}:${String(index)}`}
                    scope="col"
                    className={`micro sticky top-0 z-10 border-b border-border bg-surface px-3 py-2 ${
                      label === 'Value' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {unbilled.map((row) => (
                <tr key={row.id} className="border-b border-border/60">
                  <td className="px-3 py-2 font-mono text-code text-text">{row.number ?? 'Draft'}</td>
                  <td className="px-3 py-2 text-muted">{row.poNumber ?? '—'}</td>
                  <td className="truncate px-3 py-2 text-text">{row.vendorName}</td>
                  <td className="tnum px-3 py-2 text-muted">{fmtDate(row.date)}</td>
                  <td className="px-3 py-2 text-right">
                    <MoneyCell>{amount(row.totalCents)}</MoneyCell>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy}
                      disabled={!canCreateBill}
                      iconLeft={<ReceiptIcon size={13} aria-hidden="true" />}
                      onClick={() => void raiseBill(row)}
                    >
                      Raise bill
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'bills' && total > PAGE_SIZE ? (
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
        ) : null}
      </div>

      {/* ── three-way match ───────────────────────────────────────────────── */}
      <Drawer
        open={peek !== null}
        onOpenChange={(open) => (open ? undefined : setPeek(null))}
        title={peek ? `${peek.number ?? 'Draft'} · ${peek.vendorName}` : ''}
        subtitle={peek ? `${fmtDate(peek.date)} · their ref ${peek.vendorRef ?? '—'} · ${peek.currency}` : undefined}
        width={720}
        footer={
          peek ? (
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPeek(null)}>
                Close
              </Button>
              <span className="text-meta text-muted">
                Posting happens in Finance — this screen only reconciles.
              </span>
            </div>
          ) : null
        }
      >
        {peek ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-[10rem_minmax(0,1fr)] gap-y-1.5 text-body">
              <dt className="text-muted">Total</dt>
              <dd className="text-right">
                <MoneyCell>{amount(peek.totalCents)}</MoneyCell>
              </dd>
              <dt className="text-muted">Balance</dt>
              <dd className="text-right">
                <MoneyCell muted={peek.balanceCents === 0}>{amount(peek.balanceCents)}</MoneyCell>
              </dd>
              <dt className="text-muted">Their reference</dt>
              <dd className="text-right">{peek.vendorRef ?? '—'}</dd>
            </dl>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-meta font-medium text-text">Three-way match</h3>
                {match.data ? (
                  <Chip tone={match.data.withinTolerance ? 'success' : 'danger'}>
                    {match.data.withinTolerance ? 'within tolerance' : 'outside tolerance'}
                  </Chip>
                ) : null}
              </div>

              {match.loading && !match.data ? (
                <TableSkeleton rows={3} columns={6} />
              ) : match.error ? (
                <p className="rounded-card border border-line bg-surface-2 p-3 text-meta text-muted">
                  {match.error.message}
                </p>
              ) : match.data ? (
                <>
                  <table className="w-full border-collapse text-body">
                    <thead>
                      <tr className="bg-surface-2 text-meta text-muted">
                        <th scope="col" className="border-b border-line px-2 py-1.5 text-left font-medium">Line</th>
                        <th scope="col" className="border-b border-line px-2 py-1.5 text-right font-medium">Received</th>
                        <th scope="col" className="border-b border-line px-2 py-1.5 text-right font-medium">Billed</th>
                        <th scope="col" className="border-b border-line px-2 py-1.5 text-right font-medium">PO price</th>
                        <th scope="col" className="border-b border-line px-2 py-1.5 text-right font-medium">Bill price</th>
                        <th scope="col" className="border-b border-line px-2 py-1.5 text-right font-medium">Δ</th>
                        <th scope="col" className="border-b border-line px-2 py-1.5 text-left font-medium">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {match.data.lines.map((line) => (
                        <tr key={line.billLineId} className="border-b border-line last:border-0">
                          <td className="max-w-[14rem] truncate px-2 py-1.5 text-text">{line.description}</td>
                          <td className="tnum px-2 py-1.5 text-right text-muted">
                            {(line.receivedMilli / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })}
                          </td>
                          <td className="tnum px-2 py-1.5 text-right text-text">
                            {(line.billedMilli / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })}
                          </td>
                          <td className="tnum px-2 py-1.5 text-right text-muted">
                            {line.poPriceCents === null ? '—' : amount(line.poPriceCents)}
                          </td>
                          <td className="tnum px-2 py-1.5 text-right text-text">{amount(line.billPriceCents)}</td>
                          <td className="tnum px-2 py-1.5 text-right">
                            <span className={line.totalDeltaCents === 0 ? 'text-muted' : 'text-danger'}>
                              {line.totalDeltaCents === 0 ? '—' : amount(line.totalDeltaCents)}
                            </span>
                            {line.priceDeltaBp !== 0 ? (
                              <span className="ml-1 text-[11px] text-muted">{(line.priceDeltaBp / 100).toFixed(2)}%</span>
                            ) : null}
                          </td>
                          <td className="px-2 py-1.5">
                            <Chip tone={matchTone(line.status)}>{line.status}</Chip>
                            {line.note ? <span className="ml-1 text-[11px] text-muted">{line.note}</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <p className="mt-2 text-meta text-muted">
                    Tolerance {match.data.toleranceBp / 100}% or {amount(match.data.toleranceAbsCents)} per line.
                    {match.data.reasons.length > 0 ? ` ${match.data.reasons.join(' · ')}` : ' No exceptions.'}
                  </p>
                </>
              ) : (
                <p className="text-meta text-muted">
                  <FileCheck2 size={13} className="mr-1 inline" aria-hidden="true" />
                  This bill has no purchase order behind it, so there is nothing to match against. That is normal for a
                  service or a one-off purchase.
                </p>
              )}
            </section>

            {peek.notes ? (
              <div className="rounded-card border border-line bg-surface-2 p-3">
                <p className="micro">Notes</p>
                <p className="mt-1 whitespace-pre-wrap text-body text-text">{peek.notes}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
