/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The recharts implementation. Loaded lazily by `Chart.tsx`, so this module —
 * and therefore `recharts` — is a separate chunk.
 *
 * Every colour arrives as a concrete string from a CSS variable, so nothing here
 * knows a hex value (T03 acceptance #1).
 *
 * Chart chrome (R2):
 *   - **Thin axes.** One hairline, no tick marks, no axis line except the
 *     baseline. The data is the ink; the frame is a whisper.
 *   - **At most four gridlines.** `tickCount={4}` on the value axis and no
 *     vertical grid at all — five horizontal rules is a spreadsheet, not a chart.
 *   - **Gradient areas.** A single series fades from 22% to 0, so two overlapping
 *     areas stay readable instead of turning the overlap into mud.
 *   - **No legend where it is obvious.** One series means the title already says
 *     what it is; a legend that repeats the title is furniture.
 */

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { useId } from 'react';

import type { ChartProps } from './Chart';

interface ImplProps extends ChartProps {
  readonly colours: readonly string[];
}

const AXIS_PROPS = {
  tick: { fontSize: 11, fill: 'var(--text-muted)' },
  tickLine: false,
  axisLine: false,
  stroke: 'var(--border)',
} as const;

/** Four gridlines, horizontal only. */
const GRID_PROPS = {
  stroke: 'var(--border)',
  strokeDasharray: '2 4',
  strokeOpacity: 0.7,
  vertical: false,
  tickCount: 4,
} as const;

export default function ChartImpl({ kind, data, xKey, series, colours, valueFormatter }: ImplProps): JSX.Element {
  // Gradient ids are document-global. Two area charts on one page that both use
  // `revenue` would otherwise share a `<defs>` entry and the second would paint
  // with the first one's colour.
  const gradientScope = useId().replace(/[^a-zA-Z0-9]/g, '');

  const tooltipStyle = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    fontSize: 12,
    color: 'var(--text)',
    boxShadow: 'var(--shadow-popover, 0 8px 24px rgb(0 0 0 / 0.12))',
  } as const;

  // One series does not need a legend: the panel title already names it.
  const showLegend = series.length > 1;

  const format = (value: unknown): string => (valueFormatter ? valueFormatter(Number(value)) : String(value));

  if (kind === 'donut') {
    const first = series[0];
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={[...data]}
            dataKey={first?.key ?? 'value'}
            nameKey={xKey}
            innerRadius="55%"
            outerRadius="80%"
            paddingAngle={1}
            stroke="var(--surface)"
          >
            {data.map((_, index) => (
              <Cell key={index} fill={colours[index % Math.max(colours.length, 1)] ?? 'var(--accent)'} />
            ))}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} formatter={format} />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-muted)' }} iconType="circle" iconSize={7} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  const axes = (
    <>
      <CartesianGrid {...GRID_PROPS} />
      <XAxis dataKey={xKey} {...AXIS_PROPS} />
      <YAxis {...AXIS_PROPS} width={52} tickCount={4} tickFormatter={format} />
      <Tooltip
        contentStyle={tooltipStyle}
        formatter={format}
        cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
      />
      {showLegend ? (
        <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-muted)' }} iconType="circle" iconSize={7} />
      ) : null}
    </>
  );

  if (kind === 'bar') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={[...data]} barCategoryGap="22%">
          {axes}
          {series.map((serie, index) => (
            <Bar
              key={serie.key}
              dataKey={serie.key}
              name={serie.label}
              fill={colours[index] ?? 'var(--accent)'}
              radius={[2, 2, 0, 0]}
              maxBarSize={38}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (kind === 'area') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={[...data]}>
          <defs>
            {series.map((serie, index) => (
              <linearGradient key={serie.key} id={`${gradientScope}-area-${serie.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colours[index] ?? 'var(--accent)'} stopOpacity={0.22} />
                <stop offset="100%" stopColor={colours[index] ?? 'var(--accent)'} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          {axes}
          {series.map((serie, index) => (
            <Area
              key={serie.key}
              type="monotone"
              dataKey={serie.key}
              name={serie.label}
              stroke={colours[index] ?? 'var(--accent)'}
              strokeWidth={1.5}
              fill={`url(#${gradientScope}-area-${serie.key})`}
              fillOpacity={1}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={[...data]}>
        {axes}
        {series.map((serie, index) => (
          <Line
            key={serie.key}
            type="monotone"
            dataKey={serie.key}
            name={serie.label}
            stroke={colours[index] ?? 'var(--accent)'}
            strokeWidth={1.75}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
