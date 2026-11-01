/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Lazy `recharts` wrapper (ARCHITECTURE §E.4, §G.3).
 *
 * `recharts` is imported dynamically so it never enters the shell chunk — the
 * first chart pulls ~90 kB, and a user who never opens a dashboard never pays
 * for it. Colours come from CSS variables, so charts follow the theme without
 * re-rendering.
 */

import { Suspense, lazy, useMemo, type ReactNode } from 'react';

import { Skeleton } from './ui';

const Recharts = lazy(() => import('./Chart.impl'));

export type ChartKind = 'line' | 'bar' | 'area' | 'donut';

export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  /** CSS variable name without `var()` — e.g. `--accent`. */
  readonly token?: string;
}

export interface ChartProps {
  readonly kind: ChartKind;
  readonly data: readonly Record<string, string | number>[];
  readonly xKey: string;
  readonly series: readonly ChartSeries[];
  readonly height?: number;
  readonly ariaLabel: string;
  readonly valueFormatter?: (value: number) => string;
  readonly empty?: ReactNode;
}

/** Reads a token from the document so recharts gets a concrete colour string. */
function tokenColour(token: string): string {
  if (typeof window === 'undefined') return 'currentColor';
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value === '' ? 'currentColor' : value;
}

export function Chart(props: ChartProps): JSX.Element {
  const colours = useMemo(
    () => props.series.map((serie) => tokenColour(serie.token ?? '--accent')),
    [props.series],
  );

  if (props.data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-card border border-line bg-surface text-meta text-muted"
        style={{ height: props.height ?? 240 }}
      >
        {props.empty ?? 'No data for this period.'}
      </div>
    );
  }

  return (
    <div role="img" aria-label={props.ariaLabel} style={{ height: props.height ?? 240 }}>
      <Suspense fallback={<Skeleton height={props.height ?? 240} />}>
        <Recharts {...props} colours={colours} />
      </Suspense>
    </div>
  );
}
