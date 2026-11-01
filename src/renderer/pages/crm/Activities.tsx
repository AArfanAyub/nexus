/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Activities (T09) — this week, and what is overdue.
 *
 * Two lists, one query each. The week grid is deliberately a **list grouped by
 * day** rather than a calendar grid: at this density a calendar shows eight
 * empty boxes and hides the three things that matter, and the overdue list is
 * the part an operator actually acts on.
 *
 * Completing an activity is one click, with no confirmation — it is reversible
 * by clicking again, and a dialog on a checkbox is a dialog people learn to
 * dismiss without reading.
 */

import { useCallback, useMemo, useState } from 'react';

import type { ActivityRow } from '@shared/crm';

import { PageHeader } from '../../components/PageHeader';
import { EmptyState, SectionCard, TableSkeleton } from '../../components/patterns';
import { Button, Checkbox, Chip } from '../../components/ui';
import { RecordFormModal } from '../../components/RecordForm';
import { invoke } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useNewParam } from '../../lib/useNewParam';
import { toast } from '../../lib/toast';
import { date, relative } from '../../lib/format';

function isoDaysFromToday(days: number): string {
  const cursor = new Date();
  cursor.setDate(cursor.getDate() + days);
  return cursor.toISOString().slice(0, 10);
}

const TYPE_TONE: Record<string, 'neutral' | 'accent' | 'info' | 'success' | 'warning'> = {
  call: 'accent',
  email: 'info',
  meeting: 'success',
  task: 'warning',
  note: 'neutral',
  stage_changed: 'neutral',
  system: 'neutral',
};

export function CrmActivities(): JSX.Element {
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  useNewParam(() => setAdding(true));

  const week = useQuery<{ rows: readonly ActivityRow[]; total: number }>('crm:activities:week', () =>
    invoke('crm.timeline', { from: isoDaysFromToday(-1), to: isoDaysFromToday(7), limit: 200 }),
  );

  const overdue = useQuery<{ rows: readonly ActivityRow[]; total: number }>('crm:activities:overdue', () =>
    invoke('crm.timeline', { openOnly: true, to: isoDaysFromToday(-1), limit: 200 }),
  );

  const toggle = useCallback(async (activity: ActivityRow) => {
    setBusyId(activity.id);
    try {
      await invoke('crm.activity.complete', { id: activity.id, done: !activity.isDone });
      invalidate('crm:activities');
      invalidate('dashboard:');
    } catch (error) {
      toast.error('Could not update the activity', error instanceof Error ? error.message : undefined);
    } finally {
      setBusyId(null);
    }
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, ActivityRow[]>();
    for (const row of week.data?.rows ?? []) {
      const key = (row.dueAt ?? row.createdAt).slice(0, 10);
      const bucket = map.get(key) ?? [];
      bucket.push(row);
      map.set(key, bucket);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [week.data]);

  function Row({ activity }: { readonly activity: ActivityRow }): JSX.Element {
    return (
      <li className="flex items-start gap-2 py-2">
        <Checkbox
          checked={activity.isDone}
          disabled={busyId === activity.id}
          onChange={() => void toggle(activity)}
          label={`Mark ${activity.subject} ${activity.isDone ? 'not done' : 'done'}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Chip tone={TYPE_TONE[activity.type] ?? 'neutral'}>{activity.type.replace('_', ' ')}</Chip>
            <span className={activity.isDone ? 'truncate text-meta text-muted line-through' : 'truncate text-meta text-text'}>
              {activity.subject}
            </span>
          </div>
          {activity.body ? <p className="mt-0.5 truncate text-[11px] text-muted">{activity.body}</p> : null}
          <p className="text-[11px] text-muted">
            {activity.ownerName ?? 'Unassigned'}
            {activity.dueAt ? ` · due ${date(activity.dueAt)}` : ''}
            {activity.isDone && activity.completedAt ? ` · done ${relative(activity.completedAt)}` : ''}
          </p>
        </div>
      </li>
    );
  }

  return (
    <div className="space-y-3 p-3">
      <PageHeader
        title="Activities"
        subtitle="Calls, emails, meetings and tasks across every record."
        count={(week.data?.total ?? 0) + (overdue.data?.total ?? 0)}
        countLabel="activities"
        primaryAction={
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            Log activity
          </Button>
        }
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionCard title="This week" description="Grouped by due date.">
            {week.loading ? (
              <TableSkeleton rows={5} columns={2} />
            ) : grouped.length === 0 ? (
              <EmptyState title="Nothing scheduled" description="Log a call or a task and it appears here." />
            ) : (
              <div className="space-y-3">
                {grouped.map(([day, rows]) => (
                  <div key={day}>
                    <h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted">{date(day)}</h3>
                    <ul className="divide-y divide-line">
                      {rows.map((activity) => (
                        <Row key={activity.id} activity={activity} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        <SectionCard title="Overdue" description="Open activities whose due date has passed.">
          {overdue.loading ? (
            <TableSkeleton rows={4} columns={2} />
          ) : (overdue.data?.rows ?? []).length === 0 ? (
            <EmptyState title="Nothing overdue" description="Everything with a due date is done." />
          ) : (
            <ul className="divide-y divide-line">
              {(overdue.data?.rows ?? []).map((activity) => (
                <Row key={activity.id} activity={activity} />
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <RecordFormModal
        open={adding}
        onOpenChange={setAdding}
        entity="activities"
        title="Activity"
        fields={[
          { key: 'type', label: 'Type', kind: 'select', required: true, options: [
            { value: 'call', label: 'Call' },
            { value: 'email', label: 'Email' },
            { value: 'meeting', label: 'Meeting' },
            { value: 'task', label: 'Task' },
            { value: 'note', label: 'Note' },
          ] },
          { key: 'subject', label: 'Subject', kind: 'text', required: true },
          { key: 'body', label: 'Detail', kind: 'textarea', span: 2 },
          { key: 'due_at', label: 'Due', kind: 'date' },
        ]}
        defaults={{ type: 'task', is_done: 0, entity: 'deals' }}
      />
    </div>
  );
}
