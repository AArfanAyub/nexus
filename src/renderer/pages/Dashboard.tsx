/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Dashboard (T10) — the first screen after sign-in.
 *
 * Six KPIs, twelve months of revenue against cost, the pipeline by stage, four
 * "needs attention" lists and the audit feed. One `dashboard.summary` call
 * returns all of it, cached for 30 s, so navigating away and back is free and
 * the first paint after a posting still shows the new number.
 *
 * Every tile links to the screen that explains it. A KPI you cannot drill into
 * is a number nobody trusts.
 */

import { useState } from 'react';

import type { AttentionGroup, DashboardSummary, DashboardPeriodKey } from '@shared/dashboard';

import { Chart } from '../components/Chart';
import { PageHeader } from '../components/PageHeader';
import { DeltaChip, EmptyState, SectionCard, Sparkline, TableSkeleton } from '../components/patterns';
import { Button, Chip, Segmented } from '../components/ui';
import { invoke, isApiError } from '../lib/api';
import { invalidate, useQuery } from '../lib/useQuery';
import { toast } from '../lib/toast';
import { compactMoney, relative } from '../lib/format';
import { useNavigate } from 'react-router-dom';

function KpiTile({
  label,
  value,
  delta,
  deltaPct,
  higherIsBetter,
  sparkline,
  href,
  onOpen,
}: {
  readonly label: string;
  readonly value: string;
  readonly delta: number;
  readonly deltaPct: number | null;
  readonly higherIsBetter: boolean;
  readonly sparkline: readonly number[];
  readonly href: string;
  readonly onOpen: (href: string) => void;
}): JSX.Element {
  const good = higherIsBetter ? delta >= 0 : delta <= 0;
  return (
    <button
      type="button"
      onClick={() => onOpen(href)}
      className="group flex flex-col gap-1 rounded-card border border-line bg-surface p-3 text-left transition-shadow duration-150 hover:shadow-md"
    >
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="text-heading font-semibold tabular-nums text-text">{value}</span>
      <span className="flex items-center justify-between">
        <DeltaChip value={deltaPct ?? 0} inverse={!good} />
        <Sparkline values={sparkline} />
      </span>
    </button>
  );
}

