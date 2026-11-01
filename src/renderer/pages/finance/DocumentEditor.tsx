/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The one document editor, shared by invoices and bills (T06, R2).
 *
 * A bill and an invoice differ in three fields — who the partner is, whether
 * there is a vendor reference, and which service posts them. Everything else is
 * identical, so there is one editor parameterised by `docType` rather than two
 * implementations that drift.
 *
 * Money rules this component obeys without exception:
 *   - it never multiplies or divides a money value. `parseCents` turns typed text
 *     into cents at the boundary, `formatAmount` turns cents back into text, and
 *     every intermediate figure (line net, tax, document total) comes from
 *     `finance.documents.compute` on the main process;
 *   - the totals shown are the totals that will be posted, because they are
 *     produced by the same `computeTotals` that `postInvoice` uses.
 *
 * Keyboard (R2): `Enter` in a line adds the next one, `Tab` walks the cells,
 * `Backspace` in an empty description deletes the line, `⌘S` saves the draft and
 * `⌘Enter` posts it.
 */

import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DocumentLineInput, DocumentTotals, InvoiceDetail, BillDetail } from '@shared/finance';
import { cents, formatAmount, parseCents } from '@shared/money';

import { DocumentBuilder, type BuilderDocType } from '../../components/DocumentBuilder';
import { Modal } from '../../components/Modal';
import { Button, Chip, IconButton, Input, Select, Textarea, Tooltip } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import {
  addDays,
  fetchComputedTotals,
  fetchBill,
  fetchInvoice,
  fk,
  today,
  useDebounced,
  useLookup,
} from '../../lib/finance';
import { amount, date as fmtDate, percent, quantity } from '../../lib/format';
import { toast } from '../../lib/toast';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useSession } from '../../store';

/** One editable row. Text fields stay text until they cross into cents/milli. */
interface DraftLine {
  readonly key: string;
  readonly productId: string | null;
  readonly description: string;
  readonly qty: string;
  readonly unitPrice: string;
  readonly discountBp: number;
  readonly taxId: string | null;
  readonly accountId: string | null;
}

export interface DocumentEditorProps {
  readonly docType: BuilderDocType;
  /** `null` starts a new document. */
  readonly id: string | null;
  /** Called with the id to open, or `null` to return to the list. */
  readonly onOpen: (id: string | null) => void;
}

let lineCounter = 0;

function blankLine(): DraftLine {
  lineCounter += 1;
  return {
    key: `line-${String(lineCounter)}`,
    productId: null,
    description: '',
    qty: '1',
    unitPrice: '',
    discountBp: 0,
    taxId: null,
    accountId: null,
  };
}

/** `12.5` → `12500`. Quantity is not money, so this is plain arithmetic. */
function toMilli(text: string): number {
  const value = Number.parseFloat(text);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : 0;
}

/** Text → cents, through the shared parser so the rounding rule is one rule. */
function toCents(text: string): number {
  if (text.trim() === '') return 0;
  try {
    return parseCents(text);
  } catch {
    return 0;
  }
}

