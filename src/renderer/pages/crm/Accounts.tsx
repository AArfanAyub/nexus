/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * CRM accounts (T09) — list, create, edit, and a peek panel with contacts,
 * deals and the timeline.
 *
 * The record itself is generic (`entity.list` / `entity.save`); what is bespoke
 * is the panel: three tabs over three different shapes, each fetched only when
 * its tab is opened. Opening an account must not fire six queries.
 */

import { useCallback, useState } from 'react';

import type { ActivityRow } from '@shared/crm';
import type { Paged } from '@shared/types';

import { OpsTable, money, type OpsColumn } from '../../components/OpsTable';
import { RecordFormModal, type RecordField } from '../../components/RecordForm';
import { Drawer } from '../../components/Drawer';
import { EmptyState, TableSkeleton } from '../../components/patterns';
import { Avatar, Button, Chip, Tabs } from '../../components/ui';
import { invoke } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { dateTime, relative } from '../../lib/format';

interface AccountRow {
  readonly id: string;
  readonly name: string;
  readonly industry: string | null;
  readonly domain: string | null;
  readonly health: string;
  readonly annual_revenue_cents: number | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly owner_id: string | null;
}

interface ContactRow {
  readonly id: string;
  readonly first_name: string;
  readonly last_name: string | null;
  readonly title: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly is_primary: number;
}

interface DealRow {
  readonly id: string;
  readonly name: string;
  readonly value_cents: number;
  readonly status: string;
  readonly expected_close_date: string | null;
  readonly probability_bp: number;
}

const HEALTH_TONE: Record<string, 'success' | 'warning' | 'danger'> = {
  green: 'success',
  amber: 'warning',
  red: 'danger',
};

const FIELDS: readonly RecordField[] = [
  { key: 'name', label: 'Account name', kind: 'text', required: true },
  { key: 'industry', label: 'Industry', kind: 'text' },
  { key: 'domain', label: 'Domain', kind: 'text', placeholder: 'acme.com' },
  { key: 'phone', label: 'Phone', kind: 'text' },
  { key: 'email', label: 'Email', kind: 'text' },
  { key: 'annual_revenue_cents', label: 'Annual revenue', kind: 'money' },
  {
    key: 'health',
    label: 'Health',
    kind: 'select',
    help: 'A judgement, not a formula. Red means someone should call them.',
    options: [
      { value: 'green', label: 'Green — healthy' },
      { value: 'amber', label: 'Amber — watch' },
      { value: 'red', label: 'Red — at risk' },
    ],
  },
];

const CONTACT_FIELDS: readonly RecordField[] = [
  { key: 'first_name', label: 'First name', kind: 'text', required: true },
  { key: 'last_name', label: 'Last name', kind: 'text' },
  { key: 'title', label: 'Job title', kind: 'text' },
  { key: 'email', label: 'Email', kind: 'text' },
  { key: 'phone', label: 'Phone', kind: 'text' },
  { key: 'is_primary', label: 'Primary contact', kind: 'checkbox' },
];

const COLUMNS: readonly OpsColumn<AccountRow>[] = [
  {
    key: 'name',
    label: 'Account',
    render: (row) => (
      <span className="flex items-center gap-2">
        <Avatar name={row.name} size={22} />
        <span className="text-text">{row.name}</span>
      </span>
    ),
  },
  { key: 'industry', label: 'Industry', width: 'w-36', render: (row) => row.industry ?? '—' },
  { key: 'domain', label: 'Domain', width: 'w-40', render: (row) => row.domain ?? '—' },
  {
    key: 'health',
    label: 'Health',
    width: 'w-24',
    render: (row) => <Chip tone={HEALTH_TONE[row.health] ?? 'neutral'}>{row.health}</Chip>,
  },
  {
    key: 'revenue',
    label: 'Annual revenue',
    align: 'right',
    width: 'w-32',
    render: (row) => (row.annual_revenue_cents ? money(row.annual_revenue_cents) : '—'),
  },
];

type Tab = 'contacts' | 'deals' | 'timeline';

