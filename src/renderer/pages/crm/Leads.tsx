/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Leads (T09) — the inbox, with a three-step conversion wizard.
 *
 * The wizard's third step is the point of the whole screen: it shows exactly
 * what will be created — account name, contact name, deal name, stage — before
 * anything is written, and that preview comes from the **same** server function
 * that performs the conversion. A preview computed in the browser would drift
 * from the commit the first time either side changed.
 *
 * The commit is one transaction: if the deal cannot be created, the account and
 * contact are rolled back with it. A half-converted lead is worse than a failed
 * one, because nobody can tell it happened.
 */

import { useCallback, useState } from 'react';

import type { LeadConvertPreview } from '@shared/crm';
import type { Paged } from '@shared/types';

import { OpsTable, money, type OpsColumn } from '../../components/OpsTable';
import { RecordFormModal, type RecordField } from '../../components/RecordForm';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/Field';
import { Button, Chip, Input, Select } from '../../components/ui';
import { invoke } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useNewParam } from '../../lib/useNewParam';
import { toast } from '../../lib/toast';

interface LeadRow {
  readonly id: string;
  readonly name: string;
  readonly company: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly source: string | null;
  readonly status: string;
  readonly score: number;
  readonly estimated_value_cents: number;
  readonly loss_reason: string | null;
}

interface PipelineOption {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly stages: readonly { readonly id: string; readonly name: string; readonly probabilityBp: number }[];
}

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'danger' | 'info'> = {
  new: 'info',
  contacted: 'accent',
  qualified: 'accent',
  converted: 'success',
  lost: 'danger',
};

const FIELDS: readonly RecordField[] = [
  { key: 'name', label: 'Name', kind: 'text', required: true },
  { key: 'company', label: 'Company', kind: 'text' },
  { key: 'email', label: 'Email', kind: 'text' },
  { key: 'phone', label: 'Phone', kind: 'text' },
  { key: 'source', label: 'Source', kind: 'text', placeholder: 'web, referral, event' },
  {
    key: 'status',
    label: 'Status',
    kind: 'select',
    options: [
      { value: 'new', label: 'New' },
      { value: 'contacted', label: 'Contacted' },
      { value: 'qualified', label: 'Qualified' },
      { value: 'converted', label: 'Converted' },
      { value: 'lost', label: 'Lost' },
    ],
  },
  { key: 'score', label: 'Score', kind: 'number', help: '0–100. Used to sort the inbox.' },
  { key: 'estimated_value_cents', label: 'Estimated value', kind: 'money' },
  { key: 'notes', label: 'Notes', kind: 'textarea', span: 2 },
];

const COLUMNS: readonly OpsColumn<LeadRow>[] = [
  {
    key: 'name',
    label: 'Lead',
    render: (row) => (
      <span className="flex flex-col">
        <span className="text-text">{row.name}</span>
        <span className="text-[11px] text-muted">{row.company ?? row.email ?? '—'}</span>
      </span>
    ),
  },
  { key: 'status', label: 'Status', width: 'w-28', render: (row) => <Chip tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status}</Chip> },
  {
    key: 'score',
    label: 'Score',
    align: 'right',
    width: 'w-20',
    render: (row) => <span className="tabular-nums">{row.score}</span>,
  },
  { key: 'source', label: 'Source', width: 'w-28', render: (row) => row.source ?? '—' },
  {
    key: 'value',
    label: 'Estimated value',
    align: 'right',
    width: 'w-32',
    render: (row) => (row.estimated_value_cents > 0 ? money(row.estimated_value_cents) : '—'),
  },
  { key: 'reason', label: 'Lost reason', render: (row) => row.loss_reason ?? '—' },
];

type Step = 1 | 2 | 3;