function AttentionList({ group, onOpen }: { readonly group: AttentionGroup; readonly onOpen: (href: string) => void }): JSX.Element {
  return (
    <SectionCard
      title={group.label}
      description={group.count === 0 ? 'Nothing to do here.' : `${String(group.count)} item${group.count === 1 ? '' : 's'}`}
    >
      {group.items.length === 0 ? (
        <EmptyState title="All clear" description="Nothing needs attention here." />
      ) : (
        <ul className="divide-y divide-line">
          {group.items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onOpen(item.href)}
                className="flex w-full items-baseline justify-between gap-2 py-1.5 text-left hover:bg-elevated/50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-meta text-text">{item.title}</span>
                  <span className="block truncate text-[11px] text-muted">{item.subtitle}</span>
                </span>
                <span className="shrink-0 text-right">
                  {item.amountCents !== null ? (
                    <span className="block text-meta tabular-nums text-text">{compactMoney(item.amountCents)}</span>
                  ) : null}
                  {item.days > 0 ? <span className="block text-[11px] text-warning">{item.days}d</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export function Dashboard(): JSX.Element {
  const [period, setPeriod] = useState<DashboardPeriodKey>('month');
  const navigate = useNavigate();
  const [seeding, setSeeding] = useState(false);

  /** Loads the demo company from the dashboard, so an empty install is one click from explorable. */
  async function loadDemo(): Promise<void> {
    setSeeding(true);
    try {
      const result = await invoke<{ created?: number }>('settings.demoData.seed', {});
      invalidate('');
      toast.success('Demo data loaded', `${String(result.created ?? 0)} records created.`);
    } catch (caught) {
      toast.error('Could not load the demo data', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setSeeding(false);
    }
  }
  const query = useQuery<DashboardSummary>(`dashboard:${period}`, () =>
    invoke<DashboardSummary>('dashboard.summary', { period }),
  );

  const data = query.data;
  const open = (href: string): void => navigate(href);

  return (
    <div className="space-y-3 p-3">
      <PageHeader
        title="Dashboard"
        subtitle={data ? `${data.period.label} · compared with ${data.period.priorFrom} → ${data.period.priorTo}` : undefined}
        secondaryActions={
          <Segmented
            ariaLabel="Period"
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'month', label: 'This month' },
              { value: 'quarter', label: 'Quarter' },
              { value: 'ytd', label: 'Year to date' },
            ]}
          />
        }
      />

      {query.loading && !data ? (
        <TableSkeleton rows={8} columns={4} />
      ) : query.error ? (
        <EmptyState title="The dashboard could not load" description={query.error.message} />
      ) : !data ? null : (
        <>
          {/*
            An empty company is the most common reason a screen "looks broken":
            every list is genuinely empty. Say so, and offer the two ways out.
          */}
          {data.isEmpty ? (
            <div className="flex flex-wrap items-center gap-4 rounded-card border border-line bg-surface p-4">
              <div className="min-w-0 flex-1">
                <p className="text-body font-semibold text-text">Your books are empty</p>
                <p className="mt-0.5 text-meta text-muted">
                  Nothing has been entered yet, so every list shows its empty state. Load a demo company
                  to explore, or start with your own first invoice.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="primary" loading={seeding} onClick={() => void loadDemo()}>
                  Load demo data
                </Button>
                <Button variant="secondary" onClick={() => navigate('/finance/invoices?new=1')}>
                  Create an invoice
                </Button>
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
            {data.kpis.map((kpi) => (
              <KpiTile
                key={kpi.key}
                label={kpi.label}
                value={kpi.unit === 'money' ? compactMoney(kpi.value) : String(kpi.value)}
                delta={kpi.delta}
                deltaPct={kpi.deltaPct}
                higherIsBetter={kpi.higherIsBetter}
                sparkline={kpi.sparkline}
                href={kpi.href}
                onOpen={open}
              />
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <SectionCard title="Revenue and cost" description="Twelve months, by posting date.">
                <Chart
                  kind="area"
                  height={240}
                  ariaLabel="Revenue and expenses by month"
                  data={data.series.map((point) => ({
                    label: point.label,
                    revenue: Math.round(point.revenueCents / 100),
                    expense: Math.round(point.expenseCents / 100),
                  }))}
                  xKey="label"
                  series={[
                    { key: 'revenue', label: 'Revenue', token: '--accent' },
                    { key: 'expense', label: 'Expenses', token: '--warning' },
                  ]}
                  valueFormatter={(value) => compactMoney(value * 100)}
                />
              </SectionCard>
            </div>

            <SectionCard title="Pipeline" description="Open deals by stage, weighted by probability.">
              {data.pipeline.length === 0 ? (
                <EmptyState title="No pipeline" description="Create stages to see the forecast." />
              ) : (
                <ul className="space-y-1.5">
                  {data.pipeline.map((slice) => (
                    <li key={slice.stageId} className="flex items-baseline justify-between text-meta">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: `var(--${slice.color === 'neutral' ? 'muted' : slice.color})` }}
                          aria-hidden="true"
                        />
                        <span className="text-text">{slice.name}</span>
                      </span>
                      <span className="tabular-nums text-muted">
                        {slice.count} · {compactMoney(slice.valueCents)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>

          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
            {data.attention.map((group) => (
              <AttentionList key={group.kind} group={group} onOpen={open} />
            ))}
          </div>

          <SectionCard title="Recent activity" description="The last twelve audited actions.">
            {data.activity.length === 0 ? (
              <EmptyState title="Nothing yet" description="Every posting, edit and approval appears here." />
            ) : (
              <ul className="divide-y divide-line">
                {data.activity.map((entry) => (
                  <li key={entry.id} className="flex items-baseline justify-between gap-2 py-1.5">
                    <span className="min-w-0">
                      <span className="block truncate text-meta capitalize text-text">{entry.title}</span>
                      <span className="block truncate text-[11px] text-muted">{entry.actorName}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-muted">{relative(entry.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <p className="pb-2 text-right text-[11px] text-muted">
            Computed in {String(data.ms)} ms · <Chip tone="neutral">{data.period.key}</Chip>
          </p>
        </>
      )}
    </div>
  );
}
