/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Accounting periods (T05).
 *
 * Locking is the only control that makes a posted figure immutable, so this page
 * treats it as a deliberate act: a reason is mandatory, the operator sees the
 * date range and the entry count they are about to freeze, and the confirmation
 * names the period rather than asking "are you sure?".
 *
 * Unlocking is offered with the same weight, because it is the same decision in
 * reverse — a period that can be reopened without a reason is not really locked.
 *
 * The close checklist is read-only and comes from the server: it re-derives each
 * condition (drafts outstanding, trial balance balanced, bank accounts
 * reconciled) rather than trusting a stored flag that could go stale.
 */

import { AlertCircle, CheckCircle2, Lock, LockOpen, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { CloseChecklistItem, PeriodRow } from '@shared/finance';

import { Modal } from '../../components/Modal';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, SectionCard, TableSkeleton } from '../../components/patterns';
import { Button, Chip, Input } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import { fetchCloseChecklist, fk, usePeriods } from '../../lib/finance';
import { date as fmtDate, dateTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useSession } from '../../store';

type Action = { readonly kind: 'lock' | 'unlock'; readonly period: PeriodRow } | null;

export function Periods(): JSX.Element {
  const canLock = useSession((state) => state.can('finance.period.lock'));
  const { periods, loading, error, refresh } = usePeriods();
  const [fiscalYear, setFiscalYear] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  /** Fiscal years in the order the server returned them, newest last. */
  const years = useMemo(() => {
    const seen = new Map<string, string>();
    for (const period of periods) seen.set(period.fiscalYearId, period.fiscalYearName);
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [periods]);

  const activeYear = fiscalYear ?? years[years.length - 1]?.id ?? null;
  const visible = useMemo(
    () => periods.filter((period) => period.fiscalYearId === activeYear),
    [periods, activeYear],
  );

  const checklist = useQuery<readonly CloseChecklistItem[]>(
    fk.close(activeYear ?? 'none'),
    () => fetchCloseChecklist(activeYear ?? ''),
    { enabled: activeYear !== null, staleMs: 30_000 },
  );

  const openCount = periods.filter((period) => period.status === 'open').length;
  const draftCount = periods.reduce((sum, period) => sum + period.draftCount, 0);

  async function commit(): Promise<void> {
    if (!action) return;
    setBusy(true);
    try {
      await invoke(action.kind === 'lock' ? 'finance.periods.lock' : 'finance.periods.unlock', {
        id: action.period.id,
        reason: reason.trim(),
      });
      invalidate('periods');
      invalidate('journals');
      invalidate('tb');
      refresh();
      toast.success(
        action.kind === 'lock' ? 'Period locked' : 'Period reopened',
        `${action.period.name} · ${action.kind === 'lock' ? 'no entry can be posted into it now.' : 'posting is allowed again.'}`,
      );
      setAction(null);
      setReason('');
    } catch (caught) {
      toast.error(
        action.kind === 'lock' ? 'That period could not be locked' : 'That period could not be reopened',
        isApiError(caught) ? caught.message : 'Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Accounting periods"
        subtitle={`${openCount} open · ${periods.length - openCount} locked · ${draftCount} drafts outstanding`}
        count={periods.length}
        countLabel="periods"
        secondaryActions={
          years.length > 1 ? (
            <select
              aria-label="Fiscal year"
              value={activeYear ?? ''}
              onChange={(event) => setFiscalYear(event.target.value)}
              className="h-8 rounded-input border border-line-strong bg-surface px-2 text-body text-text"
            >
              {years.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.name}
                </option>
              ))}
            </select>
          ) : null
        }
        primaryAction={
          canLock && visible.some((period) => period.status === 'open') ? (
            <Button
              variant="primary"
              iconLeft={<Lock size={14} aria-hidden="true" />}
              onClick={() => {
                const target = [...visible].reverse().find((period) => period.status === 'open');
                if (target) {
                  setAction({ kind: 'lock', period: target });
                  setReason('');
                }
              }}
            >
              Lock the latest open period
            </Button>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {error ? (
          <div
            className="flex items-start gap-2 rounded-card border border-danger bg-danger-soft p-3 text-body text-danger"
            role="alert"
          >
            <AlertCircle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : loading && periods.length === 0 ? (
          <TableSkeleton rows={6} columns={4} />
        ) : visible.length === 0 ? (
          <EmptyState
            title="No periods yet"
            description="Periods are created by onboarding from the fiscal year start month. Re-run onboarding from Settings → Data to create them."
          />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {visible.map((period) => {
                const locked = period.status === 'locked';
                return (
                  <article
                    key={period.id}
                    className={[
                      'rounded-card border bg-surface p-3 transition-colors duration-fast',
                      locked ? 'border-line-strong' : 'border-line',
                    ].join(' ')}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-body font-medium text-text">{period.name}</p>
                        <p className="mt-0.5 text-meta text-muted">
                          {fmtDate(period.startDate)} — {fmtDate(period.endDate)}
                        </p>
                      </div>
                      <Chip tone={locked ? 'neutral' : 'success'}>{locked ? 'Locked' : 'Open'}</Chip>
                    </div>

                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-meta">
                      <dt className="text-muted">Entries</dt>
                      <dd className="text-right tabular-nums text-text">{period.entryCount.toLocaleString()}</dd>
                      <dt className="text-muted">Drafts</dt>
                      <dd className="text-right tabular-nums">
                        {period.draftCount > 0 ? (
                          <span className="text-warning">{period.draftCount.toLocaleString()}</span>
                        ) : (
                          <span className="text-muted">0</span>
                        )}
                      </dd>
                      {locked ? (
                        <>
                          <dt className="text-muted">Locked by</dt>
                          <dd className="truncate text-right text-text">{period.lockedByName ?? '—'}</dd>
                          <dt className="text-muted">When</dt>
                          <dd className="text-right text-text">{period.lockedAt ? dateTime(period.lockedAt) : '—'}</dd>
                        </>
                      ) : null}
                    </dl>

                    {canLock ? (
                      <div className="mt-3 flex justify-end">
                        <Button
                          size="sm"
                          variant={locked ? 'ghost' : 'secondary'}
                          iconLeft={locked ? <LockOpen size={13} aria-hidden="true" /> : <Lock size={13} aria-hidden="true" />}
                          onClick={() => {
                            setAction({ kind: locked ? 'unlock' : 'lock', period });
                            setReason('');
                          }}
                        >
                          {locked ? 'Reopen' : 'Lock'}
                        </Button>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>

            <SectionCard
              title="Close checklist"
              description="Every condition is re-derived from the ledger each time this page loads."
              actions={
                checklist.data ? (
                  <Chip tone={checklist.data.every((item) => item.ok) ? 'success' : 'warning'}>
                    {checklist.data.filter((item) => item.ok).length}/{checklist.data.length} ready
                  </Chip>
                ) : null
              }
            >
              {checklist.error ? (
                <p className="text-body text-danger" role="alert">
                  {checklist.error.message}
                </p>
              ) : !checklist.data ? (
                <TableSkeleton rows={4} columns={2} />
              ) : (
                <ul className="divide-y divide-line">
                  {checklist.data.map((item) => (
                    <li key={item.id} className="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
                      {item.ok ? (
                        <CheckCircle2 size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />
                      ) : (
                        <XCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
                      )}
                      <div className="min-w-0">
                        <p className="text-body text-text">{item.label}</p>
                        <p className="text-meta text-muted">{item.detail}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <div className="rounded-card border border-line bg-surface px-4 py-3">
              <p className="micro">What a lock does</p>
              <p className="mt-1 text-body text-muted">
                A locked period refuses every posting, including a reversal dated inside it. Reversing an entry whose
                period is locked posts today with a note, so the correction lands in the current period and the
                closed year stays closed.
              </p>
              <p className="mt-2 text-meta text-muted">
                {periods.reduce((sum, period) => sum + period.entryCount, 0).toLocaleString()} entries across all
                periods.
              </p>
            </div>
          </div>
        )}
      </div>

      <Modal
        open={action !== null}
        onOpenChange={(open) => (open ? undefined : setAction(null))}
        title={action?.kind === 'unlock' ? 'Reopen this period' : 'Lock this period'}
        description={
          action
            ? action.kind === 'unlock'
              ? `${action.period.name} will accept new postings again. The reason is written to the audit log.`
              : `${action.period.name} (${fmtDate(action.period.startDate)} — ${fmtDate(action.period.endDate)}) will refuse every posting. ${action.period.draftCount} drafts are still open.`
            : undefined
        }
        size="sm"
        destructive={action?.kind === 'lock'}
        busy={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAction(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={action?.kind === 'lock' ? 'danger' : 'primary'}
              loading={busy}
              disabled={reason.trim().length < 3 || action === null}
              onClick={() => void commit()}
            >
              {action?.kind === 'unlock' ? 'Reopen period' : 'Lock period'}
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1">
          <span className="micro">Reason (recorded in the audit log)</span>
          <Input
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={action?.kind === 'unlock' ? 'Late supplier invoice' : 'Year-end close signed off'}
          />
        </label>
        {action && action.kind === 'lock' && action.period.draftCount > 0 ? (
          <p className="mt-2 rounded-input border border-warning bg-warning-soft px-2 py-1.5 text-meta text-warning">
            {action.period.draftCount} draft {action.period.draftCount === 1 ? 'entry' : 'entries'} in this period will
            never be postable. Delete or post them first.
          </p>
        ) : null}
      </Modal>
    </div>
  );
}
