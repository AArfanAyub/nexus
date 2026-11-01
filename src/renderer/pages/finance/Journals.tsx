/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Journal browser (T05).
 *
 * The list is paged on the server (`pageSize` capped at 200 in the validator),
 * so a 100 000-line ledger costs one page of rows. Filters the SQL can answer —
 * date, journal, status, text — go in the payload; nothing is filtered in the
 * browser, because filtering a page in the browser silently lies about `total`.
 *
 * The detail drawer shows the Dr/Cr grid, the source link and the posting
 * metadata, and offers Reverse for a posted entry. Reversal is the only way to
 * undo a posting; there is deliberately no "edit" on a posted entry.
 */

import { AlertCircle, ArrowLeftRight, Printer, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import type { JournalEntryDetail, JournalEntryStatus, JournalEntrySummary, JournalFilter } from '@shared/finance';

import { Drawer } from '../../components/Drawer';
import { Modal } from '../../components/Modal';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, MoneyCell, Pagination, TableSkeleton } from '../../components/patterns';
import { Badge, Button, Chip, Input, Select, Tooltip } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import { fetchJournal, fetchJournals, fk, today, useJournalCodes } from '../../lib/finance';
import { amount, date as fmtDate, dateTime, humanise } from '../../lib/format';
import { toast } from '../../lib/toast';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useSession } from '../../store';

const PAGE_SIZE = 50;

const STATUS_TABS: readonly { readonly id: '' | JournalEntryStatus; readonly label: string }[] = [
  { id: '', label: 'All' },
  { id: 'posted', label: 'Posted' },
  { id: 'draft', label: 'Draft' },
  { id: 'reversed', label: 'Reversed' },
];