export function DocumentEditor({ docType, id, onOpen }: DocumentEditorProps): JSX.Element {
  const baseCurrency = useSession((state) => state.company?.baseCurrency ?? 'USD');
  const canCreate = useSession((state) => state.can(docType === 'invoice' ? 'finance.invoice.create' : 'finance.bill.create'));
  const canPost = useSession((state) => state.can(docType === 'invoice' ? 'finance.invoice.post' : 'finance.bill.post'));
  const canVoid = useSession((state) => state.can(docType === 'invoice' ? 'finance.invoice.void' : 'finance.bill.void'));

  const customers = useLookup('customers');
  const vendors = useLookup('vendors');
  const products = useLookup('products');
  const taxes = useLookup('taxes');

  /**
   * There is deliberately no per-line account picker: the line grid is already
   * seven columns wide, and `postInvoice` resolves the revenue account from the
   * chart (4010 → 4020 → 4000) and the bill's expense account from the product
   * or the default. A per-line override belongs on the product record, where it
   * is set once instead of on every document.
   */

  const partners = docType === 'invoice' ? customers : vendors;

  const [partnerId, setPartnerId] = useState('');
  const [date, setDate] = useState(() => today());
  const [dueDate, setDueDate] = useState(() => addDays(today(), 30));
  const [currency, setCurrency] = useState(baseCurrency);
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [vendorRef, setVendorRef] = useState('');
  const [lines, setLines] = useState<readonly DraftLine[]>(() => [blankLine()]);
  const [totals, setTotals] = useState<DocumentTotals | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [savedAt, setSavedAt] = useState(0);
  const focusLine = useRef<string | null>(null);
  const lineInputs = useRef(new Map<string, HTMLInputElement>());

  // ── load ───────────────────────────────────────────────────────────────────
  const detail = useQuery<InvoiceDetail | BillDetail>(
    id ? (docType === 'invoice' ? fk.invoice(id) : fk.bill(id)) : `new:${docType}`,
    () => (docType === 'invoice' ? fetchInvoice(id ?? '') : fetchBill(id ?? '')),
    { enabled: id !== null, staleMs: 0 },
  );

  useEffect(() => {
    const loaded = detail.data;
    if (!loaded) return;
    setPartnerId(docType === 'invoice' ? (loaded as InvoiceDetail).customerId : (loaded as BillDetail).vendorId);
    setDate(loaded.date);
    setDueDate(loaded.dueDate);
    setCurrency(loaded.currency);
    setNotes(loaded.notes ?? '');
    setTerms(docType === 'invoice' ? ((loaded as InvoiceDetail).terms ?? '') : '');
    setVendorRef(docType === 'bill' ? ((loaded as BillDetail).vendorRef ?? '') : '');
    setLines(
      loaded.lines.map((line) => {
        lineCounter += 1;
        return {
          key: `line-${String(lineCounter)}`,
          productId: line.productId,
          description: line.description,
          qty: quantity(line.qtyMilli).replace(/[.,]?0+$/, '') || '1',
          unitPrice: formatAmount(cents(line.unitPriceCents), 2),
          discountBp: line.discountBp,
          taxId: line.taxId,
          accountId: line.accountId,
        };
      }),
    );
    setTotals({
      lines: loaded.lines,
      subtotalCents: loaded.subtotalCents,
      discountCents: docType === 'invoice' ? (loaded as InvoiceDetail).discountCents : 0,
      taxCents: loaded.taxCents,
      totalCents: loaded.totalCents,
    });
    setDirty(false);
  }, [detail.data, docType]);

  // ── totals (debounced 250 ms) ──────────────────────────────────────────────
  const payloadLines = useMemo<readonly DocumentLineInput[]>(
    () =>
      lines
        .filter((line) => line.description.trim() !== '' && toMilli(line.qty) > 0)
        .map((line) => ({
          productId: line.productId,
          description: line.description.trim(),
          qtyMilli: toMilli(line.qty),
          unitPriceCents: toCents(line.unitPrice),
          discountBp: line.discountBp,
          taxId: line.taxId,
          accountId: line.accountId,
        })),
    [lines],
  );

  const debouncedSignature = useDebounced(JSON.stringify(payloadLines), 250);
  const debouncedCurrency = useDebounced(currency, 250);

  useEffect(() => {
    let cancelled = false;
    const parsed = JSON.parse(debouncedSignature) as readonly DocumentLineInput[];
    if (parsed.length === 0) {
      setTotals(null);
      return undefined;
    }
    void fetchComputedTotals(parsed, debouncedCurrency)
      .then((result) => {
        if (!cancelled) setTotals(result);
      })
      .catch(() => {
        if (!cancelled) setTotals(null);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedSignature, debouncedCurrency]);

  // ── preview (debounced 250 ms, only for a saved document) ──────────────────
  useEffect(() => {
    if (!id) {
      setPreviewHtml(null);
      return undefined;
    }
    let cancelled = false;
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      void invoke<{ html: string }>('documents.pdf.preview', { docType, id })
        .then((result) => {
          if (!cancelled) setPreviewHtml(result.html);
        })
        .catch(() => {
          if (!cancelled) setPreviewHtml(null);
        })
        .finally(() => {
          if (!cancelled) setPreviewBusy(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [docType, id, savedAt]);

  // ── line editing ───────────────────────────────────────────────────────────
  const update = useCallback((key: string, patch: Partial<DraftLine>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
    setDirty(true);
  }, []);

  const insertAfter = useCallback((key: string) => {
    const next = blankLine();
    setLines((current) => {
      const index = current.findIndex((line) => line.key === key);
      const copy = [...current];
      copy.splice(index + 1, 0, next);
      return copy;
    });
    setDirty(true);
    focusLine.current = next.key;
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((current) => (current.length === 1 ? current : current.filter((line) => line.key !== key)));
    setDirty(true);
  }, []);

  useEffect(() => {
    const key = focusLine.current;
    if (!key) return;
    focusLine.current = null;
    lineInputs.current.get(key)?.focus();
  }, [lines]);

  // ── save / post / void ─────────────────────────────────────────────────────
  const save = useCallback(async (): Promise<string | null> => {
    if (partnerId === '' || payloadLines.length === 0) {
      toast.warning(
        'Not enough to save',
        partnerId === ''
          ? `Choose a ${docType === 'invoice' ? 'customer' : 'vendor'} first.`
          : 'Add at least one line with a description and a quantity.',
      );
      return null;
    }
    setBusy(true);
    try {
      const payload =
        docType === 'invoice'
          ? {
              id: id ?? undefined,
              customerId: partnerId,
              date,
              dueDate,
              currency,
              notes: notes.trim() === '' ? null : notes.trim(),
              terms: terms.trim() === '' ? null : terms.trim(),
              lines: payloadLines,
            }
          : {
              id: id ?? undefined,
              vendorId: partnerId,
              vendorRef: vendorRef.trim() === '' ? null : vendorRef.trim(),
              date,
              dueDate,
              currency,
              notes: notes.trim() === '' ? null : notes.trim(),
              lines: payloadLines,
            };
      const saved = await invoke<InvoiceDetail | BillDetail>(
        docType === 'invoice' ? 'finance.invoices.save' : 'finance.bills.save',
        payload,
      );
      invalidate(docType === 'invoice' ? 'invoices' : 'bills');
      invalidate(docType === 'invoice' ? fk.invoice(saved.id) : fk.bill(saved.id));
      setDirty(false);
      setSavedAt(Date.now());
      if (!id) onOpen(saved.id);
      toast.success('Draft saved', 'No number is allocated until you post.');
      return saved.id;
    } catch (caught) {
      toast.error('That draft could not be saved', isApiError(caught) ? caught.message : 'Try again.');
      return null;
    } finally {
      setBusy(false);
    }
  }, [currency, date, docType, dueDate, id, notes, onOpen, partnerId, payloadLines, terms, vendorRef]);

  const post = useCallback(async (): Promise<void> => {
    let targetId = id;
    if (dirty || targetId === null) {
      targetId = await save();
      if (!targetId) return;
    }
    setBusy(true);
    try {
      const posted = await invoke<InvoiceDetail | BillDetail>(
        docType === 'invoice' ? 'finance.invoices.post' : 'finance.bills.post',
        { id: targetId },
      );
      invalidate(docType === 'invoice' ? 'invoices' : 'bills');
      invalidate('journals');
      invalidate('tb');
      invalidate('pnl');
      invalidate('bs');
      invalidate('cf');
      setSavedAt(Date.now());
      onOpen(posted.id);
      toast.success(
        docType === 'invoice' ? 'Invoice posted' : 'Bill posted',
        `${posted.number ?? 'Numbered'} · debits equal credits in the same transaction.`,
      );
    } catch (caught) {
      toast.error('That document could not be posted', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }, [dirty, docType, id, onOpen, save]);

  const voidDocument = useCallback(async (): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      await invoke(docType === 'invoice' ? 'finance.invoices.void' : 'finance.bills.void', {
        id,
        reason: voidReason.trim(),
      });
      invalidate(docType === 'invoice' ? 'invoices' : 'bills');
      invalidate('journals');
      invalidate('tb');
      setVoidOpen(false);
      setVoidReason('');
      setSavedAt(Date.now());
      toast.success('Document voided', 'A reversing entry was posted; the original stays in the ledger.');
    } catch (caught) {
      toast.error('That document could not be voided', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }, [docType, id, voidReason]);

  const print = useCallback((): void => {
    if (!id) {
      toast.info('Save the draft first', 'There is nothing to print until the document exists.');
      return;
    }
    void invoke('documents.print', { docType, id }).catch((caught: unknown) => {
      toast.error('That document could not be printed', isApiError(caught) ? caught.message : 'Try again.');
    });
  }, [docType, id]);

  const savePdf = useCallback((): void => {
    if (!id) {
      toast.info('Save the draft first', 'There is nothing to write until the document exists.');
      return;
    }
    void invoke<{ path: string; pages: number }>('documents.pdf.save', { docType, id })
      .then((result) => {
        toast.success('PDF saved', `${String(result.pages)} page${result.pages === 1 ? '' : 's'} · ${result.path}`);
      })
      .catch((caught: unknown) => {
        toast.error('That PDF could not be written', isApiError(caught) ? caught.message : 'Try again.');
      });
  }, [docType, id]);

  // ── shortcuts ──────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!busy && canCreate) void save();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (!busy && canPost) void post();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, canCreate, canPost, post, save]);

  // ── render ─────────────────────────────────────────────────────────────────
  const loaded = detail.data;
  const status = loaded ? loaded.status : 'draft';
  const readOnly = status !== 'draft';
  const title = loaded?.number ?? (id ? 'Draft' : docType === 'invoice' ? 'New invoice' : 'New bill');
  const partnerLabel = docType === 'invoice' ? 'Customer' : 'Vendor';

  const computedByKey = useMemo(() => {
    if (!totals) return [] as readonly (DocumentTotals['lines'][number] | null)[];
    let index = 0;
    return lines.map((line) => {
      const valid = line.description.trim() !== '' && toMilli(line.qty) > 0;
      if (!valid) return null;
      const computed = totals.lines[index] ?? null;
      index += 1;
      return computed;
    });
  }, [lines, totals]);

  return (
    <>
      <DocumentBuilder
        docType={docType}
        title={title}
        subtitle={loaded ? `${fmtDate(loaded.date)} · due ${fmtDate(loaded.dueDate)}` : undefined}
        status={status}
        dirty={dirty && !readOnly}
        previewHtml={previewHtml}
        previewBusy={previewBusy}
        canSave={canCreate}
        canPost={canPost}
        canVoid={canVoid}
        busy={busy}
        readOnly={readOnly}
        onSave={() => void save()}
        onPost={() => void post()}
        onVoid={() => {
          setVoidReason('');
          setVoidOpen(true);
        }}
        onPrint={print}
        onSavePdf={savePdf}
        onBack={() => onOpen(null)}
        meta={
          <div className="space-y-3">
            <label className="flex flex-col gap-1">
              <span className="micro">{partnerLabel}</span>
              <Select
                value={partnerId}
                placeholder={`Choose a ${partnerLabel.toLowerCase()}`}
                disabled={readOnly}
                options={partners.map((partner) => ({
                  value: partner.id,
                  label: partner.code ? `${partner.code} · ${partner.name}` : partner.name,
                }))}
                onChange={(event) => {
                  setPartnerId(event.target.value);
                  setDirty(true);
                }}
              />
            </label>

            {docType === 'bill' ? (
              <label className="flex flex-col gap-1">
                <span className="micro">Vendor reference</span>
                <Input
                  value={vendorRef}
                  disabled={readOnly}
                  placeholder="Their invoice number"
                  onChange={(event) => {
                    setVendorRef(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
            ) : null}

            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="micro">Date</span>
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
                <span className="micro">Due</span>
                <Input
                  type="date"
                  value={dueDate}
                  disabled={readOnly}
                  onChange={(event) => {
                    setDueDate(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
            </div>

            <label className="flex flex-col gap-1">
              <span className="micro">Currency</span>
              <Input
                value={currency}
                maxLength={3}
                disabled={readOnly}
                onChange={(event) => {
                  setCurrency(event.target.value.toUpperCase());
                  setDirty(true);
                }}
              />
            </label>

            {loaded ? (
              <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-y-1.5 border-t border-line pt-3 text-meta">
                <dt className="text-muted">Paid</dt>
                <dd className="text-right tabular-nums text-text">{amount(loaded.paidCents)}</dd>
                <dt className="text-muted">Balance</dt>
                <dd className="text-right tabular-nums text-text">{amount(loaded.balanceCents)}</dd>
                {loaded.daysOverdue > 0 ? (
                  <>
                    <dt className="text-muted">Overdue</dt>
                    <dd className="text-right text-danger">{loaded.daysOverdue} days</dd>
                  </>
                ) : null}
              </dl>
            ) : null}

            <div className="rounded-card border border-line bg-surface-2 px-2.5 py-2">
              <p className="micro">Shortcuts</p>
              <p className="mt-1 text-meta text-muted">
                <kbd className="font-mono">⌘S</kbd> save · <kbd className="font-mono">⌘↵</kbd> post ·{' '}
                <kbd className="font-mono">↵</kbd> next line · <kbd className="font-mono">⌫</kbd> delete empty line
              </p>
            </div>
          </div>
        }
        lines={
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="micro">Lines</span>
              <span className="text-meta text-muted">
                {payloadLines.length} of {lines.length} filled
              </span>
            </div>
            <table className="w-full border-collapse text-body" aria-label="Line items">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className="w-10 px-1 py-1.5 text-left text-meta font-medium text-muted">#</th>
                  <th scope="col" className="px-1 py-1.5 text-left text-meta font-medium text-muted">Description</th>
                  <th scope="col" className="w-20 px-1 py-1.5 text-right text-meta font-medium text-muted">Qty</th>
                  <th scope="col" className="w-28 px-1 py-1.5 text-right text-meta font-medium text-muted">Unit price</th>
                  <th scope="col" className="w-20 px-1 py-1.5 text-right text-meta font-medium text-muted">Disc.</th>
                  <th scope="col" className="w-32 px-1 py-1.5 text-left text-meta font-medium text-muted">Tax</th>
                  <th scope="col" className="w-28 px-1 py-1.5 text-right text-meta font-medium text-muted">Net</th>
                  <th scope="col" className="w-8 px-1 py-1.5">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const computed = computedByKey[index] ?? null;
                  return (
                    <tr key={line.key} className="border-b border-line align-middle">
                      <td className="px-1 py-1 text-meta tabular-nums text-muted">{index + 1}</td>
                      <td className="px-1 py-1">
                        <div className="flex items-center gap-1">
                          <Select
                            aria-label={`Product for line ${String(index + 1)}`}
                            value={line.productId ?? ''}
                            placeholder="—"
                            disabled={readOnly}
                            className="h-8 w-28 shrink-0 text-meta"
                            options={products.map((product) => ({
                              value: product.id,
                              label: product.code ? String(product.code) : product.name,
                            }))}
                            onChange={(event) => {
                              const chosen = products.find((product) => product.id === event.target.value);
                              update(line.key, {
                                productId: event.target.value === '' ? null : event.target.value,
                                description: chosen ? chosen.name : line.description,
                                unitPrice: chosen
                                  ? formatAmount(cents(Number(chosen['base_price_cents'] ?? 0)), 2)
                                  : line.unitPrice,
                                taxId: chosen ? ((chosen['tax_id'] as string | null) ?? line.taxId) : line.taxId,
                              });
                            }}
                          />
                          <Input
                            ref={(node) => {
                              if (node) lineInputs.current.set(line.key, node);
                              else lineInputs.current.delete(line.key);
                            }}
                            aria-label={`Description for line ${String(index + 1)}`}
                            value={line.description}
                            disabled={readOnly}
                            placeholder="What is being charged"
                            className="h-8"
                            onChange={(event) => update(line.key, { description: event.target.value })}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                insertAfter(line.key);
                              } else if (event.key === 'Backspace' && line.description === '' && lines.length > 1) {
                                event.preventDefault();
                                removeLine(line.key);
                              }
                            }}
                          />
                        </div>
                      </td>
                      <td className="px-1 py-1">
                        <Input
                          aria-label={`Quantity for line ${String(index + 1)}`}
                          value={line.qty}
                          inputMode="decimal"
                          disabled={readOnly}
                          className="h-8 text-right tabular-nums"
                          onChange={(event) => update(line.key, { qty: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              insertAfter(line.key);
                            }
                          }}
                        />
                      </td>
                      <td className="px-1 py-1">
                        <Input
                          aria-label={`Unit price for line ${String(index + 1)}`}
                          value={line.unitPrice}
                          inputMode="decimal"
                          disabled={readOnly}
                          placeholder="0.00"
                          className="h-8 text-right tabular-nums"
                          onChange={(event) => update(line.key, { unitPrice: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              insertAfter(line.key);
                            }
                          }}
                        />
                      </td>
                      <td className="px-1 py-1">
                        <Input
                          aria-label={`Discount percent for line ${String(index + 1)}`}
                          value={line.discountBp === 0 ? '' : String(line.discountBp / 100)}
                          inputMode="decimal"
                          disabled={readOnly}
                          placeholder="0"
                          className="h-8 text-right tabular-nums"
                          onChange={(event) => {
                            const parsed = Number.parseFloat(event.target.value);
                            update(line.key, {
                              discountBp: Number.isFinite(parsed) ? Math.round(parsed * 100) : 0,
                            });
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              insertAfter(line.key);
                            }
                          }}
                        />
                      </td>
                      <td className="px-1 py-1">
                        <Select
                          aria-label={`Tax for line ${String(index + 1)}`}
                          value={line.taxId ?? ''}
                          placeholder="No tax"
                          disabled={readOnly}
                          className="h-8 text-meta"
                          options={taxes.map((tax) => ({
                            value: tax.id,
                            label: `${tax.name} · ${percent(Number(tax['rate_bp'] ?? 0))}`,
                          }))}
                          onChange={(event) => update(line.key, { taxId: event.target.value === '' ? null : event.target.value })}
                        />
                      </td>
                      <td className="px-1 py-1 text-right">
                        {computed ? (
                          <span className="tabular-nums text-text">{amount(computed.netCents)}</span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-1 py-1 text-right">
                        {!readOnly && lines.length > 1 ? (
                          <Tooltip label="Remove this line">
                            <IconButton label={`Remove line ${String(index + 1)}`} size="sm" onClick={() => removeLine(line.key)}>
                              <Trash2 size={13} aria-hidden="true" />
                            </IconButton>
                          </Tooltip>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {!readOnly ? (
              <div className="mt-2">
                <Button size="sm" variant="ghost" iconLeft={<Plus size={13} aria-hidden="true" />} onClick={() => insertAfter(lines[lines.length - 1]?.key ?? '')}>
                  Add a line
                </Button>
              </div>
            ) : null}
          </div>
        }
        totals={
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-1 text-body">
            <span className="text-muted">Subtotal</span>
            <span className="text-right tabular-nums text-text">{amount(totals?.subtotalCents ?? 0)}</span>
            <span className="text-muted">Discount</span>
            <span className="text-right tabular-nums text-text">{amount(totals?.discountCents ?? 0)}</span>
            <span className="text-muted">Tax</span>
            <span className="text-right tabular-nums text-text">{amount(totals?.taxCents ?? 0)}</span>
            <span className="border-t border-line pt-1.5 text-body font-semibold text-text">Total {currency}</span>
            <span className="border-t border-line pt-1.5 text-right text-kpi font-semibold tabular-nums text-text">
              {amount(totals?.totalCents ?? 0)}
            </span>
          </div>
        }
        footer={
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="micro">Notes (printed on the document)</span>
              <Textarea
                rows={2}
                value={notes}
                disabled={readOnly}
                onChange={(event) => {
                  setNotes(event.target.value);
                  setDirty(true);
                }}
              />
            </label>
            {docType === 'invoice' ? (
              <label className="flex flex-col gap-1">
                <span className="micro">Terms</span>
                <Textarea
                  rows={2}
                  value={terms}
                  disabled={readOnly}
                  onChange={(event) => {
                    setTerms(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
            ) : (
              <div className="flex flex-col gap-1">
                <span className="micro">Posting</span>
                <p className="text-meta text-muted">
                  A posted bill debits expense and input tax, and credits accounts payable. Posting is refused if the
                  period is locked, and the message names the lock date and who locked it.
                </p>
              </div>
            )}
          </div>
        }
      />

      <Modal
        open={voidOpen}
        onOpenChange={(open) => (open ? undefined : setVoidOpen(false))}
        title={docType === 'invoice' ? 'Void this invoice' : 'Void this bill'}
        description="A reversing entry is posted with debits and credits swapped. The original document and its entry stay in the ledger, marked void."
        size="sm"
        destructive
        busy={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setVoidOpen(false)} disabled={busy}>
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
            placeholder="Duplicate of INV-2026-0042"
          />
        </label>
        {loaded ? (
          <p className="mt-2 flex items-center gap-2 text-meta text-muted">
            <Chip tone="neutral">{loaded.number ?? 'Draft'}</Chip>
            {amount(loaded.totalCents)} {loaded.currency}
          </p>
        ) : null}
      </Modal>
    </>
  );
}
