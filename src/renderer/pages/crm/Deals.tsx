/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Deals (T09) — Kanban by default, list on demand.
 *
 * The board is the product; the list exists for the cases a board is bad at
 * ("show me everything closing this quarter, whatever the stage"). Both read the
 * same `crm.deal.board` payload, so switching view never changes the numbers.
 *
 * Moving a card is **optimistic**: the card moves at once and the server call
 * follows. A refusal restores the previous board from a snapshot taken before
 * the move — not by refetching, because a refetch would also throw away any other
 * card the user moved in the meantime.
 */

import { useCallback, useMemo, useState } from 'react';

import type { DealBoard, DealCard, DealColumn } from '@shared/crm';

import { BoardTotals, DealBoardView } from '../../components/DealBoard';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, TableSkeleton } from '../../components/patterns';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/Field';
import { Button, Chip, Segmented, Select, Textarea } from '../../components/ui';
import { RecordFormModal, type RecordField } from '../../components/RecordForm';
import { money } from '../../components/OpsTable';
import { invoke } from '../../lib/api';
import { invalidate, setQueryData, useQuery } from '../../lib/useQuery';
import { useNewParam } from '../../lib/useNewParam';
import { useSession } from '../../store';
import { toast } from '../../lib/toast';

const DEAL_FIELDS: readonly RecordField[] = [
  { key: 'name', label: 'Deal name', kind: 'text', required: true },
  { key: 'value_cents', label: 'Value', kind: 'money' },
  { key: 'expected_close_date', label: 'Expected close', kind: 'date' },
  { key: 'probability_bp', label: 'Probability (bp)', kind: 'number', help: 'Overwritten by the stage on move.' },
];

type View = 'board' | 'list';

