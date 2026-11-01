/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The list-screen scaffolding every module shares (requirement R2).
 *
 * Structure, in the order a screen reads it:
 *   PageHeader  — title, record count, one primary action, ghost secondaries
 *   StatusTabs  — segmented status filter with counts
 *   Toolbar     — search, filter chips, density, export
 *   …table…
 *   Pagination  — "1–50 of 12,431" with page controls
 *
 * These are deliberately dumb: no data fetching, no routing. A page owns its
 * query and passes rows in, which is what keeps 7 list screens from becoming 7
 * subtly different implementations of the same thing.
 */

import clsx from 'clsx';
import type { ReactNode } from 'react';

import { Button, Card, Chip, Input, Segmented, Skeleton } from './ui';

/**
 * `PageHeader` lives in its own module because the settings pages have imported
 * it since T03. Re-exported here so a finance screen needs one import for the
 * whole list-screen vocabulary.
 */
export { PageHeader } from './PageHeader';
export type { PageHeaderProps } from './PageHeader';

export interface StatusTab<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly count?: number;
}

export interface StatusTabsProps<T extends string> {
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly items: readonly StatusTab<T>[];
  readonly ariaLabel: string;
}

/** Segmented status filter. Counts come from the server, never from the page. */
export function StatusTabs<T extends string>({ value, onChange, items, ariaLabel }: StatusTabsProps<T>): JSX.Element {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex flex-wrap items-center gap-1 border-b border-line bg-surface px-4 py-2">
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.id)}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-chip px-2.5 py-1 text-meta transition-colors duration-150 ease-out',
              active ? 'bg-accent-soft text-accent-strong' : 'text-muted hover:bg-surface-2 hover:text-text',
            )}
          >
            {item.label}
            {typeof item.count === 'number' ? (
              <span className={clsx('tabular-nums text-[11px]', active ? 'text-accent-strong' : 'text-muted')}>
                {item.count.toLocaleString()}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export interface FilterChip {
  readonly id: string;
  readonly label: string;
  readonly onRemove: () => void;
}

export interface ToolbarProps {
  readonly search?: { readonly value: string; readonly onChange: (value: string) => void; readonly placeholder?: string };
  readonly chips?: readonly FilterChip[];
  readonly onAddFilter?: () => void;
  readonly density?: { readonly value: 'compact' | 'comfortable'; readonly onChange: (value: 'compact' | 'comfortable') => void };
  readonly extra?: ReactNode;
  readonly onExport?: () => void;
}

export function Toolbar({ search, chips, onAddFilter, density, extra, onExport }: ToolbarProps): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
      {search ? (
        <Input
          value={search.value}
          onChange={(event) => search.onChange(event.target.value)}
          placeholder={search.placeholder ?? 'Search'}
          aria-label={search.placeholder ?? 'Search'}
          // `/` focuses the first search box on the page. The attribute is the
          // contract; a placeholder would be a fragile thing to match on.
          data-search-input=""
          className="h-8 w-56"
        />
      ) : null}
      {chips?.map((chip) => (
        <Chip key={chip.id} tone="accent">
          <button type="button" onClick={chip.onRemove} className="inline-flex items-center gap-1" aria-label={`Remove filter ${chip.label}`}>
            {chip.label}
            <span aria-hidden="true">×</span>
          </button>
        </Chip>
      ))}
      {onAddFilter ? (
        <Button size="sm" variant="ghost" onClick={onAddFilter}>
          + Filter
        </Button>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        {extra}
        {density ? (
          <Segmented
            ariaLabel="Row density"
            value={density.value}
            onChange={density.onChange}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        ) : null}
        {onExport ? (
          <Button size="sm" variant="ghost" onClick={onExport}>
            Export
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export interface PaginationProps {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly onPage: (page: number) => void;
}

export function Pagination({ page, pageSize, total, onPage }: PaginationProps): JSX.Element {
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line bg-surface px-4 py-2 text-meta text-muted">
      <span className="tabular-nums">
        {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <span className="tabular-nums px-2">
          {page} / {pages}
        </span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export interface EmptyStateProps {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
  readonly icon?: ReactNode;
}

/** Illustration-free by design: a calm rule of type beats a clip-art box. */
export function EmptyState({ title, description, action, icon }: EmptyStateProps): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-card bg-surface-2 text-muted" aria-hidden="true">
        {icon ?? <span className="text-title">◇</span>}
      </div>
      <div>
        <p className="text-body font-medium text-text">{title}</p>
        <p className="mt-1 max-w-sm text-meta text-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

/** First-load placeholder: a table-shaped skeleton, never a spinner (R2). */
export function TableSkeleton({ rows = 8, columns = 5 }: { readonly rows?: number; readonly columns?: number }): JSX.Element {
  return (
    <div className="px-4 py-3" aria-hidden="true">
      {Array.from({ length: rows }, (_unused, index) => (
        <div key={index} className="flex items-center gap-4 border-b border-line py-3 last:border-0">
          {Array.from({ length: columns }, (_cell, cellIndex) => (
            <Skeleton key={cellIndex} height={10} width={cellIndex === 0 ? '40%' : '12%'} />
          ))}
        </div>
      ))}
    </div>
  );
}

export interface SectionCardProps {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

export function SectionCard({ title, description, actions, children }: SectionCardProps): JSX.Element {
  return (
    <Card title={title} description={description} actions={actions}>
      {children}
    </Card>
  );
}

export interface DeltaChipProps {
  readonly value: number;
  readonly suffix?: string;
  /** When true a rise is bad (costs, overdue), which flips the colour. */
  readonly inverse?: boolean;
}

/** ▲/▼ with semantic colour — the only place a trend gets a colour. */
export function DeltaChip({ value, suffix = '%', inverse = false }: DeltaChipProps): JSX.Element {
  const up = value > 0;
  const flat = value === 0;
  const good = inverse ? !up : up;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-0.5 rounded-chip px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
        flat ? 'bg-surface-2 text-muted' : good ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
      )}
    >
      {/*
        A flat delta is "no change", not "0.0 % up" — printing a filled square and
        a percentage reads like a missing glyph and an invented number.
      */}
      {flat ? (
        <span className="text-muted">no change</span>
      ) : (
        <>
          <span aria-hidden="true">{up ? '▲' : '▼'}</span>
          {Math.abs(value).toFixed(1)}
          {suffix}
        </>
      )}
    </span>
  );
}

/** A 40×14 sparkline. No axes, no chrome — the number beside it carries the value. */
export function Sparkline({ values, width = 72, height = 18 }: { readonly values: readonly number[]; readonly width?: number; readonly height?: number }): JSX.Element {
  if (values.length < 2) return <span className="inline-block" style={{ width, height }} aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map((value, index) => `${(index * step).toFixed(2)},${(height - ((value - min) / span) * height).toFixed(2)}`)
    .join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="text-accent">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Money in a table: tabular numerals, right aligned, never wrapped. */
export function MoneyCell({ children, muted = false }: { readonly children: ReactNode; readonly muted?: boolean }): JSX.Element {
  return (
    <span className={clsx('tabular-nums whitespace-nowrap', muted ? 'text-muted' : 'text-text')}>{children}</span>
  );
}

/** The sticky bulk-action bar that appears when rows are selected. */
export function BulkBar({ count, children, onClear }: { readonly count: number; readonly children: ReactNode; readonly onClear: () => void }): JSX.Element | null {
  if (count === 0) return null;
  return (
    <div className="sticky bottom-0 z-10 flex items-center gap-3 border-t border-line bg-surface px-4 py-2 shadow-raised">
      <span className="text-meta font-medium text-text">{count.toLocaleString()} selected</span>
      <div className="flex items-center gap-2">{children}</div>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