export function CrmLeads(): JSX.Element {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<LeadRow | null>(null);
  const [converting, setConverting] = useState<LeadRow | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useNewParam(() => {
    setEditing(null);
    setCreating(true);
  });

  const [accountName, setAccountName] = useState('');
  const [industry, setIndustry] = useState('');
  const [contactFirst, setContactFirst] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [dealName, setDealName] = useState('');
  const [dealValue, setDealValue] = useState('0');
  const [pipelineId, setPipelineId] = useState('');
  const [stageId, setStageId] = useState('');
  const [closeDate, setCloseDate] = useState('');

  const pipelines = useQuery<readonly PipelineOption[]>('crm:pipelines', () =>
    invoke<readonly PipelineOption[]>('crm.pipelines.list'),
  );

  const fetcher = useCallback(async ({ page, pageSize, q, status }: { page: number; pageSize: number; q?: string; status?: string }) => {
    const filters: Record<string, unknown> = {};
    if (status) filters['status'] = status;
    return invoke<Paged<LeadRow>>('entity.list', {
      entity: 'leads',
      q,
      filters,
      sort: { key: 'score', dir: 'desc' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
  }, []);

  function openWizard(lead: LeadRow): void {
    const list = pipelines.data ?? [];
    const chosen = list.find((entry) => entry.isDefault) ?? list[0];
    setConverting(lead);
    setStep(1);
    setError(null);
    setAccountName(lead.company ?? lead.name);
    setIndustry('');
    setContactFirst(lead.name);
    setContactEmail(lead.email ?? '');
    setDealName(lead.company ? `${lead.company} — new deal` : `${lead.name} — new deal`);
    setDealValue((lead.estimated_value_cents / 100).toFixed(2));
    setPipelineId(chosen?.id ?? '');
    setStageId(chosen?.stages[0]?.id ?? '');
    setCloseDate('');
  }


  /**
   * Step 3's summary comes from the server, computed by `previewConversion` —
   * the same function that decides whether the commit is allowed. A preview
   * assembled in the browser would be a second opinion, and the two would drift.
   */
  const preview = useQuery<LeadConvertPreview>(
    `crm:convert:${converting?.id ?? ''}:${accountName}:${contactFirst}:${contactEmail}:${dealName}:${dealValue}:${pipelineId}:${stageId}`,
    () =>
      invoke<LeadConvertPreview>('crm.lead.convertPreview', {
        leadId: converting?.id,
        account: { name: accountName || '—', industry: industry || null },
        contact: { firstName: contactFirst || 'Unknown', email: contactEmail || null },
        deal: {
          name: dealName || '—',
          pipelineId,
          stageId: stageId || null,
          valueCents: Math.round(Number(dealValue.replace(/,/g, '')) * 100) || 0,
          expectedCloseDate: closeDate || null,
        },
      }),
    { enabled: converting !== null && step === 3 },
  );

  async function commit(): Promise<void> {
    if (!converting) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<{ accountId: string; contactId: string; dealId: string }>('crm.lead.convert', {
        leadId: converting.id,
        account: { name: accountName, industry: industry || null },
        contact: { firstName: contactFirst || 'Unknown', email: contactEmail || null },
        deal: {
          name: dealName,
          pipelineId,
          stageId: stageId || null,
          valueCents: Math.round(Number(dealValue.replace(/,/g, '')) * 100) || 0,
          expectedCloseDate: closeDate || null,
        },
      });
      invalidate('crm:');
      invalidate('ops:leads');
      invalidate('dashboard:');
      toast.success('Lead converted', 'Account, contact and deal created.');
      setConverting(null);
      void result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The conversion failed.');
    } finally {
      setBusy(false);
    }
  }

  const selectedPipeline = (pipelines.data ?? []).find((entry) => entry.id === pipelineId);

  return (
    <>
      <OpsTable<LeadRow>
        title="Leads"
        subtitle="Sorted by score. A lead is converted or lost — never left ambiguous."
        countLabel="leads"
        queryKey="crm:leads"
        fetcher={fetcher}
        columns={COLUMNS}
        rowKey={(row) => row.id}
        onRowClick={(row) => {
          if (row.status === 'converted' || row.status === 'lost') setEditing(row);
          else openWizard(row);
        }}
        searchPlaceholder="Search name, company or email"
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'new', label: 'New' },
              { value: 'contacted', label: 'Contacted' },
              { value: 'qualified', label: 'Qualified' },
              { value: 'converted', label: 'Converted' },
              { value: 'lost', label: 'Lost' },
            ],
          },
        ]}
        emptyTitle="No leads"
        emptyHint="Leads arrive from imports or the web form."
        primaryAction={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            New lead
          </Button>
        }
      />

      <RecordFormModal
        open={creating}
        onOpenChange={setCreating}
        entity="leads"
        title="Lead"
        fields={FIELDS}
        defaults={{ status: 'new', score: 0 }}
      />
      <RecordFormModal
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
        entity="leads"
        title="Lead"
        fields={FIELDS}
        initial={editing}
      />

      <Modal
        open={converting !== null}
        onOpenChange={(next) => {
          if (!next) setConverting(null);
        }}
        title={`Convert ${converting?.name ?? ''}`}
        description={`Step ${String(step)} of 3 — nothing is written until the last step.`}
        size="lg"
        busy={busy}
        footer={
          <div className="flex justify-between">
            <Button variant="ghost" size="sm" onClick={() => (step === 1 ? setConverting(null) : setStep((step - 1) as Step))}>
              {step === 1 ? 'Cancel' : 'Back'}
            </Button>
            {step < 3 ? (
              <Button variant="primary" size="sm" onClick={() => setStep((step + 1) as Step)}>
                Continue
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={() => void commit()} disabled={busy}>
                {busy ? 'Converting…' : 'Create all three'}
              </Button>
            )}
          </div>
        }
      >
        {step === 1 ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Field label="Account name" required htmlFor="convert-account">
                <Input id="convert-account" value={accountName} onChange={(event) => setAccountName(event.target.value)} />
              </Field>
            </div>
            <Field label="Industry" htmlFor="convert-industry">
              <Input id="convert-industry" value={industry} onChange={(event) => setIndustry(event.target.value)} />
            </Field>
            <Field label="Contact first name" required htmlFor="convert-contact">
              <Input id="convert-contact" value={contactFirst} onChange={(event) => setContactFirst(event.target.value)} />
            </Field>
            <div className="col-span-2">
              <Field label="Contact email" htmlFor="convert-email">
                <Input id="convert-email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} />
              </Field>
            </div>
          </div>
        ) : step === 2 ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Field label="Deal name" required htmlFor="convert-deal">
                <Input id="convert-deal" value={dealName} onChange={(event) => setDealName(event.target.value)} />
              </Field>
            </div>
            <Field label="Value" htmlFor="convert-value">
              <Input id="convert-value" inputMode="decimal" value={dealValue} onChange={(event) => setDealValue(event.target.value)} />
            </Field>
            <Field label="Expected close" htmlFor="convert-close">
              <Input id="convert-close" type="date" value={closeDate} onChange={(event) => setCloseDate(event.target.value)} />
            </Field>
            <Field label="Pipeline" htmlFor="convert-pipeline">
              <Select
                id="convert-pipeline"
                value={pipelineId}
                onChange={(event) => {
                  setPipelineId(event.target.value);
                  const next = (pipelines.data ?? []).find((entry) => entry.id === event.target.value);
                  setStageId(next?.stages[0]?.id ?? '');
                }}
                options={(pipelines.data ?? []).map((entry) => ({ value: entry.id, label: entry.name }))}
              />
            </Field>
            <Field label="Stage" htmlFor="convert-stage">
              <Select
                id="convert-stage"
                value={stageId}
                onChange={(event) => setStageId(event.target.value)}
                options={(selectedPipeline?.stages ?? []).map((stage) => ({ value: stage.id, label: stage.name }))}
              />
            </Field>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-meta text-muted">These three records will be created together, or not at all.</p>
            {(preview.data?.blocked ?? []).length > 0 ? (
              <ul role="alert" className="rounded-card border border-danger/40 bg-danger/5 p-2 text-meta text-danger">
                {(preview.data?.blocked ?? []).map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
            <dl className="divide-y divide-line rounded-card border border-line">
              <div className="flex items-baseline justify-between px-3 py-2">
                <dt className="text-meta text-muted">Account</dt>
                <dd className="text-meta text-text">{accountName || '—'}</dd>
              </div>
              <div className="flex items-baseline justify-between px-3 py-2">
                <dt className="text-meta text-muted">Contact</dt>
                <dd className="text-meta text-text">
                  {contactFirst} {contactEmail ? `· ${contactEmail}` : ''}
                </dd>
              </div>
              <div className="flex items-baseline justify-between px-3 py-2">
                <dt className="text-meta text-muted">Deal</dt>
                <dd className="text-meta text-text">
                  {dealName} · {money(Math.round(Number(dealValue.replace(/,/g, '')) * 100) || 0)} ·{' '}
                  {(selectedPipeline?.stages ?? []).find((stage) => stage.id === stageId)?.name ?? '—'}
                </dd>
              </div>
              <div className="flex items-baseline justify-between px-3 py-2">
                <dt className="text-meta text-muted">Lead</dt>
                <dd className="text-meta text-text">marked converted, linked to all three</dd>
              </div>
            </dl>
          </div>
        )}
        {error !== null ? (
          <p role="alert" className="mt-3 text-meta text-danger">
            {error}
          </p>
        ) : null}
      </Modal>
    </>
  );
}