export function CrmDeals(): JSX.Element {
  const { user } = useSession();
  const [view, setView] = useState<View>('board');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lost, setLost] = useState<DealCard | null>(null);
  const [lostReason, setLostReason] = useState('');
  const [lostNote, setLostNote] = useState('');
  useNewParam(() => setCreating(true));

  const key = `crm:board:${ownerFilter}`;
  const query = useQuery<DealBoard>(key, () =>
    invoke<DealBoard>('crm.deal.board', { ownerId: ownerFilter || undefined, perColumn: 50 }),
  );

  const refresh = useCallback(() => {
    invalidate('crm:board');
    invalidate('dashboard:');
  }, []);

  /**
   * Kanban moves are optimistic: the card appears in its new column before the
   * round trip, because a drag that waits 80 ms for SQLite feels broken. The
   * rollback restores the *whole* previous board rather than trying to invert the
   * move, because the server may also have recomputed probability, written an
   * activity, or refused for a reason the client cannot predict — inverting a
   * guess is how a board ends up showing a deal twice.
   */
  async function move(deal: DealCard, stageId: string): Promise<void> {
    if (deal.stageId === stageId) return;
    const snapshot = query.data;
    if (snapshot) {
      setQueryData<DealBoard>(key, (current) => {
        if (!current) return { ...snapshot };
        const from = current.columns.find((column) => column.stage.id === deal.stageId);
        const to = current.columns.find((column) => column.stage.id === stageId);
        if (!from || !to) return current;
        const probability = to.stage.probabilityBp;
        const moved: DealCard = { ...deal, stageId, probabilityBp: probability, daysInStage: 0 };
        const adjust = (column: DealColumn, sign: 1 | -1): DealColumn => ({
          ...column,
          count: column.count + sign,
          valueCents: column.valueCents + sign * deal.valueCents,
          weightedCents:
            column.weightedCents + sign * Math.round((deal.valueCents * column.stage.probabilityBp) / 10_000),
          deals:
            sign === -1
              ? column.deals.filter((card) => card.id !== deal.id)
              : [moved, ...column.deals],
        });
        return {
          ...current,
          columns: current.columns.map((column) => {
            if (column.stage.id === deal.stageId) return adjust(column, -1);
            if (column.stage.id === stageId) return adjust(column, 1);
            return column;
          }),
        };
      });
    }

    setBusy(true);
    try {
      await invoke('crm.deal.moveStage', { id: deal.id, stageId });
      refresh();
    } catch (error) {
      // Put the board back exactly as it was, then say why — sticky, because a
      // silently reverted drag looks like the app ignored the gesture.
      if (snapshot) setQueryData<DealBoard>(key, snapshot);
      toast.error('That move was refused', error instanceof Error ? error.message : undefined);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function closeWon(deal: DealCard): Promise<void> {
    setBusy(true);
    try {
      await invoke('crm.deal.closeWon', { id: deal.id });
      toast.success('Deal won', money(deal.valueCents));
      refresh();
    } catch (error) {
      toast.error('Could not close the deal', error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function commitLost(): Promise<void> {
    if (!lost) return;
    if (lostReason.trim().length === 0) {
      toast.error('A lost deal needs a reason');
      return;
    }
    setBusy(true);
    try {
      await invoke('crm.deal.closeLost', { id: lost.id, reason: lostReason, note: lostNote || undefined });
      toast.success('Deal marked lost', lostReason);
      setLost(null);
      setLostReason('');
      setLostNote('');
      refresh();
    } catch (error) {
      toast.error('Could not close the deal', error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  const board = query.data;
  const listRows = useMemo(
    () => (board ? board.columns.flatMap((column) => column.deals.map((deal) => ({ deal, stage: column.stage }))) : []),
    [board],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Deals"
        subtitle="Stage probability drives the forecast; the column total is what the board is for."
        count={board?.totals.count}
        countLabel="open deals"
        primaryAction={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            New deal
          </Button>
        }
        secondaryActions={
          <Segmented
            ariaLabel="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'board', label: 'Board' },
              { value: 'list', label: 'List' },
            ]}
          />
        }
        toolbar={
          <div className="flex items-center gap-2">
            {/*
              A free-text "owner id" box was a developer artefact, not a control:
              nobody types a UUID. "My deals only" is the question the salesperson
              actually asks, and it needs no extra channel because the session
              already carries the user.
            */}
            <Chip tone={ownerFilter === (user?.id ?? '') && ownerFilter !== '' ? 'accent' : 'neutral'}>
              <button
                type="button"
                aria-pressed={ownerFilter !== ''}
                onClick={() => setOwnerFilter((current) => (current === '' ? (user?.id ?? '') : ''))}
              >
                My deals only
              </button>
            </Chip>
            <Button variant="ghost" size="sm" onClick={refresh}>
              Refresh
            </Button>
          </div>
        }
      />

      {query.loading && !board ? (
        <div className="p-3">
          <TableSkeleton rows={4} columns={4} />
        </div>
      ) : query.error ? (
        <div className="p-3">
          <EmptyState title="The board could not load" description={query.error.message} />
        </div>
      ) : !board ? null : board.columns.length === 0 ? (
        <div className="p-3">
          <EmptyState title="No pipeline stages" description="Add stages in the pipeline settings first." />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          <BoardTotals board={board} />
          {view === 'board' ? (
            <DealBoardView
              board={board}
              busy={busy}
              onMove={(deal, stageId) => void move(deal, stageId)}
              onOpen={(deal) => toast.info(deal.name, `${deal.accountName ?? 'No account'} · ${money(deal.valueCents)}`)}
              onCloseWon={(deal) => void closeWon(deal)}
              onCloseLost={(deal) => {
                setLost(deal);
                setLostReason('');
                setLostNote('');
              }}
            />
          ) : (
            <div className="mt-2 min-h-0 flex-1 overflow-auto">
              <table className="w-full text-meta">
                <thead className="sticky top-0 bg-surface text-left text-[11px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-2 py-1.5">Deal</th>
                    <th className="px-2 py-1.5">Account</th>
                    <th className="px-2 py-1.5">Stage</th>
                    <th className="px-2 py-1.5 text-right">Value</th>
                    <th className="px-2 py-1.5 text-right">Weighted</th>
                    <th className="px-2 py-1.5">Close</th>
                    <th className="px-2 py-1.5 text-right">Days</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {listRows.map(({ deal, stage }) => (
                    <tr key={deal.id} className="hover:bg-elevated/50">
                      <td className="px-2 py-1.5 text-text">{deal.name}</td>
                      <td className="px-2 py-1.5 text-muted">{deal.accountName ?? '—'}</td>
                      <td className="px-2 py-1.5">{stage.name}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(deal.valueCents)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted">
                        {money(Math.round((deal.valueCents * deal.probabilityBp) / 10_000))}
                      </td>
                      <td className="px-2 py-1.5">{deal.expectedCloseDate ?? '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{deal.daysInStage}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <RecordFormModal
        open={creating}
        onOpenChange={setCreating}
        entity="deals"
        title="Deal"
        description="Stage and probability default to the pipeline's first stage."
        fields={DEAL_FIELDS}
        defaults={{ status: 'open', probability_bp: 0 }}
      />

      <Modal
        open={lost !== null}
        onOpenChange={(next: boolean) => {
          if (!next) setLost(null);
        }}
        title="Mark deal lost"
        description="The reason is required — it is what the loss report counts."
        size="md"
        busy={busy}
        onConfirm={() => void commitLost()}
      >
        <div className="space-y-3">
          <Field label="Reason" required htmlFor="lost-reason">
            <Select
              id="lost-reason"
              value={lostReason}
              onChange={(event) => setLostReason(event.target.value)}
              options={[
                { value: '', label: '—' },
                { value: 'Price', label: 'Price' },
                { value: 'Competitor', label: 'Lost to a competitor' },
                { value: 'No budget', label: 'No budget' },
                { value: 'No decision', label: 'No decision' },
                { value: 'Timing', label: 'Bad timing' },
              ]}
            />
          </Field>
          <Field label="Note" htmlFor="lost-note">
            <Textarea id="lost-note" rows={3} value={lostNote} onChange={(event) => setLostNote(event.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
