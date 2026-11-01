/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Quotations — list, builder and conversion (T08, US-33/US-34, gap closure).
 *
 * `Expired` is derived from the expiry date rather than stored, so a quote cannot
 * look live because nobody ran a job to flip its status.
 *
 * The builder **reuses `DocumentBuilder`**, which is the point: a quotation and
 * an invoice are the same three-pane problem — meta on the left, lines and
 * totals in the middle, the A4 sheet on the right — and a second layout would
 * have been a second place for the totals block to drift. What differs is the
 * document model the main process renders, and that is already a parameter.
 *
 * The preview is the *saved* version. Editing a draft leaves the sheet showing
 * what the customer would receive if you sent it now, with an explicit "unsaved
 * changes" marker, rather than a client-side approximation of the layout that
 * could disagree with the PDF.
 */

import { ArrowLeft, Plus, Send, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { QuoteDetail, QuoteRow, SoDetail } from '@shared/ops';
import type { Paged } from '@shared/types';

import { DocumentBuilder } from '../../components/DocumentBuilder';
import { LineGrid, blankLine, toLineInputs, type LineDraft } from '../../components/LineGrid';
import { Modal } from '../../components/Modal';
import { OpsTable, money, type OpsColumn } from '../../components/OpsTable';
import { EmptyState } from '../../components/patterns';
import { Button, Input, Select, Textarea } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import { addDays, today } from '../../lib/finance';
import { date as fmtDate } from '../../lib/format';
import { toast } from '../../lib/toast';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useNewParam } from '../../lib/useNewParam';
import { useSession } from '../../store';

interface CustomerOption {
  readonly id: string;
  readonly name: string;
  readonly currency: string | null;
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
}

const COLUMNS: readonly OpsColumn<QuoteRow>[] = [
  { key: 'number', label: 'Quote', width: 'w-32', render: (row) => <span className="font-mono text-meta">{row.number ?? 'Draft'}</span> },
  { key: 'customer', label: 'Customer', render: (row) => <span className="text-text">{row.customerName}</span> },
  { key: 'date', label: 'Date', width: 'w-28', render: (row) => fmtDate(row.date) },
  {
    key: 'expiry',
    label: 'Expires',
    width: 'w-32',
    render: (row) => (row.isExpired ? <span className="text-danger">{fmtDate(row.expiryDate)}</span> : fmtDate(row.expiryDate)),
  },
  { key: 'total', label: 'Value', align: 'right', width: 'w-28', render: (row) => money(row.totalCents) },
  {
    key: 'status',
    label: 'Status',
    width: 'w-32',
    render: (row) => <span className="text-muted">{row.isExpired && row.status !== 'converted' ? 'expired' : row.status}</span>,
  },
];

export function Quotations(): JSX.Element {
  const canCreate = useSession((state) => state.can('sales.quotation.create'));
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<null | 'new' | string>(null);
  useNewParam(() => setView('new'));

  const fetcher = useCallback(
    async ({ page, pageSize, q, status }: { page: number; pageSize: number; q?: string; status?: string }) =>
      invoke<Paged<QuoteRow>>('sales.quote.list', { q, status, page, pageSize }),
    [reload],
  );

  if (view !== null) {
    return (
      <QuoteBuilder
        id={view === 'new' ? null : view}
        onBack={() => {
          setReload((value) => value + 1);
          setView(null);
        }}
      />
    );
  }

  return (
    <OpsTable<QuoteRow>
      title="Quotations"
      subtitle="Converting an expired quote needs a permission and a reason."
      countLabel="quotations"
      queryKey={`ops:quotes:${String(reload)}`}
      fetcher={fetcher}
      columns={COLUMNS}
      filters={[
        {
          key: 'status',
          label: 'statuses',
          options: [
            { value: 'draft', label: 'Draft' },
            { value: 'sent', label: 'Sent' },
            { value: 'accepted', label: 'Accepted' },
            { value: 'converted', label: 'Converted' },
          ],
        },
      ]}
      rowKey={(row) => row.id}
      searchPlaceholder="Search quote or customer"
      emptyTitle="No quotations"
      emptyHint="Quote a customer, then convert it to an order."
      primaryAction={
        canCreate ? (
          <Button variant="primary" iconLeft={<Plus size={14} />} onClick={() => setView('new')}>
            New quotation
          </Button>
        ) : null
      }
      onRowClick={(row) => setView(row.id)}
    />
  );
}

