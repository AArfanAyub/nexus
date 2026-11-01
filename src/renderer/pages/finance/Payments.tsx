/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Payments (T06) — receipts, disbursements and allocation.
 *
 * Two-step on purpose, because that is how the money actually arrives:
 *
 *   1. **Record** the payment. This posts one journal entry (bank against the
 *      control account) and leaves the whole amount unallocated.
 *   2. **Allocate** it against open documents. Allocation never posts a journal
 *      entry — the money has already moved — it only moves the open balance, and
 *      it refuses to over-allocate either the payment or the document, naming
 *      the figure that is actually available.
 *
 * A payment can therefore sit partly unallocated, which is the honest state for
 * an unidentified bank receipt, and the list shows that figure rather than
 * pretending every payment is applied.
 */

import { AlertCircle, Plus, Receipt } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import type {
  AllocationInput,
  BillRow,
  InvoiceRow,
  PaymentDetail,
  PaymentMethod,
  PaymentRow,
} from '@shared/finance';
import { cents, formatAmount, parseCents } from '@shared/money';

import { Drawer } from '../../components/Drawer';
import { Modal } from '../../components/Modal';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, MoneyCell, Pagination, TableSkeleton, Toolbar } from '../../components/patterns';
import { Badge, Button, Chip, Input, Select, Textarea } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import {
  addDays,
  fetchBills,
  fetchInvoices,
  fetchPayment,
  fetchPayments,
  fk,
  today,
  useLookup,
} from '../../lib/finance';
import { amount, date as fmtDate, humanise, titleCase } from '../../lib/format';
import { toast } from '../../lib/toast';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useSession } from '../../store';

const PAGE_SIZE = 50;

const METHODS: readonly PaymentMethod[] = ['bank', 'cash', 'card', 'cheque', 'transfer', 'other'];

interface DraftPayment {
  readonly direction: 'in' | 'out';
  readonly partnerType: 'customer' | 'vendor';
  readonly partnerId: string;
  readonly date: string;
  readonly method: PaymentMethod;
  readonly reference: string;
  readonly amount: string;
  readonly currency: string;
  readonly bankAccountId: string;
  readonly notes: string;
}

function emptyDraft(currency: string): DraftPayment {
  return {
    direction: 'in',
    partnerType: 'customer',
    partnerId: '',
    date: today(),
    method: 'bank',
    reference: '',
    amount: '',
    currency,
    bankAccountId: '',
    notes: '',
  };
}

