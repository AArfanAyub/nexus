/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * `DealBoard` — the CRM Kanban (T09, R2 visual language).
 *
 * ## Why the aggregates come from the server
 *
 * Every column header states a count, a total and a weighted forecast. Those
 * three numbers are the reason a sales manager opens this screen, and computing
 * them in the browser from the 50 cards that fit would be wrong the moment a
 * column holds 51. `crm.deal.board` returns them from SQL; this component only
 * formats them.
 *
 * ## Optimistic move with rollback
 *
 * Dragging a card moves it immediately and calls the server; a refusal rolls the
 * card back to where it came from and says why. Waiting for a round trip before
 * the card moves makes a fast board feel broken, and leaving it moved after a
 * refusal makes the board a lie.
 *
 * ## Accessibility
 *
 * Drag-and-drop alone is not operable by keyboard, so every card also offers a
 * "Move to…" menu. That is not a fallback for an edge case — it is the only way
 * some operators can use the screen at all.
 */

import { useMemo, useState, type DragEvent } from 'react';

import type { DealBoard, DealCard, DealColumn } from '@shared/crm';

import { Avatar, Chip, Spinner } from './ui';
import { money } from './OpsTable';
import { percent } from '../lib/format';

const TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'> = {
  neutral: 'neutral',
  accent: 'accent',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
};

export interface DealBoardProps {
  readonly board: DealBoard;
  readonly busy?: boolean;
  /** Called with the target stage; the caller performs the optimistic move. */
  readonly onMove: (deal: DealCard, stageId: string) => void;
  readonly onOpen: (deal: DealCard) => void;
  readonly onCloseWon: (deal: DealCard) => void;
  readonly onCloseLost: (deal: DealCard) => void;
}

function ColumnHeader({ column }: { readonly column: DealColumn }): JSX.Element {
  return (
    <div className="flex flex-col gap-1 px-2 pb-2">
      <div className="flex items-center gap-1.5">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: `var(--${column.stage.color === 'neutral' ? 'muted' : column.stage.color})` }}
          aria-hidden="true"
        />
        <span className="truncate text-meta font-medium text-text">{column.stage.name}</span>
        <span className="ml-auto rounded-chip bg-elevated px-1.5 text-[11px] tabular-nums text-muted">
          {column.count}
        </span>
      </div>
      <div className="flex items-baseline justify-between text-[11px] tabular-nums text-muted">
        <span>{money(column.valueCents)}</span>
        <span title="Weighted by stage probability">{money(column.weightedCents)}</span>
      </div>
      <div className="text-[11px] text-muted">{percent(column.stage.probabilityBp)}</div>
    </div>
  );
}