// ── builder ──────────────────────────────────────────────────────────────────

interface QuoteBuilderProps {
  readonly id: string | null;
  readonly onBack: () => void;
}

function QuoteBuilder({ id, onBack }: QuoteBuilderProps): JSX.Element {
  const canWrite = useSession((state) => state.can('sales.quotation.write'));
  const canConvert = useSession((state) => state.can('sales.quotation.convert'));

  const [savedId, setSavedId] = useState<string | null>(id);
  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(today());
  const [expiryDate, setExpiryDate] = useState(addDays(today(), 30));
  const [terms, setTerms] = useState('Payment within 30 days of acceptance.');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<LineDraft[]>(() => [blankLine()]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [convertReason, setConvertReason] = useState('');
  const [seeded, setSeeded] = useState(false);

  const customers = useQuery<readonly CustomerOption[]>(
    'quote:customers',
    () =>
      invoke<Paged<CustomerOption>>('entity.list', {
        entity: 'customers',
        limit: 200,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000 },
  );

  const products = useQuery<readonly ProductOption[]>(
    'quote:products',
    () =>
      invoke<Paged<ProductOption>>('entity.list', {
        entity: 'products',
        limit: 200,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000 },
  );

  const taxes = useQuery<readonly TaxOption[]>(
    'quote:taxes',
    () =>
      invoke<Paged<TaxOption>>('entity.list', {
        entity: 'taxes',
        limit: 100,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000 },
  );

  const quote = useQuery<QuoteDetail | null>(
    `quote:detail:${savedId ?? 'new'}`,
    () => (savedId ? invoke<QuoteDetail>('sales.quote.get', { id: savedId }) : Promise.resolve(null)),
    { staleMs: 5_000, enabled: savedId !== null },
  );

  const preview = useQuery<{ html: string } | null>(
    `quote:preview:${savedId ?? 'none'}`,
    () => (savedId ? invoke<{ html: string }>('documents.pdf.preview', { docType: 'quote', id: savedId }) : Promise.resolve(null)),
    { staleMs: 5_000, enabled: savedId !== null },
  );

  // Seed the form from the saved quote exactly once. Re-seeding on every refetch
  // would overwrite what the operator is typing.
  const quoteData = quote.data;
  useEffect(() => {
    if (!quoteData || seeded) return;
    setSeeded(true);
    setCustomerId(quoteData.customerId);
    setDate(quoteData.date);
    setExpiryDate(quoteData.expiryDate);
    setTerms(quoteData.terms ?? '');
    setNotes(quoteData.notes ?? '');
    setRows(
      quoteData.lines.map((line) =>
        blankLine({
          productId: line.productId ?? '',
          description: line.description,
          qty: String(line.qtyMilli / 1000),
          unitPrice: (line.unitPriceCents / 100).toFixed(2),
          discount: String(line.discountBp / 100),
          taxId: line.taxId ?? '',
        }),
      ),
    );
    setDirty(false);
  }, [quoteData, seeded]);

  const customer = (customers.data ?? []).find((row) => row.id === customerId);
  const currency = quote.data?.currency ?? customer?.currency ?? 'USD';

  const productOptions = useMemo(
    () => (products.data ?? []).map((row) => ({ value: row.id, label: `${row.sku} · ${row.name}` })),
    [products.data],
  );
  const taxOptions = useMemo(
    () => (taxes.data ?? []).map((row) => ({ value: row.id, label: `${row.name} (${(row.rate_bp / 100).toFixed(2)}%)` })),
    [taxes.data],
  );

  const lines = toLineInputs(rows, true);
  const netPreview = rows.reduce((sum, row) => {
    const qty = Math.round(Number(row.qty.replace(/[^0-9.-]/g, '') || '0') * 1000);
    const price = Math.round(Number(row.unitPrice.replace(/[^0-9.-]/g, '') || '0') * 100);
    const discount = Math.round(Number(row.discount.replace(/[^0-9.-]/g, '') || '0') * 100);
    const gross = Math.round((qty * price) / 1000);
    return sum + gross - Math.round((gross * discount) / 10_000);
  }, 0);

  const readOnly = quoteData !== undefined && quoteData !== null && quoteData.status !== 'draft';

  async function save(thenSend = false): Promise<void> {
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
      const saved = await invoke<QuoteDetail>('sales.quote.save', {
        ...(savedId ? { id: savedId } : {}),
        customerId,
        date,
        expiryDate,
        ...(terms.trim() ? { terms: terms.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines,
      });
      if (thenSend) {
        await invoke<QuoteDetail>('sales.quote.send', { id: saved.id });
      }
      setSavedId(saved.id);
      setDirty(false);
      invalidate('ops:');
      invalidate('quote:');
      quote.refresh();
      preview.refresh();
      toast.success(
        thenSend ? 'Quotation sent' : 'Quotation saved',
        `${saved.number ?? 'Draft'} · ${money(saved.totalCents)} ${saved.currency}.`,
      );
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'That quotation could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function convert(override = false): Promise<void> {
    if (!savedId) return;
    setBusy(true);
    try {
      const order = await invoke<SoDetail>('sales.quote.convert', {
        id: savedId,
        ...(override ? { overrideExpiry: true, reason: convertReason.trim() } : {}),
      });
      setConvertOpen(false);
      setConvertReason('');
      invalidate('ops:');
      quote.refresh();
      toast.success(
        'Converted to a sales order',
        `${order.number ?? 'Draft order'} was created from this quotation. Confirm it to reserve stock.`,
      );
      onBack();
    } catch (caught) {
      const message = isApiError(caught) ? caught.message : 'That quotation could not be converted.';
      // An expiry is the one refusal the operator can resolve on this screen, so
      // it opens the override dialog instead of a dead-end toast.
      if (/expired/i.test(message) && !override) {
        setConvertOpen(true);
      } else {
        toast.error('Could not convert', message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function print(savePdf: boolean): Promise<void> {
    if (!savedId) return;
    try {
      if (savePdf) {
        await invoke('documents.pdf.save', { docType: 'quote', id: savedId });
        toast.success('PDF saved', 'The same template the preview uses.');
      } else {
        await invoke('documents.print', { docType: 'quote', id: savedId });
        toast.success('Sent to the printer');
      }
    } catch (caught) {
      toast.error('Could not produce the document', isApiError(caught) ? caught.message : 'Try again.');
    }
  }

  const meta = (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-meta font-medium text-text">Customer</span>
        <Select
          aria-label="Customer"
          value={customerId}
          placeholder="Choose a customer"
          options={(customers.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
          disabled={readOnly}
          onChange={(event) => {
            setCustomerId(event.target.value);
            setDirty(true);
          }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-meta font-medium text-text">Date</span>
        <Input
          type="date"
          value={date}
          disabled={readOnly}
          onChange={(event) => {
            setDate(event.target.value);
            setDirty(true);
          }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-meta font-medium text-text">Valid until</span>
        <Input
          type="date"
          value={expiryDate}
          disabled={readOnly}
          onChange={(event) => {
            setExpiryDate(event.target.value);
            setDirty(true);
          }}
        />
      </label>
      <p className="text-meta text-muted">Currency {currency}. Prices resolve from the customer's price list on the server.</p>
    </div>
  );

  const totals = (
    <div className="flex items-center justify-between rounded-card border border-line bg-surface-2 px-3 py-2">
      <span className="text-meta text-muted">Net of the lines above</span>
      <span className="tnum text-body font-medium text-text">{money(netPreview)} {currency}</span>
    </div>
  );

  const footer = (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-meta font-medium text-text">Terms</span>
        <Textarea rows={2} value={terms} disabled={readOnly} onChange={(event) => {
          setTerms(event.target.value);
          setDirty(true);
        }} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-meta font-medium text-text">Notes</span>
        <Textarea rows={2} value={notes} disabled={readOnly} onChange={(event) => {
          setNotes(event.target.value);
          setDirty(true);
        }} />
      </label>
      {error !== null ? (
        <p role="alert" className="text-meta text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );

  if (savedId === null) {
    return (
      <DocumentBuilder
        docType="quote"
        title="New quotation"
        subtitle="Save it to see the sheet the customer receives."
        status="draft"
        dirty={dirty}
        meta={meta}
        lines={
          <LineGrid
            rows={rows}
            onChange={(next) => {
              setRows(next);
              setDirty(true);
            }}
            products={productOptions}
            taxes={taxOptions}
            currency={currency}
            showDiscount
          />
        }
        totals={totals}
        footer={footer}
        previewHtml={null}
        previewBusy={false}
        canSave={canWrite}
        canPost={false}
        canVoid={false}
        busy={busy}
        readOnly={false}
        onSave={() => void save(false)}
        onPost={() => undefined}
        onVoid={() => undefined}
        onPrint={() => undefined}
        onSavePdf={() => undefined}
        onBack={onBack}
      />
    );
  }

  if (quote.error || !quote.data) {
    return (
      <div className="p-6">
        <EmptyState
          title="That quotation could not be loaded"
          description={quote.error?.message ?? 'It may have been deleted.'}
          action={
            <Button variant="secondary" onClick={onBack}>
              Back to quotations
            </Button>
          }
        />
      </div>
    );
  }

  const detail = quote.data;

  return (
    <>
      <DocumentBuilder
        docType="quote"
        title={detail.number ?? 'Draft quotation'}
        subtitle={`${detail.customerName} · valid until ${fmtDate(detail.expiryDate)}`}
        status={detail.isExpired && detail.status !== 'converted' ? 'expired' : detail.status}
        dirty={dirty}
        meta={meta}
        lines={
          <LineGrid
            rows={rows}
            onChange={(next) => {
              setRows(next);
              setDirty(true);
            }}
            products={productOptions}
            taxes={taxOptions}
            currency={currency}
            showDiscount
            readOnly={readOnly}
          />
        }
        totals={totals}
        footer={footer}
        previewHtml={preview.data?.html ?? null}
        previewBusy={preview.loading}
        canSave={canWrite && !readOnly}
        canPost={false}
        canVoid={false}
        busy={busy}
        readOnly={readOnly}
        onSave={() => void save(false)}
        onPost={() => void save(true)}
        onVoid={() => undefined}
        onPrint={() => void print(false)}
        onSavePdf={() => void print(true)}
        onBack={onBack}
      />

      {/* The builder's own action bar has Save / Print / PDF; send and convert
          live here because they change the document's state, not its contents. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-20 flex gap-2">
        <div className="pointer-events-auto flex items-center gap-2 rounded-card border border-line bg-surface px-3 py-2 shadow-lg">
          <Button
            size="sm"
            variant="ghost"
            iconLeft={<ArrowLeft size={13} />}
            onClick={onBack}
          >
            List
          </Button>
          {detail.status === 'draft' ? (
            <Button size="sm" variant="secondary" loading={busy} iconLeft={<Send size={13} />} onClick={() => void save(true)}>
              Save and send
            </Button>
          ) : null}
          {canConvert && detail.status !== 'converted' && detail.status !== 'rejected' ? (
            <Button size="sm" variant="primary" loading={busy} iconLeft={<Sparkles size={13} />} onClick={() => void convert()}>
              Convert to order
            </Button>
          ) : null}
          {detail.convertedOrderId ? (
            <span className="text-meta text-muted">Converted · order {detail.convertedOrderId.slice(0, 8)}</span>
          ) : null}
        </div>
      </div>

      <Modal
        open={convertOpen}
        onOpenChange={setConvertOpen}
        title="This quotation has expired"
        description={`It expired on ${fmtDate(detail.expiryDate)}. Converting it needs the override permission and a reason, both of which are recorded in the audit log.`}
        size="sm"
        busy={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConvertOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={convertReason.trim().length < 3}
              onClick={() => void convert(true)}
            >
              Override and convert
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1">
          <span className="micro">Reason (recorded in the audit log)</span>
          <Input
            autoFocus
            value={convertReason}
            onChange={(event) => setConvertReason(event.target.value)}
            placeholder="Customer accepted late in writing"
          />
        </label>
      </Modal>
    </>
  );
}
