/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * CRM analytics (T09) — the five questions a sales manager asks.
 *
 *   What did we win, and at what rate?      → the KPI strip
 *   Where is the pipeline, stage by stage?  → the funnel
 *   How long does a deal take?              → cycle time
 *   Who is winning?                         → the leaderboard
 *   Why do we lose?                         → the loss reasons
 *
 * Every number comes from one `crm.analytics` call computed in SQL. Nothing here
 * aggregates in the browser: a leaderboard that adds up only the visible page of
 * deals is worse than no leaderboard, because it looks authoritative.
 */

import { useState } from 'react';

import type { CrmAnalytics } from '@shared/crm';

import { Chart } from '../../components/Chart';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, SectionCard, TableSkeleton } from '../../components/patterns';
import { Avatar, Chip, ProgressBar, Segmented } from '../../components/ui';
import { money } from '../../components/OpsTable';
import { invoke } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { percent } from '../../lib/format';

type Range = 'quarter' | 'ytd' | 'year';

function rangeDates(range: Range): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  if (range === 'quarter') {
    const startMonth = Math.floor(now.getUTCMonth() / 3) * 3;
    return { from: new Date(Date.UTC(now.getUTCFullYear(), startMonth, 1)).toISOString().slice(0, 10), to };
  }
  if (range === 'ytd') {
    return { from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString().slice(0, 10), to };
  }
  return { from: new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1)).toISOString().slice(0, 10), to };
}

function Kpi({ label, value, hint }: { readonly label: string; readonly value: string; readonly hint?: string }): JSX.Element {
  return (
    <div className="rounded-card border border-line bg-surface p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-heading font-semibold tabular-nums text-text">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted">{hint}</div> : null}
    </div>
  );
}

export function CrmAnalytics(): JSX.Element {
  const [range, setRange] = useState<Range>('ytd');
  const { from, to } = rangeDates(range);

  const query = useQuery<CrmAnalytics>(`crm:analytics:${range}`, () =>
    invoke<CrmAnalytics>('crm.analytics', { from, to }),
  );

  const data = query.data;

  return (
    <div className="space-y-3 p-3">
      <PageHeader
        title="Analytics"
        subtitle="Win rate, cycle time, forecast and loss reasons — all from the ledger of deals."
        secondaryActions={
          <Segmented
            ariaLabel="Period"
            value={range}
            onChange={setRange}
            options={[
              { value: 'quarter', label: 'Quarter' },
              { value: 'ytd', label: 'Year to date' },
              { value: 'year', label: 'Last 12 months' },
            ]}
          />
        }
      />

      {query.loading && !data ? (
        <TableSkeleton rows={6} columns={3} />
      ) : query.error ? (
        <EmptyState title="Analytics could not load" description={query.error.message} />
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
            <Kpi label="Won" value={money(data.kpis.wonCents)} hint={`${String(data.kpis.wonCount)} deals`} />
            <Kpi label="Lost" value={money(data.kpis.lostCents)} hint={`${String(data.kpis.lostCount)} deals`} />
            <Kpi label="Win rate" value={percent(data.kpis.winRateBp)} />
            <Kpi
              label="Avg cycle"
              value={data.kpis.avgCycleDays === null ? '—' : `${String(data.kpis.avgCycleDays)} days`}
              hint="Created → won"
            />
            <Kpi label="Open pipeline" value={money(data.kpis.openCents)} />
            <Kpi label="Weighted" value={money(data.kpis.weightedCents)} hint="Forecast" />
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <SectionCard title="Forecast vs closed" description="Weighted open value beside what actually closed.">
                <Chart
                  kind="bar"
                  height={240}
                  ariaLabel="Monthly won, lost and weighted pipeline"
                  data={data.monthly.map((point) => ({
                    month: point.month,
                    won: Math.round(point.wonCents / 100),
                    lost: Math.round(point.lostCents / 100),
                    weighted: Math.round(point.openWeightedCents / 100),
                  }))}
                  xKey="month"
                  series={[
                    { key: 'won', label: 'Won', token: '--success' },
                    { key: 'lost', label: 'Lost', token: '--danger' },
                    { key: 'weighted', label: 'Weighted open', token: '--accent' },
                  ]}
                  valueFormatter={(value) => money(value * 100)}
                />
              </SectionCard>
            </div>

            <SectionCard title="Funnel" description="Open deals by stage.">
              {data.funnel.every((stage) => stage.count === 0) ? (
                <EmptyState title="No open deals" description="The funnel fills as deals are created." />
              ) : (
                <ul className="space-y-2">
                  {data.funnel.map((stage) => {
                    const max = Math.max(1, ...data.funnel.map((entry) => entry.valueCents));
                    return (
                      <li key={stage.stageId}>
                        <div className="flex items-baseline justify-between text-meta">
                          <span className="text-text">{stage.name}</span>
                          <span className="tabular-nums text-muted">
                            {stage.count} · {money(stage.valueCents)}
                          </span>
                        </div>
                        <ProgressBar value={stage.valueCents} max={max} label={`${stage.name} value`} />
                      </li>
                    );
                  })}
                </ul>
              )}
            </SectionCard>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <SectionCard title="Leaderboard" description="Won value, win rate and open pipeline by owner.">
              {data.owners.length === 0 ? (
                <EmptyState title="No owners yet" description="Assign deals to see who is winning." />
              ) : (
                <ul className="divide-y divide-line">
                  {data.owners.map((owner) => (
                    <li key={owner.ownerId ?? 'unassigned'} className="flex items-center gap-3 py-2">
                      <Avatar name={owner.ownerName} size={24} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-meta text-text">{owner.ownerName}</div>
                        <div className="text-[11px] text-muted">
                          {owner.wonCount} won · {owner.lostCount} lost · {money(owner.openCents)} open
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-meta tabular-nums text-text">{money(owner.wonCents)}</div>
                        <div className="text-[11px] text-muted">{percent(owner.winRateBp)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="Why we lose" description="Every lost deal in the period, by reason.">
              {data.lossReasons.length === 0 ? (
                <EmptyState title="Nothing lost" description="No deals were lost in this period." />
              ) : (
                <ul className="divide-y divide-line">
                  {data.lossReasons.map((bucket) => (
                    <li key={bucket.reason} className="flex items-center justify-between py-2">
                      <span className="text-meta text-text">{bucket.reason}</span>
                      <span className="flex items-center gap-2">
                        <Chip tone="danger">{bucket.count}</Chip>
                        <span className="text-meta tabular-nums text-muted">{money(bucket.valueCents)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        </>
      )}
    </div>
  );
}