export function Journals(): JSX.Element {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const canPost = useSession((state) => state.can('finance.journal.post'));
  const canReverse = useSession((state) => state.can('finance.journal.reverse'));
  const canDelete = useSession((state) => state.can('finance.journal.write'));
  const journals = useJournalCodes();

  const [from, setFrom] = useState(() => `${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(() => today());
  const [journalId, setJournalId] = useState('');
  const [status, setStatus] = useState<'' | JournalEntryStatus>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(() => params.get('id'));
  const [reverseTarget, setReverseTarget] = useState<JournalEntrySummary | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const filter: JournalFilter = useMemo(
    () => ({
      from,
      to,
      journalId: journalId === '' ? undefined : journalId,
      status: status === '' ? undefined : status,
      q: q.trim() === '' ? undefined : q.trim(),
      page,
      pageSize: PAGE_SIZE,
    }),
    [from, to, journalId, status, q, page],
  );

  const list = useQuery<{ readonly rows: readonly JournalEntrySummary[]; readonly total: number }>(
    fk.journals(filter),
    () => fetchJournals(filter),
    { staleMs: 15_000 },
  );

  const detail = useQuery<JournalEntryDetail>(fk.journal(openId ?? 'none'), () => fetchJournal(openId ?? ''), {
    enabled: openId !== null,
    staleMs: 30_000,
  });

  // Reset to page 1 whenever a filter changes, or `total` and the page disagree.
  useEffect(() => {
    setPage(1);
  }, [from, to, journalId, status, q]);

  /**
   * The URL carries the open entry so a notification can deep-link to it. The
   * current params are read from a ref: depending on `params` would re-run the
   * effect on every navigation, and `setParams` returns a fresh object each time.
   */
  const paramsRef = useRef(params);
  paramsRef.current = params;
  useEffect(() => {
    const current = paramsRef.current;
    const next = new URLSearchParams(current.toString());
    if (openId) next.set('id', openId);
    else next.delete('id');
    if (next.toString() !== current.toString()) setParams(next, { replace: true });
  }, [openId, setParams]);

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const entry: JournalEntryDetail | null = detail.data ?? null;

  async function reverse(target: JournalEntrySummary): Promise<void> {
    setBusy(true);
    try {
      const created = await invoke<JournalEntryDetail>('finance.journals.reverse', {
        id: target.id,
        reason: reason.trim(),
      });
      invalidate('journals');
      invalidate('tb');
      invalidate('pnl');
      invalidate('bs');
      invalidate('cf');
      setReverseTarget(null);
      setReason('');
      setOpenId(created.id);
      toast.success(
        'Entry reversed',
        `${created.number ?? 'Unnumbered'} mirrors ${target.number ?? 'the original'}.`,
      );
    } catch (caught) {
      toast.error('That entry could not be reversed', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function post(target: JournalEntryDetail): Promise<void> {
    setBusy(true);
    try {
      await invoke('finance.journals.post', { id: target.id });
      invalidate('journals');
      invalidate('tb');
      toast.success('Entry posted', 'A number was allocated inside the posting transaction.');
    } catch (caught) {
      toast.error('That entry could not be posted', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: JournalEntryDetail): Promise<void> {
    setBusy(true);
    try {
      await invoke('finance.journals.delete', { id: target.id });
      invalidate('journals');
      setOpenId(null);
      toast.success('Draft deleted', 'No number had been allocated, so nothing is missing from the sequence.');
    } catch (caught) {
      toast.error('That draft could not be deleted', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  function detailFooter(current: JournalEntryDetail): JSX.Element {
    return (
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {current.status === 'draft' && canPost ? (
            <Button size="sm" variant="primary" loading={busy} onClick={() => void post(current)}>
              Post
            </Button>
          ) : null}
          {current.status === 'draft' && canDelete ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy}
              onClick={() => void remove(current)}
              iconLeft={<Trash2 size={13} aria-hidden="true" />}
            >
              Delete
            </Button>
          ) : null}
          {current.status === 'posted' && canReverse ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                setReverseTarget(current);
                setReason('');
              }}
              iconLeft={<ArrowLeftRight size={13} aria-hidden="true" />}
            >
              Reverse
            </Button>
          ) : null}
        </div>
        <Tooltip label="Open the source document in the system viewer">
          <Button
            size="sm"
            variant="ghost"
            iconLeft={<Printer size={13} aria-hidden="true" />}
            onClick={() => {
              if (!current.sourceId) {
                toast.info('This entry has no printable source', 'Manual journals exist only in the ledger.');
                return;
              }
              void invoke('documents.print', {
                docType: current.sourceType === 'bill' ? 'bill' : 'invoice',
                id: current.sourceId,
              }).catch((caught: unknown) => {
                toast.error('Nothing to print', isApiError(caught) ? caught.message : 'Try again.');
              });
            }}
          >
            Print source
          </Button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Journal entries"
        subtitle="Every posting in one place. Nothing here can be edited after it is posted."
        count={total}
        countLabel="entries"
        secondaryActions={
          <Button variant="ghost" onClick={() => navigate('/finance/reports/trial-balance')}>
            Trial balance
          </Button>
        }
        primaryAction={
          <Button
            variant="primary"
            onClick={() => navigate('/finance/reports/trial-balance')}
            iconLeft={<ArrowLeftRight size={14} aria-hidden="true" />}
          >
            Reconcile
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-2 border-b border-line bg-surface px-5 py-2">
        <label className="flex flex-col gap-0.5">
          <span className="micro">From</span>
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="h-8 w-36" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="micro">To</span>
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="h-8 w-36" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="micro">Journal</span>
          <Select
            value={journalId}
            placeholder="All journals"
            className="h-8 w-44"
            options={journals.map((journal) => ({ value: journal.id, label: `${journal.code} · ${journal.name}` }))}
            onChange={(event) => setJournalId(event.target.value)}
          />
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-0.5">
          <span className="micro">Search memo or number</span>
          <Input
            value={q}
            placeholder="INV-2026-0001, rent, …"
            className="h-8"
            onChange={(event) => setQ(event.target.value)}
          />
        </label>
      </div>

      <div
        role="tablist"
        aria-label="Entry status"
        className="flex items-center gap-1 border-b border-line bg-surface px-4 py-1.5"
      >
        {STATUS_TABS.map((tab) => {
          const active = tab.id === status;
          return (
            <button
              key={tab.id === '' ? 'all' : tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setStatus(tab.id)}
              className={[
                'rounded-chip px-2.5 py-1 text-meta transition-colors duration-fast',
                active ? 'bg-accent-soft text-accent-strong' : 'text-muted hover:bg-surface-2 hover:text-text',
              ].join(' ')}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {list.error ? (
          <div
            className="m-5 flex items-start gap-2 rounded-card border border-danger bg-danger-soft p-3 text-body text-danger"
            role="alert"
          >
            <AlertCircle size={16} aria-hidden="true" />
            <span>{list.error.message}</span>
          </div>
        ) : list.loading && rows.length === 0 ? (
          <TableSkeleton rows={10} columns={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No entries in this range"
            description="Posting an invoice, a bill or a payment writes an entry here. Widen the date range to see older work."
          />
        ) : (
          <table className="w-full border-collapse text-body" aria-label="Journal entries">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr>
                <th scope="col" className="w-28 px-3 py-2 text-left text-meta font-medium text-muted">Date</th>
                <th scope="col" className="w-36 px-3 py-2 text-left text-meta font-medium text-muted">Number</th>
                <th scope="col" className="w-24 px-3 py-2 text-left text-meta font-medium text-muted">Journal</th>
                <th scope="col" className="px-3 py-2 text-left text-meta font-medium text-muted">Memo</th>
                <th scope="col" className="w-32 px-3 py-2 text-left text-meta font-medium text-muted">Source</th>
                <th scope="col" className="w-28 px-3 py-2 text-left text-meta font-medium text-muted">Status</th>
                <th scope="col" className="w-32 px-3 py-2 text-right text-meta font-medium text-muted">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  onClick={() => setOpenId(row.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') setOpenId(row.id);
                  }}
                  className="cursor-pointer border-b border-line transition-colors duration-fast hover:bg-surface-2"
                  style={{ height: 'var(--row-h)' }}
                >
                  <td className="px-3 tabular-nums text-muted">{fmtDate(row.date)}</td>
                  <td className="px-3 font-mono text-code text-text">{row.number ?? '—'}</td>
                  <td className="px-3">
                    <Chip tone="neutral">{row.journalCode}</Chip>
                  </td>
                  <td className="truncate px-3 text-text">
                    {row.memo ?? <span className="text-muted">No memo</span>}
                    {row.reversesId ? <span className="ml-2 text-meta text-warning">reversal</span> : null}
                  </td>
                  <td className="px-3 text-meta text-muted">{row.sourceType ? humanise(row.sourceType) : 'Manual'}</td>
                  <td className="px-3">
                    <Badge status={row.status} />
                  </td>
                  <td className="px-3 text-right">
                    <MoneyCell>{amount(row.totalCents)}</MoneyCell>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />

      <Drawer
        open={openId !== null}
        onOpenChange={(open) => (open ? undefined : setOpenId(null))}
        width={640}
        title={entry ? `${entry.number ?? 'Draft'} · ${entry.journalCode}` : 'Entry'}
        subtitle={entry ? `${fmtDate(entry.date)} · ${entry.memo ?? 'no memo'}` : undefined}
        status={entry ? { status: entry.status, label: entry.status } : undefined}
        footer={entry ? detailFooter(entry) : null}
      >
        {detail.error ? (
          <p className="text-body text-danger" role="alert">
            {detail.error.message}
          </p>
        ) : !entry ? (
          <TableSkeleton rows={6} columns={3} />
        ) : (
          <>
            <table className="w-full border-collapse text-body" aria-label="Journal lines">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className="px-2 py-1.5 text-left text-meta font-medium text-muted">Account</th>
                  <th scope="col" className="px-2 py-1.5 text-left text-meta font-medium text-muted">Description</th>
                  <th scope="col" className="w-28 px-2 py-1.5 text-right text-meta font-medium text-muted">Debit</th>
                  <th scope="col" className="w-28 px-2 py-1.5 text-right text-meta font-medium text-muted">Credit</th>
                </tr>
              </thead>
              <tbody>
                {entry.lines.map((line) => (
                  <tr key={line.id} className="border-b border-line last:border-0">
                    <td className="px-2 py-1.5">
                      <span className="font-mono text-code text-muted">{line.accountCode}</span>{' '}
                      <span className="text-text">{line.accountName}</span>
                    </td>
                    <td className="px-2 py-1.5 text-meta text-muted">{line.description ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right">
                      {line.debitCents === 0 ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <MoneyCell>{amount(line.debitCents)}</MoneyCell>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {line.creditCents === 0 ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <MoneyCell>{amount(line.creditCents)}</MoneyCell>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line-strong">
                  <td className="px-2 py-1.5 text-meta text-muted" colSpan={2}>
                    {entry.lines.length} lines · balanced by construction
                  </td>
                  <td className="px-2 py-1.5 text-right font-medium">
                    <MoneyCell>{amount(entry.lines.reduce((sum, line) => sum + line.debitCents, 0))}</MoneyCell>
                  </td>
                  <td className="px-2 py-1.5 text-right font-medium">
                    <MoneyCell>{amount(entry.lines.reduce((sum, line) => sum + line.creditCents, 0))}</MoneyCell>
                  </td>
                </tr>
              </tfoot>
            </table>

            <dl className="mt-4 grid grid-cols-[8rem_minmax(0,1fr)] gap-y-1.5 text-body">
              <dt className="text-muted">Source</dt>
              <dd className="text-right">{entry.sourceType ? humanise(entry.sourceType) : 'Manual'}</dd>
              <dt className="text-muted">Posted</dt>
              <dd className="text-right">{entry.postedAt ? dateTime(entry.postedAt) : 'Not posted'}</dd>
              <dt className="text-muted">Posted by</dt>
              <dd className="text-right">{entry.postedBy ?? '—'}</dd>
              {entry.reversesId ? (
                <>
                  <dt className="text-muted">Reverses</dt>
                  <dd className="text-right">
                    <button
                      type="button"
                      className="text-accent hover:underline"
                      onClick={() => setOpenId(entry.reversesId)}
                    >
                      Open the original entry
                    </button>
                  </dd>
                </>
              ) : null}
            </dl>
          </>
        )}
      </Drawer>

      <Modal
        open={reverseTarget !== null}
        onOpenChange={(open) => (open ? undefined : setReverseTarget(null))}
        title="Reverse entry"
        description="A mirror entry is posted with debits and credits swapped. The original stays exactly as it was."
        size="sm"
        busy={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReverseTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={reason.trim().length < 3 || reverseTarget === null}
              onClick={() => {
                if (reverseTarget) void reverse(reverseTarget);
              }}
            >
              Post reversal
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1">
          <span className="micro">Reason (recorded on the mirror entry)</span>
          <Input
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Posted to the wrong customer"
          />
        </label>
      </Modal>
    </div>
  );
}