export function CrmAccounts(): JSX.Element {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AccountRow | null>(null);
  const [open, setOpen] = useState<AccountRow | null>(null);
  const [tab, setTab] = useState<Tab>('contacts');
  const [addingContact, setAddingContact] = useState(false);

  const fetcher = useCallback(async ({ page, pageSize, q }: { page: number; pageSize: number; q?: string }) => {
    return invoke<Paged<AccountRow>>('entity.list', {
      entity: 'crmAccounts',
      q,
      sort: { key: 'name', dir: 'asc' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
  }, []);

  const contacts = useQuery<readonly ContactRow[]>(
    `crm:contacts:${open?.id ?? ''}`,
    async () => {
      const page = await invoke<Paged<ContactRow>>('entity.list', {
        entity: 'contacts',
        filters: { account_id: open?.id },
        limit: 100,
        offset: 0,
      });
      return page.rows;
    },
    { enabled: open !== null && tab === 'contacts' },
  );

  const deals = useQuery<readonly DealRow[]>(
    `crm:deals:${open?.id ?? ''}`,
    async () => {
      const page = await invoke<Paged<DealRow>>('entity.list', {
        entity: 'deals',
        filters: { account_id: open?.id },
        sort: { key: 'value_cents', dir: 'desc' },
        limit: 100,
        offset: 0,
      });
      return page.rows;
    },
    { enabled: open !== null && tab === 'deals' },
  );

  const timeline = useQuery<{ rows: readonly ActivityRow[] }>(
    `crm:timeline:${open?.id ?? ''}`,
    () => invoke<{ rows: readonly ActivityRow[] }>('crm.timeline', { entity: 'crm_accounts', entityId: open?.id, limit: 50 }),
    { enabled: open !== null && tab === 'timeline' },
  );

  return (
    <>
      <OpsTable<AccountRow>
        title="Accounts"
        subtitle="Every company you sell to, with the health judgement that goes with it."
        countLabel="accounts"
        queryKey="crm:accounts"
        fetcher={fetcher}
        columns={COLUMNS}
        rowKey={(row) => row.id}
        onRowClick={(row) => {
          setTab('contacts');
          setOpen(row);
        }}
        searchPlaceholder="Search name or domain"
        emptyTitle="No accounts yet"
        emptyHint="Convert a lead, or add an account directly."
        primaryAction={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            New account
          </Button>
        }
      />

      <RecordFormModal
        open={creating}
        onOpenChange={setCreating}
        entity="crmAccounts"
        title="Account"
        fields={FIELDS}
        defaults={{ health: 'green' }}
      />
      <RecordFormModal
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
        entity="crmAccounts"
        title="Account"
        fields={FIELDS}
        initial={editing}
      />

      <Drawer
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        title={open?.name ?? ''}
        subtitle={[open?.industry, open?.domain].filter(Boolean).join(' · ')}
        width={560}
        footer={
          <div className="flex justify-between">
            <Button variant="ghost" size="sm" onClick={() => setEditing(open)}>
              Edit account
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setAddingContact(true)}>
              Add contact
            </Button>
          </div>
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          ariaLabel="Account detail"
          items={[
            { value: 'contacts', label: 'Contacts' },
            { value: 'deals', label: 'Deals' },
            { value: 'timeline', label: 'Timeline' },
          ]}
        />

        <div className="mt-3">
          {tab === 'contacts' ? (
            contacts.loading ? (
              <TableSkeleton rows={3} columns={3} />
            ) : (contacts.data ?? []).length === 0 ? (
              <EmptyState title="No contacts" description="Add the person you actually talk to." />
            ) : (
              <ul className="divide-y divide-line">
                {(contacts.data ?? []).map((contact) => (
                  <li key={contact.id} className="flex items-center gap-3 py-2">
                    <Avatar name={`${contact.first_name} ${contact.last_name ?? ''}`} size={24} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-meta text-text">
                        {contact.first_name} {contact.last_name ?? ''}
                        {Number(contact.is_primary) === 1 ? (
                          <span className="ml-1.5">
                            <Chip tone="accent">Primary</Chip>
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-[11px] text-muted">
                        {[contact.title, contact.email, contact.phone].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : tab === 'deals' ? (
            deals.loading ? (
              <TableSkeleton rows={3} columns={3} />
            ) : (deals.data ?? []).length === 0 ? (
              <EmptyState title="No deals" description="Nothing is being pursued with this account yet." />
            ) : (
              <ul className="divide-y divide-line">
                {(deals.data ?? []).map((deal) => (
                  <li key={deal.id} className="flex items-center justify-between py-2">
                    <div className="min-w-0">
                      <div className="truncate text-meta text-text">{deal.name}</div>
                      <div className="text-[11px] text-muted">
                        {deal.expected_close_date ?? 'No close date'}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-meta tabular-nums text-text">{money(deal.value_cents)}</div>
                      <div className="text-[11px] text-muted">{deal.status}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : timeline.loading ? (
            <TableSkeleton rows={4} columns={2} />
          ) : (timeline.data?.rows ?? []).length === 0 ? (
            <EmptyState title="Nothing logged" description="Calls, emails and stage moves appear here." />
          ) : (
            <ol className="space-y-2">
              {(timeline.data?.rows ?? []).map((entry) => (
                <li key={entry.id} className="rounded-card border border-line p-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-meta font-medium text-text">{entry.subject}</span>
                    <span className="text-[11px] text-muted" title={dateTime(entry.createdAt)}>
                      {relative(entry.createdAt)}
                    </span>
                  </div>
                  {entry.body ? <p className="mt-0.5 text-[11px] text-muted">{entry.body}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </Drawer>

      <RecordFormModal
        open={addingContact}
        onOpenChange={setAddingContact}
        entity="contacts"
        title="Contact"
        fields={CONTACT_FIELDS}
        defaults={{ account_id: open?.id, is_primary: 0 }}
      />
    </>
  );
}
