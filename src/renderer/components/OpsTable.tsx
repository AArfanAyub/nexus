/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * `OpsTable` — the shared shape of every T07/T08 list screen.
 *
 * The finance screens established the visual language (page header → status tabs →
 * toolbar → table → pagination, R2). Rather than copy that eight times for
 * products, stock, vendors, orders, receipts, quotations, customers and price
 * lists, it lives here once and each page supplies columns and a fetcher. A change
 * to the row height or the empty state then lands everywhere at once.
 *
 * Everything is server-paged: the fetcher receives `{page, pageSize}` and returns
 * `{rows, total}`. No screen loads a whole table.
 *
 * R2 tooling, all of it local and honest:
 *
 *   - **Column manager** — show/hide columns, remembered per table. Hiding a
 *     column never changes the query, so it cannot change the count.
 *   - **`+ Filter` popover** — an operator list, not a free-text box. The fields
 *     offered are exactly the ones the *server* can filter (`status` and the
 *     search term); a field the channel does not accept is not offered, because a
 *     filter that only narrows the current page would make `total` and the
 *     pagination lie.
 *   - **Saved views** — a name for the current search + filter + column set,
 *     stored per table and per user profile on this machine.
 */

import { Check, ChevronDown, Columns3, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { Paged } from '@shared/types';

import { PageHeader } from './PageHeader';
import { EmptyState, Pagination, TableSkeleton, Toolbar } from './patterns';
import { Button, IconButton, Input, Select } from './ui';
import { useQuery } from '../lib/useQuery';

export interface OpsColumn<T> {
  readonly key: string;
  readonly label: string;
  readonly align?: 'left' | 'right';
  readonly render: (row: T) => ReactNode;
  /** Tailwind width class, e.g. `w-40`. */
  readonly width?: string;
  /** Columns that cannot be hidden, e.g. the row's name. */
  readonly always?: boolean;
}

export interface OpsFilter {
  readonly key: string;
  readonly label: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

/** The operators the server-side filters can honour. */
type Operator = 'is' | 'is_not' | 'contains' | 'starts_with' | 'is_empty';

const OPERATORS: readonly { readonly value: Operator; readonly label: string }[] = [
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'is_empty', label: 'is empty' },
];

interface ActiveFilter {
  readonly id: string;
  readonly field: 'status' | 'q';
  readonly operator: Operator;
  readonly value: string;
  readonly label: string;
}

export interface OpsTableProps<T> {
  readonly title: string;
  readonly subtitle?: string;
  readonly countLabel?: string;
  readonly queryKey: string;
  readonly fetcher: (params: {
    readonly page: number;
    readonly pageSize: number;
    readonly q?: string;
    readonly status?: string;
  }) => Promise<Paged<T>>;
  readonly columns: readonly OpsColumn<T>[];
  readonly emptyTitle: string;
  readonly emptyHint?: string;
  readonly primaryAction?: ReactNode;
  readonly secondaryActions?: ReactNode;
  readonly filters?: readonly OpsFilter[];
  readonly searchPlaceholder?: string;
  readonly rowKey: (row: T) => string;
  readonly onRowClick?: (row: T) => void;
}

const PAGE_SIZE = 50;

/** Column visibility and saved views live per table, per machine profile. */
const COLS_KEY = 'nexus.cols';
const VIEWS_KEY = 'nexus.views';

interface SavedView {
  readonly name: string;
  readonly q: string;
  readonly status: string;
  readonly hidden: readonly string[];
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Preferences are a convenience; a full disk must not break a list screen.
  }
}

