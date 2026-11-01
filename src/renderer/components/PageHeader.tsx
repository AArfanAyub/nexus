/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * `PageHeader` — the strip at the top of every page (§E.2, R2).
 *
 * One title, one live record count, **one** accent action, and ghost secondaries.
 * That rule is the whole point: a header with three filled buttons has no
 * hierarchy, so `primaryAction` is the only slot a page should fill with
 * `variant="primary"` and everything else belongs in `secondaryActions`.
 *
 * `toolbar` renders under the title row so search, chips and density controls
 * stay with the header while the table scrolls beneath it.
 */

import type { ReactNode } from 'react';

import { Badge } from './ui';

export interface PageHeaderProps {
  readonly title: string;
  readonly subtitle?: string;
  /** Live total from the server's `Paged.total`, never the length of the page. */
  readonly count?: number;
  readonly countLabel?: string;
  readonly status?: { readonly status: string; readonly label: string };
  /** The single accent action for this view. */
  readonly primaryAction?: ReactNode;
  readonly secondaryActions?: ReactNode;
  /** Rendered under the title row: filter chips, search, saved views. */
  readonly toolbar?: ReactNode;
}

export function PageHeader({
  title,
  subtitle,
  count,
  countLabel = 'records',
  status,
  primaryAction,
  secondaryActions,
  toolbar,
}: PageHeaderProps): JSX.Element {
  const showCount = typeof count === 'number';
  return (
    <div className="sticky top-0 z-20 border-b border-line bg-surface px-5 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-title font-semibold tracking-tight text-text">{title}</h1>
            {status ? <Badge status={status.status} label={status.label} /> : null}
          </div>
          <p className="mt-0.5 truncate text-meta text-muted">
            {showCount ? (
              <span className="tabular-nums">
                {count.toLocaleString()} {countLabel}
              </span>
            ) : null}
            {showCount && subtitle ? ' · ' : null}
            {subtitle}
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {secondaryActions}
          {primaryAction}
        </div>
      </div>
      {toolbar ? <div className="mt-2.5 flex flex-wrap items-center gap-2">{toolbar}</div> : null}
    </div>
  );
}