function Card({
  deal,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
  stages,
  onMove,
  onCloseWon,
  onCloseLost,
}: {
  readonly deal: DealCard;
  readonly dragging: boolean;
  readonly onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDragEnd: () => void;
  readonly onOpen: () => void;
  readonly stages: readonly { readonly id: string; readonly name: string }[];
  readonly onMove: (stageId: string) => void;
  readonly onCloseWon: () => void;
  readonly onCloseLost: () => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={[
        'group relative cursor-grab rounded-card border border-line bg-surface p-2.5 shadow-sm',
        'transition-[box-shadow,opacity,transform] duration-150 ease-out',
        dragging ? 'opacity-40' : 'hover:shadow-md',
      ].join(' ')}
    >
      <button type="button" className="block w-full text-left" onClick={onOpen}>
        <div className="truncate text-meta font-medium text-text">{deal.name}</div>
        <div className="mt-0.5 truncate text-[11px] text-muted">{deal.accountName ?? 'No account'}</div>
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-meta font-medium tabular-nums text-text">{money(deal.valueCents)}</span>
          <span className="flex items-center gap-1">
            {deal.daysOverdue > 0 ? (
              <Chip tone="danger" title={`Expected ${String(deal.daysOverdue)} days ago`}>
                {deal.daysOverdue}d late
              </Chip>
            ) : null}
            {deal.daysInStage > 14 ? (
              <Chip tone="warning" title="Stalled in this stage">
                {deal.daysInStage}d
              </Chip>
            ) : null}
          </span>
        </div>
      </button>
      <div className="mt-1.5 flex items-center justify-between">
        {deal.ownerName ? <Avatar name={deal.ownerName} size={20} /> : <span className="text-[11px] text-muted">Unassigned</span>}
        <button
          type="button"
          className="rounded px-1 text-[11px] text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus:opacity-100"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          Move to…
        </button>
      </div>
      {menuOpen ? (
        <div role="menu" className="absolute right-2 top-full z-10 mt-1 w-44 rounded-card border border-line bg-surface p-1 shadow-lg">
          {stages.map((stage) => (
            <button
              key={stage.id}
              type="button"
              role="menuitem"
              className="block w-full rounded px-2 py-1 text-left text-meta hover:bg-elevated"
              onClick={() => {
                setMenuOpen(false);
                onMove(stage.id);
              }}
            >
              {stage.name}
            </button>
          ))}
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded px-2 py-1 text-left text-meta text-success hover:bg-elevated"
            onClick={() => {
              setMenuOpen(false);
              onCloseWon();
            }}
          >
            Mark won
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded px-2 py-1 text-left text-meta text-danger hover:bg-elevated"
            onClick={() => {
              setMenuOpen(false);
              onCloseLost();
            }}
          >
            Mark lost…
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function DealBoardView({ board, busy = false, onMove, onOpen, onCloseWon, onCloseLost }: DealBoardProps): JSX.Element {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverStage, setHoverStage] = useState<string | null>(null);
  const stages = useMemo(() => board.pipeline.stages.map((stage) => ({ id: stage.id, name: stage.name })), [board]);

  return (
    <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto pb-2">
      {board.columns.map((column) => (
        <section
          key={column.stage.id}
          aria-label={column.stage.name}
          className={[
            'flex w-[272px] shrink-0 flex-col rounded-card border bg-bg/40 transition-colors duration-150',
            hoverStage === column.stage.id ? 'border-accent bg-accent/5' : 'border-line',
          ].join(' ')}
          onDragOver={(event) => {
            event.preventDefault();
            setHoverStage(column.stage.id);
          }}
          onDragLeave={() => setHoverStage((current) => (current === column.stage.id ? null : current))}
          onDrop={(event) => {
            event.preventDefault();
            setHoverStage(null);
            const id = event.dataTransfer.getData('text/plain');
            setDraggingId(null);
            const deal = board.columns.flatMap((entry) => entry.deals).find((entry) => entry.id === id);
            if (deal) onMove(deal, column.stage.id);
          }}
        >
          <ColumnHeader column={column} />
          <div className="flex min-h-[80px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
            {column.deals.map((deal) => (
              <Card
                key={deal.id}
                deal={deal}
                dragging={draggingId === deal.id}
                stages={stages}
                onDragStart={(event) => {
                  event.dataTransfer.setData('text/plain', deal.id);
                  event.dataTransfer.effectAllowed = 'move';
                  setDraggingId(deal.id);
                }}
                onDragEnd={() => setDraggingId(null)}
                onOpen={() => onOpen(deal)}
                onMove={(stageId) => onMove(deal, stageId)}
                onCloseWon={() => onCloseWon(deal)}
                onCloseLost={() => onCloseLost(deal)}
              />
            ))}
            {column.count > column.deals.length ? (
              <p className="px-1 text-[11px] text-muted">
                {column.count - column.deals.length} more not shown
              </p>
            ) : null}
            {column.count === 0 ? (
              <div className="rounded-card border border-dashed border-line px-2 py-4 text-center text-[11px] text-muted">
                Drop a deal here
              </div>
            ) : null}
          </div>
        </section>
      ))}
      {busy ? (
        <div className="flex items-center gap-2 px-2 text-meta text-muted">
          <Spinner /> Saving…
        </div>
      ) : null}
    </div>
  );
}

/** The board's summary strip: pipeline, weighted forecast, won and lost. */
export function BoardTotals({ board }: { readonly board: DealBoard }): JSX.Element {
  const items = [
    { label: 'Open deals', value: String(board.totals.count) },
    { label: 'Pipeline', value: money(board.totals.valueCents) },
    { label: 'Weighted forecast', value: money(board.totals.weightedCents) },
    { label: 'Won', value: money(board.closed.wonCents) },
    { label: 'Lost', value: money(board.closed.lostCents) },
  ];
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-line px-1 py-2">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-muted">{item.label}</span>
          <span className="text-meta font-medium tabular-nums text-text">{item.value}</span>
        </div>
      ))}
      <Chip tone={TONE[board.pipeline.stages[0]?.color ?? 'neutral'] ?? 'neutral'}>{board.pipeline.name}</Chip>
    </div>
  );
}