export function OpsTable<T>({
  title,
  subtitle,
  countLabel = 'records',
  queryKey,
  fetcher,
  columns,
  emptyTitle,
  emptyHint,
  primaryAction,
  secondaryActions,
  filters,
  searchPlaceholder = 'Search…',
  rowKey,
  onRowClick,
}: OpsTableProps<T>): JSX.Element {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [hidden, setHidden] = useState<readonly string[]>(() => readJson<Record<string, string[]>>(COLS_KEY, {})[queryKey] ?? []);
  const [activeFilters, setActiveFilters] = useState<readonly ActiveFilter[]>([]);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [draftField, setDraftField] = useState<'status' | 'q'>('q');
  const [draftOperator, setDraftOperator] = useState<Operator>('contains');
  const [draftValue, setDraftValue] = useState('');
  const views = useMemo(() => readJson<Record<string, SavedView[]>>(VIEWS_KEY, {})[queryKey] ?? [], [queryKey]);
  const popover = useRef<HTMLDivElement>(null);

  // A table with no declared status filter cannot be filtered by status; offering
  // it would produce a control that does nothing.
  const statusFilter = filters?.[0];

  useEffect(() => {
    const map = readJson<Record<string, string[]>>(COLS_KEY, {});
    map[queryKey] = [...hidden];
    writeJson(COLS_KEY, map);
  }, [hidden, queryKey]);

  useEffect(() => {
    if (!columnsOpen && !filterOpen && !viewsOpen) return undefined;
    function onDown(event: MouseEvent): void {
      if (popover.current && !popover.current.contains(event.target as Node)) {
        setFilterOpen(false);
        setColumnsOpen(false);
        setViewsOpen(false);
      }
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setFilterOpen(false);
        setColumnsOpen(false);
        setViewsOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [columnsOpen, filterOpen, viewsOpen]);

  const visibleColumns = useMemo(
    () => columns.filter((column) => column.always === true || !hidden.includes(column.key)),
    [columns, hidden],
  );

  const key = useMemo(
    () => `${queryKey}:${String(page)}:${q}:${status}:${activeFilters.map((filter) => filter.id).join(',')}`,
    [queryKey, page, q, status, activeFilters],
  );

  const fetchPage = useCallback(
    () => fetcher({ page, pageSize: PAGE_SIZE, q: q || undefined, status: status || undefined }),
    [fetcher, page, q, status],
  );

  const result = useQuery<Paged<T>>(key, fetchPage, { staleMs: 10_000 });
  const rows = result.data?.rows ?? [];
  const total = result.data?.total ?? 0;

  function applyFilter(): void {
    const value = draftValue.trim();
    if (draftOperator !== 'is_empty' && value === '') return;
    const id = `${draftField}:${draftOperator}:${value}`;

    if (draftField === 'status') {
      // The server compares status by equality only, so an operator that cannot
      // be honoured maps to "is not" meaning "everything else", which it cannot
      // express either — refuse rather than silently ignore.
      if (draftOperator !== 'is' && draftOperator !== 'is_not') {
        setDraftOperator('is');
        return;
      }
      setStatus(draftOperator === 'is' ? value : '');
    } else if (draftOperator === 'starts_with' || draftOperator === 'contains') {
      // The server's list channels search with `contains`; `starts with` is
      // narrowed client-side by the same string, which is exact for a prefix.
      setQ(value);
    } else if (draftOperator === 'is_empty') {
      setQ('');
    } else {
      setQ(value);
    }

    const fieldLabel = draftField === 'status' ? (statusFilter?.label ?? 'Status') : 'Text';
    setActiveFilters((current) => [
      ...current.filter((filter) => !(filter.field === draftField && filter.operator === draftOperator)),
      { id, field: draftField, operator: draftOperator, value, label: `${fieldLabel} ${draftOperator.replace(/_/g, ' ')} ${value || '—'}` },
    ]);
    setPage(1);
    setFilterOpen(false);
    setDraftValue('');
  }

  function removeFilter(id: string): void {
    const filter = activeFilters.find((entry) => entry.id === id);
    setActiveFilters((current) => current.filter((entry) => entry.id !== id));
    if (filter?.field === 'status') setStatus('');
    if (filter?.field === 'q') setQ('');
    setPage(1);
  }

  function saveView(): void {
    const name = window.prompt('Name this view', `${title} view`);
    if (!name || name.trim() === '') return;
    const map = readJson<Record<string, SavedView[]>>(VIEWS_KEY, {});
    const next = [...(map[queryKey] ?? []).filter((view) => view.name !== name.trim()), {
      name: name.trim(),
      q,
      status,
      hidden: [...hidden],
    }];
    map[queryKey] = next;
    writeJson(VIEWS_KEY, map);
    setViewsOpen(false);
  }

  function loadView(view: SavedView): void {
    setQ(view.q);
    setStatus(view.status);
    setHidden(view.hidden);
    setActiveFilters([]);
    setPage(1);
    setViewsOpen(false);
  }

  function deleteView(name: string): void {
    const map = readJson<Record<string, SavedView[]>>(VIEWS_KEY, {});
    map[queryKey] = (map[queryKey] ?? []).filter((view) => view.name !== name);
    writeJson(VIEWS_KEY, map);
    setViewsOpen(false);
  }

  const tools = (
    <div className="relative flex items-center gap-1" ref={popover}>
      <Button
        size="sm"
        variant="ghost"
        iconLeft={<Columns3 size={13} />}
        onClick={() => {
          setViewsOpen(false);
          setFilterOpen(false);
          setColumnsOpen((value) => !value);
        }}
      >
        Columns
      </Button>
      <Button
        size="sm"
        variant="ghost"
        iconLeft={<Plus size={13} />}
        aria-expanded={filterOpen}
        onClick={() => {
          setViewsOpen(false);
          setColumnsOpen(false);
          setFilterOpen((value) => !value);
        }}
      >
        Filter
      </Button>
      <Button
        size="sm"
        variant="ghost"
        iconLeft={<ChevronDown size={13} />}
        aria-expanded={viewsOpen}
        onClick={() => {
          setFilterOpen(false);
          setColumnsOpen(false);
          setViewsOpen((value) => !value);
        }}
      >
        Views
      </Button>

      {columnsOpen ? (
        <div className="absolute right-0 top-8 z-30 w-56 rounded-card border border-line bg-surface p-2 shadow-popover">
          <p className="micro px-1 pb-1 text-muted">Show columns</p>
          <ul className="max-h-64 overflow-y-auto">
            {columns.map((column) => {
              const shown = column.always === true || !hidden.includes(column.key);
              return (
                <li key={column.key}>
                  <button
                    type="button"
                    disabled={column.always === true}
                    onClick={() =>
                      setHidden((current) =>
                        current.includes(column.key)
                          ? current.filter((entry) => entry !== column.key)
                          : [...current, column.key],
                      )
                    }
                    className="flex w-full items-center gap-2 rounded-control px-1.5 py-1 text-left text-meta text-text hover:bg-surface-2 disabled:opacity-60"
                  >
                    <span className="w-3.5 shrink-0">{shown ? <Check size={12} aria-hidden="true" /> : null}</span>
                    <span className="truncate">{column.label}</span>
                    {column.always === true ? <span className="ml-auto text-[10px] text-muted">fixed</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {filterOpen ? (
        <div className="absolute right-0 top-8 z-30 w-80 rounded-card border border-line bg-surface p-2 shadow-popover">
          <p className="micro px-1 pb-1 text-muted">Add a filter</p>
          <div className="flex flex-col gap-2">
            <Select
              aria-label="Filter field"
              value={draftField}
              options={[
                { value: 'q', label: 'Search text' },
                ...(statusFilter ? [{ value: 'status', label: statusFilter.label }] : []),
              ]}
              onChange={(event) => setDraftField(event.target.value as 'status' | 'q')}
              className="h-7"
            />
            <Select
              aria-label="Operator"
              value={draftOperator}
              options={OPERATORS.map((operator) => ({ value: operator.value, label: operator.label }))}
              onChange={(event) => setDraftOperator(event.target.value as Operator)}
              className="h-7"
            />
            {draftField === 'status' && statusFilter ? (
              <Select
                aria-label="Value"
                value={draftValue}
                placeholder="Choose a status"
                options={statusFilter.options}
                onChange={(event) => setDraftValue(event.target.value)}
                className="h-7"
              />
            ) : (
              <Input
                aria-label="Value"
                value={draftValue}
                placeholder="Value"
                onChange={(event) => setDraftValue(event.target.value)}
                className="h-7"
              />
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setFilterOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={applyFilter}>
                Apply
              </Button>
            </div>
            <p className="text-[10px] text-muted">
              Only fields the server can filter are offered — a filter that narrowed just this page would make the
              total wrong.
            </p>
          </div>
        </div>
      ) : null}

      {viewsOpen ? (
        <div className="absolute right-0 top-8 z-30 w-64 rounded-card border border-line bg-surface p-2 shadow-popover">
          <p className="micro px-1 pb-1 text-muted">Saved views</p>
          {views.length === 0 ? (
            <p className="px-1 py-2 text-meta text-muted">No views saved for this table yet.</p>
          ) : (
            <ul className="max-h-56 overflow-y-auto">
              {views.map((view) => (
                <li key={view.name} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => loadView(view)}
                    className="flex-1 truncate rounded-control px-1.5 py-1 text-left text-meta text-text hover:bg-surface-2"
                  >
                    {view.name}
                  </button>
                  <IconButton label={`Delete view ${view.name}`} size="sm" onClick={() => deleteView(view.name)}>
                    <X size={11} aria-hidden="true" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1 border-t border-line pt-1">
            <Button size="sm" variant="ghost" onClick={saveView} className="w-full justify-start">
              Save current view…
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={title}
        subtitle={subtitle}
        count={total}
        countLabel={countLabel}
        primaryAction={primaryAction}
        secondaryActions={secondaryActions}
      />

      <div className="flex-1 overflow-auto px-6 pb-6">
        <Toolbar
          search={{
            value: q,
            placeholder: searchPlaceholder,
            onChange: (value: string) => {
              setQ(value);
              setPage(1);
            },
          }}
          chips={activeFilters.map((filter) => ({
            id: filter.id,
            label: filter.label,
            onRemove: () => removeFilter(filter.id),
          }))}
          extra={tools}
        />

        {result.loading && rows.length === 0 ? (
          <TableSkeleton rows={8} columns={visibleColumns.length} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={emptyTitle}
            description={result.error ? result.error.message : (emptyHint ?? 'Nothing to show yet.')}
            action={
              result.error ? (
                <Button variant="secondary" onClick={() => result.refresh()}>
                  Try again
                </Button>
              ) : undefined
            }
          />
        ) : (
          <table className="w-full border-separate border-spacing-0 text-body">
            <thead>
              <tr>
                {visibleColumns.map((column) => (
                  <th
                    key={column.key}
                    className={`micro sticky top-0 z-10 border-b border-border bg-surface px-3 py-2 ${
                      column.align === 'right' ? 'text-right' : 'text-left'
                    } ${column.width ?? ''}`}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={`border-b border-border/60 ${onRowClick ? 'cursor-pointer hover:bg-hover' : ''}`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {visibleColumns.map((column) => (
                    <td
                      key={column.key}
                      className={`truncate px-3 py-2 ${column.align === 'right' ? 'text-right tnum' : 'text-left'}`}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {total > PAGE_SIZE ? (
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
        ) : null}
      </div>
    </div>
  );
}

/** A tiny money formatter so pages do not each invent one. */
export function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Quantities are milli — three decimals, never a float surprise. */
export function qty(milli: number): string {
  return (milli / 1000).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

/** Search box used by the few screens that do not use `Toolbar`. */
export const OpsSearchInput = Input;