export function Payments(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const baseCurrency = useSession((state) => state.company?.baseCurrency ?? 'USD');
  const canCreate = useSession((state) => state.can('finance.payment.create'));

  const openId = params.get('id');
  const [from, setFrom] = useState(() => addDays(today(), -365));
  const [to, setTo] = useState(() => today());
  const [direction, setDirection] = useState<'' | 'in' | 'out'>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  const [draft, setDraft] = useState<DraftPayment | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [allocateFor, setAllocateFor] = useState<string | null>(null);
  const [allocations, setAllocations] = useState<Record<string, string>>({});

  const customers = useLookup('customers');
  const vendors = useLookup('vendors');

  const filter = useMemo(
    () => ({
      from,
      to,
      direction: direction === '' ? undefined : direction,
      q: q.trim() === '' ? undefined : q.trim(),
      page,
      pageSize: PAGE_SIZE,
    }),
    [from, to, direction, q, page],
  );

  const list = useQuery<{ readonly rows: readonly PaymentRow[]; readonly total: number }>(
    fk.payments(filter),
    () => fetchPayments(filter),
    { staleMs: 15_000 },
  );

  const detail = useQuery<PaymentDetail>(fk.payment(openId ?? 'none'), () => fetchPayment(openId ?? ''), {
    enabled: openId !== null,
    staleMs: 15_000,
  });

  useEffect(() => {
    setPage(1);
  }, [from, to, direction, q]);

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  const openDetail = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set('id', id);
      else next.delete('id');
      setParams(next, { replace: false });
    },
    [params, setParams],
  );

  async function record(): Promise<void> {
    if (!draft) return;
    setFormError(null);
    const amountCents = toCentsSafe(draft.amount);
    if (draft.partnerId === '') {
      setFormError('Choose a partner first.');
      return;
    }
    if (amountCents <= 0) {
      setFormError('Enter an amount greater than zero.');
      return;
    }
    setBusy(true);
    try {
      const created = await invoke<PaymentDetail>('finance.payments.create', {
        direction: draft.direction,
        partnerType: draft.partnerType,
        partnerId: draft.partnerId,
        date: draft.date,
        method: draft.method,
        reference: draft.reference.trim() === '' ? null : draft.reference.trim(),
        amountCents,
        currency: draft.currency,
        bankAccountId: draft.bankAccountId === '' ? null : draft.bankAccountId,
        notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
      });
      invalidate('payments');
      invalidate('invoices');
      invalidate('bills');
      invalidate('journals');
      invalidate('tb');
      setDraft(null);
      openDetail(created.id);
      setAllocateFor(created.id);
      setAllocations({});
      toast.success(
        draft.direction === 'in' ? 'Receipt recorded' : 'Payment recorded',
        'The bank side is posted. Allocation moves the open balance without a second entry.',
      );
    } catch (caught) {
      setFormError(isApiError(caught) ? caught.message : 'That payment could not be recorded.');
    } finally {
      setBusy(false);
    }
  }

  async function allocate(paymentId: string): Promise<void> {
    const entries: AllocationInput[] = Object.entries(allocations)
      .map(([key, text]) => {
        const value = toCentsSafe(text);
        const [kind, id] = key.split(':');
        return kind === 'invoice'
          ? { invoiceId: id, amountCents: value }
          : { billId: id, amountCents: value };
      })
      .filter((entry) => entry.amountCents > 0);
    if (entries.length === 0) {
      toast.info('Nothing to allocate', 'Type an amount against at least one document.');
      return;
    }
    setBusy(true);
    try {
      await invoke('finance.payments.allocate', { id: paymentId, allocations: entries });
      invalidate('payments');
      invalidate('invoices');
      invalidate('bills');
      invalidate(fk.payment(paymentId));
      setAllocateFor(null);
      setAllocations({});
      toast.success('Allocation saved', 'Document balances and statuses were recomputed from the allocations.');
    } catch (caught) {
      toast.error('That allocation was refused', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Payments"
        subtitle="Receipts and disbursements, with allocation against open documents"
        count={total}
        countLabel="payments"
        secondaryActions={
          <Button variant="ghost" onClick={() => openDetail(null)} disabled={openId === null}>
            Back to the list
          </Button>
        }
        primaryAction={
          canCreate ? (
            <Button
              variant="primary"
              iconLeft={<Plus size={14} aria-hidden="true" />}
              onClick={() => {
                setFormError(null);
                setDraft(emptyDraft(baseCurrency));
              }}
            >
              Record payment
            </Button>
          ) : null
        }
        toolbar={
          <>
            <Input type="date" aria-label="From" value={from} onChange={(event) => setFrom(event.target.value)} className="h-8 w-36" />
            <Input type="date" aria-label="To" value={to} onChange={(event) => setTo(event.target.value)} className="h-8 w-36" />
          </>
        }
      />

      <Toolbar
        search={{ value: q, onChange: setQ, placeholder: 'Reference, partner, number' }}
        chips={
          direction === ''
            ? []
            : [
                {
                  id: 'direction',
                  label: direction === 'in' ? 'Money in' : 'Money out',
                  onRemove: () => setDirection(''),
                },
              ]
        }
        extra={
          <div className="flex items-center gap-1">
            {(['', 'in', 'out'] as const).map((value) => (
              <Button
                key={value === '' ? 'all' : value}
                size="sm"
                variant={direction === value ? 'secondary' : 'ghost'}
                onClick={() => setDirection(value)}
              >
                {value === '' ? 'All' : value === 'in' ? 'Money in' : 'Money out'}
              </Button>
            ))}
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        {list.error ? (
          <div className="m-5 flex items-start gap-2 rounded-card border border-danger bg-danger-soft p-3 text-body text-danger" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{list.error.message}</span>
          </div>
        ) : list.loading && rows.length === 0 ? (
          <TableSkeleton rows={8} columns={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No payments in this range"
            description="Record a receipt to post the bank side, then allocate it against the invoices it settles."
            action={
              canCreate ? (
                <Button variant="primary" onClick={() => setDraft(emptyDraft(baseCurrency))}>
                  Record payment
                </Button>
              ) : null
            }
          />
        ) : (
          <table className="w-full border-collapse text-body" aria-label="Payments">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr>
                <th scope="col" className="w-32 px-3 py-2 text-left text-meta font-medium text-muted">Number</th>
                <th scope="col" className="w-24 px-3 py-2 text-left text-meta font-medium text-muted">Direction</th>
                <th scope="col" className="px-3 py-2 text-left text-meta font-medium text-muted">Partner</th>
                <th scope="col" className="w-28 px-3 py-2 text-left text-meta font-medium text-muted">Date</th>
                <th scope="col" className="w-24 px-3 py-2 text-left text-meta font-medium text-muted">Method</th>
                <th scope="col" className="w-32 px-3 py-2 text-right text-meta font-medium text-muted">Amount</th>
                <th scope="col" className="w-32 px-3 py-2 text-right text-meta font-medium text-muted">Unallocated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  onClick={() => openDetail(row.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') openDetail(row.id);
                  }}
                  className="cursor-pointer border-b border-line transition-colors duration-fast hover:bg-surface-2"
                  style={{ height: 'var(--row-h)' }}
                >
                  <td className="px-3 font-mono text-code text-text">{row.number ?? '—'}</td>
                  <td className="px-3">
                    <Chip tone={row.direction === 'in' ? 'success' : 'warning'}>
                      {row.direction === 'in' ? 'In' : 'Out'}
                    </Chip>
                  </td>
                  <td className="truncate px-3 text-text">
                    {row.partnerName}
                    {row.reference ? <span className="ml-2 text-meta text-muted">· {row.reference}</span> : null}
                  </td>
                  <td className="px-3 tabular-nums text-muted">{fmtDate(row.date)}</td>
                  <td className="px-3 text-meta text-muted">{titleCase(row.method)}</td>
                  <td className="px-3 text-right">
                    <MoneyCell>{amount(row.amountCents)}</MoneyCell>
                  </td>
                  <td className="px-3 text-right">
                    <MoneyCell muted={row.unallocatedCents === 0}>{amount(row.unallocatedCents)}</MoneyCell>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />

      {/* ── detail ────────────────────────────────────────────────────────── */}
      <Drawer
        open={openId !== null}
        onOpenChange={(open) => (open ? undefined : openDetail(null))}
        width={520}
        title={detail.data ? `${detail.data.number ?? 'Payment'} · ${detail.data.partnerName}` : 'Payment'}
        subtitle={detail.data ? `${fmtDate(detail.data.date)} · ${titleCase(detail.data.method)}` : undefined}
        status={detail.data ? { status: detail.data.direction === 'in' ? 'posted' : 'pending', label: detail.data.direction === 'in' ? 'Money in' : 'Money out' } : undefined}
        footer={
          detail.data && canCreate ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-meta text-muted">
                {detail.data.unallocatedCents > 0 ? `${amount(detail.data.unallocatedCents)} unallocated` : 'Fully allocated'}
              </span>
              <Button
                variant="primary"
                size="sm"
                iconLeft={<Receipt size={13} aria-hidden="true" />}
                disabled={detail.data.unallocatedCents <= 0}
                onClick={() => {
                  setAllocations({});
                  setAllocateFor(detail.data?.id ?? null);
                }}
              >
                Allocate
              </Button>
            </div>
          ) : null
        }
      >
        {detail.error ? (
          <p className="text-body text-danger" role="alert">
            {detail.error.message}
          </p>
        ) : !detail.data ? (
          <TableSkeleton rows={5} columns={2} />
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-2 text-body">
              <dt className="text-muted">Amount</dt>
              <dd className="text-right">
                <MoneyCell>{amount(detail.data.amountCents)}</MoneyCell>
              </dd>
              <dt className="text-muted">Unallocated</dt>
              <dd className="text-right">
                <MoneyCell>{amount(detail.data.unallocatedCents)}</MoneyCell>
              </dd>
              {detail.data.fxDifferenceCents !== 0 ? (
                <>
                  <dt className="text-muted">Realised FX</dt>
                  <dd className="text-right">
                    <MoneyCell>{amount(detail.data.fxDifferenceCents)}</MoneyCell>
                  </dd>
                </>
              ) : null}
              <dt className="text-muted">Reference</dt>
              <dd className="text-right">{detail.data.reference ?? '—'}</dd>
              <dt className="text-muted">Currency</dt>
              <dd className="text-right">{detail.data.currency}</dd>
              <dt className="text-muted">Entry</dt>
              <dd className="text-right font-mono text-code">{detail.data.journalEntryId ? 'Posted' : 'Not posted'}</dd>
            </dl>

            <div>
              <p className="micro mb-1.5">Allocations</p>
              {detail.data.allocations.length === 0 ? (
                <p className="rounded-card border border-dashed border-line-strong px-3 py-4 text-center text-meta text-muted">
                  Nothing allocated yet. The payment is recorded and the money has moved; allocation is what marks the
                  documents settled.
                </p>
              ) : (
                <ul className="divide-y divide-line rounded-card border border-line">
                  {detail.data.allocations.map((allocation) => (
                    <li key={allocation.id} className="flex items-center justify-between px-3 py-1.5 text-body">
                      <span>
                        <Chip tone="neutral">{allocation.docType === 'invoice' ? 'Invoice' : 'Bill'}</Chip>{' '}
                        <span className="font-mono text-code">{allocation.docNumber ?? allocation.docId}</span>
                      </span>
                      <MoneyCell>{amount(allocation.amountCents)}</MoneyCell>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {detail.data.notes ? (
              <div className="rounded-card border border-line bg-surface-2 p-3">
                <p className="micro">Notes</p>
                <p className="mt-1 whitespace-pre-wrap text-body text-text">{detail.data.notes}</p>
              </div>
            ) : null}
          </div>
        )}
      </Drawer>

      {/* ── record ────────────────────────────────────────────────────────── */}
      <Modal
        open={draft !== null}
        onOpenChange={(open) => (open ? undefined : setDraft(null))}
        title="Record a payment"
        description="This posts the bank side immediately. Allocation against documents is the next step."
        size="md"
        busy={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!draft} onClick={() => void record()}>
              Record
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="micro">Direction</span>
              <Select
                value={draft.direction}
                options={[
                  { value: 'in', label: 'Money in (receipt)' },
                  { value: 'out', label: 'Money out (payment)' },
                ]}
                onChange={(event) => {
                  const next = event.target.value as 'in' | 'out';
                  setDraft({
                    ...draft,
                    direction: next,
                    partnerType: next === 'in' ? 'customer' : 'vendor',
                    partnerId: '',
                  });
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="micro">Method</span>
              <Select
                value={draft.method}
                options={METHODS.map((method) => ({ value: method, label: titleCase(method) }))}
                onChange={(event) => setDraft({ ...draft, method: event.target.value as PaymentMethod })}
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="micro">{draft.partnerType === 'customer' ? 'Customer' : 'Vendor'}</span>
              <Select
                value={draft.partnerId}
                placeholder={`Choose a ${draft.partnerType}`}
                options={(draft.partnerType === 'customer' ? customers : vendors).map((partner) => ({
                  value: partner.id,
                  label: partner.code ? `${partner.code} · ${partner.name}` : partner.name,
                }))}
                onChange={(event) => setDraft({ ...draft, partnerId: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="micro">Date</span>
              <Input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="micro">Amount</span>
              <Input
                value={draft.amount}
                inputMode="decimal"
                placeholder="0.00"
                className="text-right tabular-nums"
                onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="micro">Currency</span>
              <Input
                value={draft.currency}
                maxLength={3}
                onChange={(event) => setDraft({ ...draft, currency: event.target.value.toUpperCase() })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="micro">Reference</span>
              <Input
                value={draft.reference}
                placeholder="Bank reference"
                onChange={(event) => setDraft({ ...draft, reference: event.target.value })}
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="micro">Notes</span>
              <Textarea rows={2} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
            </label>
            {formError ? (
              <p className="col-span-2 rounded-input border border-danger bg-danger-soft px-2 py-1.5 text-meta text-danger" role="alert">
                {formError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <AllocationModal
        paymentId={allocateFor}
        detail={detail.data ?? null}
        values={allocations}
        onChange={setAllocations}
        busy={busy}
        onClose={() => setAllocateFor(null)}
        onConfirm={(id) => void allocate(id)}
      />
    </div>
  );
}

/** Text → cents through the shared parser; never a local rounding rule. */
function toCentsSafe(text: string): number {
  if (text.trim() === '') return 0;
  try {
    return parseCents(text);
  } catch {
    return 0;
  }
}

/**
 * The allocation sheet.
 *
 * Open documents for the payment's partner are fetched with a bounded page
 * (200 rows for one partner, not the whole table) and filtered to a non-zero
 * balance. Each row's maximum is the smaller of the document balance and what is
 * left on the payment — the server enforces both, and this mirrors it so the
 * operator sees the limit before being refused.
 */
function AllocationModal({
  paymentId,
  detail,
  values,
  onChange,
  busy,
  onClose,
  onConfirm,
}: {
  readonly paymentId: string | null;
  readonly detail: PaymentDetail | null;
  readonly values: Record<string, string>;
  readonly onChange: (next: Record<string, string>) => void;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (paymentId: string) => void;
}): JSX.Element {
  const isReceipt = detail?.direction === 'in';
  const partnerId = detail?.partnerId ?? '';

  const open = useQuery<readonly (InvoiceRow | BillRow)[]>(
    `allocate:${paymentId ?? 'none'}`,
    async () => {
      if (!partnerId) return [];
      const page = isReceipt
        ? await fetchInvoices({ customerId: partnerId, page: 1, pageSize: 200 })
        : await fetchBills({ vendorId: partnerId, page: 1, pageSize: 200 });
      return page.rows.filter((row) => row.balanceCents > 0 && row.status !== 'void' && row.status !== 'draft');
    },
    { enabled: paymentId !== null && partnerId !== '', staleMs: 0 },
  );

  const documents = open.data ?? [];
  const typed = Object.values(values).reduce((sum, text) => sum + toCentsSafe(text), 0);
  const remaining = (detail?.unallocatedCents ?? 0) - typed;

  return (
    <Modal
      open={paymentId !== null}
      onOpenChange={(next) => (next ? undefined : onClose())}
      title="Allocate this payment"
      description="Type an amount beside each document. Allocation does not post a second entry — the money has already moved."
      size="lg"
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={remaining < 0 || typed === 0}
            onClick={() => {
              if (paymentId) onConfirm(paymentId);
            }}
          >
            Allocate {formatAmount(cents(typed))}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-4 text-body">
        <span className="text-muted">
          Unallocated <MoneyCell>{amount(detail?.unallocatedCents ?? 0)}</MoneyCell>
        </span>
        <span className="text-muted">
          Typed <MoneyCell>{formatAmount(cents(typed))}</MoneyCell>
        </span>
        <span className={remaining < 0 ? 'ml-auto text-danger' : 'ml-auto text-muted'}>
          Remaining <MoneyCell>{formatAmount(cents(remaining))}</MoneyCell>
        </span>
      </div>

      {open.loading ? (
        <TableSkeleton rows={4} columns={3} />
      ) : documents.length === 0 ? (
        <EmptyState
          title="Nothing open for this partner"
          description="Every posted document for this partner is already settled. The payment stays unallocated, which is correct until there is something to apply it to."
        />
      ) : (
        <table className="w-full border-collapse text-body" aria-label="Open documents">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="px-2 py-1.5 text-left text-meta font-medium text-muted">Document</th>
              <th scope="col" className="w-24 px-2 py-1.5 text-left text-meta font-medium text-muted">Status</th>
              <th scope="col" className="w-28 px-2 py-1.5 text-right text-meta font-medium text-muted">Balance</th>
              <th scope="col" className="w-32 px-2 py-1.5 text-right text-meta font-medium text-muted">Allocate</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => {
              const key = `${isReceipt ? 'invoice' : 'bill'}:${document.id}`;
              const max = Math.min(document.balanceCents, detail?.unallocatedCents ?? document.balanceCents);
              return (
                <tr key={document.id} className="border-b border-line last:border-0">
                  <td className="px-2 py-1.5">
                    <span className="font-mono text-code text-text">{document.number ?? 'Draft'}</span>{' '}
                    <span className="text-meta text-muted">{fmtDate(document.date)}</span>
                  </td>
                  <td className="px-2 py-1.5">
                    <Badge status={document.status} label={humanise(document.status)} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <MoneyCell>{amount(document.balanceCents)}</MoneyCell>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      aria-label={`Allocate to ${document.number ?? 'draft'}`}
                      value={values[key] ?? ''}
                      inputMode="decimal"
                      placeholder={formatAmount(cents(max))}
                      className="h-8 text-right tabular-nums"
                      onChange={(event) => onChange({ ...values, [key]: event.target.value })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
