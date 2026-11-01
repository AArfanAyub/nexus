/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Settings → Data: numbering, taxes, currencies, custom fields, demo data
 * (BR-08, BR-23, US-49, US-50).
 *
 * Numbering shows a live preview built by the main process, so what you see is
 * the exact string the posting engine will allocate. Nothing here can consume a
 * number — allocation only happens inside a posting transaction.
 */

import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Currency, Paged, Sequence } from '@shared/types';

import { PageHeader } from '../../components/PageHeader';
import { Modal } from '../../components/Modal';
import { Button, Card, Chip, Input, Select, Tabs } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import { percent } from '../../lib/format';
import { toast } from '../../lib/toast';
import { invalidate, useQuery } from '../../lib/useQuery';
import { ImportWizard } from './ImportWizard';

type DataTab = 'fields' | 'numbering' | 'taxes' | 'currencies' | 'import';

/**
 * Each tab is its own route, and the route is the only source of truth.
 *
 * Seeding `useState` from the `tab` prop reads the prop **once**, on mount. React
 * keeps the same component instance when only the path changes, so
 * `/settings/taxes` followed by `/settings/currencies` kept rendering the tax
 * panel. A `useEffect` that copies the prop into state fixes the symptom and
 * breaks the back button, because the state then disagrees with the URL for a
 * frame and can win. Deriving the value means there is nothing to disagree.
 */
const DATA_ROUTES: Readonly<Record<DataTab, string>> = {
  numbering: '/settings/numbering',
  taxes: '/settings/taxes',
  currencies: '/settings/currencies',
  fields: '/settings/custom-fields',
  import: '/settings/import',
};

/**
 * The heading names the tab, not the module.
 *
 * Every one of these five routes used to render "Data", so a screenshot could
 * not tell them apart and neither could a route probe. The module name is still
 * on screen — in the subtitle — but the title has to say where you are.
 */
const DATA_LABELS: Readonly<Record<DataTab, string>> = {
  numbering: 'Numbering',
  taxes: 'Tax rates',
  currencies: 'Currencies',
  fields: 'Custom fields',
  import: 'Import',
};

export interface DataProps {
  readonly tab: DataTab;
}

export function Data({ tab }: DataProps): JSX.Element {
  const navigate = useNavigate();
  const active = tab;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={DATA_LABELS[active]}
        subtitle="Numbering, taxes, currencies, custom fields and import"
        toolbar={
          <Tabs
            ariaLabel="Data sections"
            value={active}
            onChange={(next) => navigate(DATA_ROUTES[next])}
            items={[
              { value: 'numbering', label: 'Numbering' },
              { value: 'taxes', label: 'Taxes' },
              { value: 'currencies', label: 'Currencies' },
              { value: 'fields', label: 'Custom fields' },
              { value: 'import', label: 'Import' },
            ]}
          />
        }
      />
      <div className="flex-1 overflow-y-auto p-4">
        {active === 'numbering' ? <NumberingPanel /> : null}
        {active === 'taxes' ? <TaxesPanel /> : null}
        {active === 'currencies' ? <CurrenciesPanel /> : null}
        {active === 'fields' ? <FieldsPanel /> : null}
        {active === 'import' ? <ImportWizard /> : null}
        {active !== 'import' ? <DemoDataPanel /> : null}
      </div>
    </div>
  );
}

// ── numbering ────────────────────────────────────────────────────────────────

const DOC_TYPES = [
  { value: 'invoice', label: 'Sales invoice' },
  { value: 'quote', label: 'Quotation' },
  { value: 'purchase_order', label: 'Purchase order' },
  { value: 'goods_receipt', label: 'Goods receipt' },
  { value: 'journal', label: 'Journal entry' },
  { value: 'payment', label: 'Payment' },
];

function NumberingPanel(): JSX.Element {
  const sequences = useQuery<readonly Sequence[]>(
    'numbering:list',
    () => invoke<readonly Sequence[]>('settings.numbering.list', {}),
    { staleMs: 10_000 },
  );
  const [docType, setDocType] = useState('invoice');
  const [prefix, setPrefix] = useState('INV-');
  const [padding, setPadding] = useState('5');
  const [suffix, setSuffix] = useState('');
  const [busy, setBusy] = useState(false);
  const prefixId = useId();
  const paddingId = useId();
  const suffixId = useId();
  const typeId = useId();

  const preview = useQuery<{ next: string }>(
    `numbering:preview:${docType}`,
    () => invoke<{ next: string }>('settings.numbering.preview', { docType }),
    { staleMs: 5_000 },
  );

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await invoke('settings.numbering.save', {
        docType,
        prefix,
        padding: Number(padding),
        suffix,
      });
      invalidate('numbering');
      sequences.refresh();
      preview.refresh();
      toast.success('Numbering saved', `Next ${docType}: ${preview.data?.next ?? '—'}`);
    } catch (caught) {
      toast.error('Could not save numbering', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  async function reset(): Promise<void> {
    setBusy(true);
    try {
      await invoke('settings.numbering.reset', { docType, reason: 'Reset from Settings → Numbering' });
      invalidate('numbering');
      sequences.refresh();
      preview.refresh();
      toast.success('Sequence reset', 'The reason was written to the audit log.');
    } catch (caught) {
      toast.error('Could not reset', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Numbering"
      description="Numbers are allocated when a document is posted, so a deleted draft never burns one."
      actions={
        <Button variant="primary" onClick={() => void save()} loading={busy}>
          Save pattern
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={typeId} className="text-meta font-medium text-text">Document</label>
          <Select id={typeId} options={DOC_TYPES} value={docType} onChange={(event) => setDocType(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={prefixId} className="text-meta font-medium text-text">Prefix</label>
          <Input id={prefixId} value={prefix} onChange={(event) => setPrefix(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={paddingId} className="text-meta font-medium text-text">Digits</label>
          <Input
            id={paddingId}
            inputMode="numeric"
            value={padding}
            onChange={(event) => setPadding(event.target.value.replace(/[^0-9]/g, ''))}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={suffixId} className="text-meta font-medium text-text">Suffix</label>
          <Input id={suffixId} value={suffix} onChange={(event) => setSuffix(event.target.value)} />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-card border border-line bg-surface-2 px-3 py-2">
        <div>
          <p className="text-meta text-muted">Next number</p>
          <p className="tnum text-body text-text">{preview.data?.next ?? '—'}</p>
        </div>
        <Button variant="ghost" onClick={() => void reset()} loading={busy} iconLeft={<RotateCcw size={14} />}>
          Reset to 1
        </Button>
      </div>

      <table className="mt-4 w-full border-collapse text-body">
        <thead>
          <tr className="bg-surface-2 text-meta text-muted">
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Document</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Pattern</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-right">Next value</th>
          </tr>
        </thead>
        <tbody>
          {(sequences.data ?? []).map((sequence) => (
            <tr key={`${sequence.docType}:${sequence.fiscalYearId}`} className="border-b border-line last:border-0">
              <td className="px-3 py-2 text-text">{sequence.docType}</td>
              <td className="tnum px-3 py-2 text-muted">
                {sequence.prefix}
                {'0'.repeat(sequence.padding)}
                {sequence.suffix}
              </td>
              <td className="tnum px-3 py-2 text-right text-text">{sequence.nextValue}</td>
            </tr>
          ))}
          {(sequences.data ?? []).length === 0 ? (
            <tr>
              <td colSpan={3} className="px-3 py-6 text-center text-meta text-muted">
                No sequences yet — save a pattern to create one.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Card>
  );
}

// ── taxes ────────────────────────────────────────────────────────────────────

function TaxesPanel(): JSX.Element {
  const taxes = useQuery<Paged<Record<string, unknown>>>(
    'taxes:list',
    () => invoke<Paged<Record<string, unknown>>>('entity.list', { entity: 'taxes', limit: 100, sort: { key: 'name', dir: 'asc' } }),
    { staleMs: 30_000 },
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const rateId = useId();
  const [form, setForm] = useState({ name: '', rate: '20' });

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await invoke('entity.save', {
        entity: 'taxes',
        values: {
          name: form.name.trim(),
          rate_bp: Math.round(Number(form.rate) * 100),
          is_inclusive: 0,
          is_compound: 0,
          is_archived: 0,
        },
      });
      invalidate('taxes');
      taxes.refresh();
      setOpen(false);
      setForm({ name: '', rate: '20' });
      toast.success('Tax rate added');
    } catch (caught) {
      toast.error('Could not add the tax rate', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Tax rates"
      description="Rates are stored in basis points, so 20% is exactly 2000."
      actions={
        <Button variant="primary" onClick={() => setOpen(true)} iconLeft={<Plus size={14} />}>
          Add rate
        </Button>
      }
      padded={false}
    >
      <table className="w-full border-collapse text-body">
        <thead>
          <tr className="bg-surface-2 text-meta text-muted">
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Name</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-right">Rate</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Flags</th>
          </tr>
        </thead>
        <tbody>
          {(taxes.data?.rows ?? []).map((row) => (
            <tr key={String(row['id'])} className="border-b border-line last:border-0">
              <td className="px-3 py-2 text-text">{String(row['name'])}</td>
              <td className="tnum px-3 py-2 text-right text-text">{percent(Number(row['rate_bp']))}</td>
              <td className="px-3 py-2">
                {Number(row['is_inclusive']) === 1 ? <Chip>inclusive</Chip> : null}
                {Number(row['is_compound']) === 1 ? <Chip className="ml-1">compound</Chip> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Add a tax rate"
        busy={busy}
        onConfirm={() => void save()}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => void save()} loading={busy}>Add rate</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={nameId} className="text-meta font-medium text-text">Name</label>
            <Input id={nameId} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="VAT 20%" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={rateId} className="text-meta font-medium text-text">Rate %</label>
            <Input id={rateId} inputMode="decimal" value={form.rate} onChange={(event) => setForm({ ...form, rate: event.target.value })} />
          </div>
        </div>
      </Modal>
    </Card>
  );
}

// ── currencies ───────────────────────────────────────────────────────────────

function CurrenciesPanel(): JSX.Element {
  const currencies = useQuery<readonly Currency[]>(
    'currencies:list',
    () =>
      invoke<Paged<Record<string, unknown>>>('entity.list', { entity: 'currencies', limit: 100, sort: { key: 'code', dir: 'asc' } }).then(
        (page) => page.rows as unknown as readonly Currency[],
      ),
    { staleMs: 30_000 },
  );
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', symbol: '', decimals: '2', rate: '10000' });
  const codeId = useId();
  const nameId = useId();
  const symbolId = useId();
  const decimalsId = useId();
  const rateId = useId();

  /**
   * Adds a currency by its ISO code.
   *
   * The code is the primary key, not an `id`, which is why this was impossible
   * before: the generic save path hardcoded `id` and the table has no such
   * column. It now reads the real key from the table, so the values carry the
   * identity and a duplicate code updates rather than crashing.
   */
  async function addCurrency(): Promise<void> {
    const code = form.code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      toast.error('Could not add the currency', 'A currency code is three letters, like SGD.');
      return;
    }
    setBusy(true);
    try {
      await invoke('entity.save', {
        entity: 'currencies',
        values: {
          code,
          name: form.name.trim() === '' ? code : form.name.trim(),
          symbol: form.symbol.trim() === '' ? code : form.symbol.trim(),
          decimals: Number(form.decimals),
          rate_bp: Math.round(Number(form.rate)),
          is_base: 0,
        },
      });
      invalidate('currencies');
      currencies.refresh();
      setOpen(false);
      setForm({ code: '', name: '', symbol: '', decimals: '2', rate: '10000' });
      toast.success(`${code} added`);
    } catch (caught) {
      toast.error('Could not add the currency', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  async function makeBase(code: string): Promise<void> {
    setBusy(true);
    try {
      const result = await invoke<{ refused?: string }>('settings.currency.setBase', { code });
      if (result.refused) {
        toast.error('Base currency unchanged', result.refused);
        return;
      }
      invalidate('currencies');
      currencies.refresh();
      toast.success(`${code} is now the base currency`);
    } catch (caught) {
      toast.error('Could not change the base currency', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Currencies"
      description="The base currency can only change before the first journal entry is posted (BR-23)."
      actions={
        <Button variant="primary" onClick={() => setOpen(true)} iconLeft={<Plus size={14} />}>
          Add currency
        </Button>
      }
      padded={false}
    >
      <table className="w-full border-collapse text-body">
        <thead>
          <tr className="bg-surface-2 text-meta text-muted">
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Code</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Name</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-right">Rate (bp)</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-right">Base</th>
          </tr>
        </thead>
        <tbody>
          {(currencies.data ?? []).map((currency) => (
            <tr key={currency.code} className="border-b border-line last:border-0">
              <td className="px-3 py-2 text-text">{currency.code}</td>
              <td className="px-3 py-2 text-text">{currency.name}</td>
              <td className="tnum px-3 py-2 text-right text-muted">{currency.rateBp}</td>
              <td className="px-3 py-2 text-right">
                {currency.isBase ? (
                  <Chip tone="accent">base</Chip>
                ) : (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void makeBase(currency.code)}>
                    Make base
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Add a currency"
        busy={busy}
        onConfirm={() => void addCurrency()}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => void addCurrency()} loading={busy}>Add currency</Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={codeId} className="text-meta font-medium text-text">Code</label>
            <Input
              id={codeId}
              value={form.code}
              maxLength={3}
              placeholder="SGD"
              onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={symbolId} className="text-meta font-medium text-text">Symbol</label>
            <Input
              id={symbolId}
              value={form.symbol}
              placeholder="S$"
              onChange={(event) => setForm({ ...form, symbol: event.target.value })}
            />
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <label htmlFor={nameId} className="text-meta font-medium text-text">Name</label>
            <Input
              id={nameId}
              value={form.name}
              placeholder="Singapore dollar"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={decimalsId} className="text-meta font-medium text-text">Decimals</label>
            <Input
              id={decimalsId}
              inputMode="numeric"
              value={form.decimals}
              onChange={(event) => setForm({ ...form, decimals: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={rateId} className="text-meta font-medium text-text">Rate (bp)</label>
            <Input
              id={rateId}
              inputMode="numeric"
              value={form.rate}
              onChange={(event) => setForm({ ...form, rate: event.target.value })}
            />
          </div>
        </div>
      </Modal>
    </Card>
  );
}

// ── custom fields ────────────────────────────────────────────────────────────

const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'money', label: 'Money (cents)' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Select' },
  { value: 'bool', label: 'Yes / no' },
];

const FIELD_ENTITIES = [
  { value: 'customers', label: 'Customers' },
  { value: 'vendors', label: 'Vendors' },
  { value: 'products', label: 'Products' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'deals', label: 'Deals' },
  { value: 'salesOrders', label: 'Sales orders' },
];

function FieldsPanel(): JSX.Element {
  const fields = useQuery<Paged<Record<string, unknown>>>(
    'customFields:list',
    () => invoke<Paged<Record<string, unknown>>>('entity.list', { entity: 'customFields', limit: 200 }),
    { staleMs: 30_000 },
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ entity: 'customers', key: '', label: '', type: 'text', required: true });
  const entityId = useId();
  const keyId = useId();
  const labelId = useId();
  const typeId = useId();

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await invoke('entity.save', {
        entity: 'customFields',
        values: {
          entity: form.entity,
          key: form.key.trim(),
          label: form.label.trim(),
          type: form.type,
          is_required: form.required ? 1 : 0,
          is_active: 1,
        },
      });
      invalidate('customFields');
      fields.refresh();
      setOpen(false);
      setForm({ entity: 'customers', key: '', label: '', type: 'text', required: true });
      toast.success('Custom field added', 'It appears on the matching form immediately.');
    } catch (caught) {
      toast.error('Could not add the field', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  async function archive(id: string): Promise<void> {
    try {
      await invoke('entity.archive', { entity: 'customFields', id });
      invalidate('customFields');
      fields.refresh();
      // Archiving is a flag, so the undo is a real restore rather than a lie
      // that hides the row until the next refresh.
      toast.undoable('Field archived', 'It no longer appears on any form.', {
        label: 'Undo',
        run: async () => {
          await invoke('entity.restore', { entity: 'customFields', id });
          invalidate('customFields');
          fields.refresh();
        },
      });
    } catch (caught) {
      toast.error('Could not archive', isApiError(caught) ? caught.message : 'Nothing was changed.');
    }
  }

  return (
    <Card
      title="Custom fields"
      description="Extra columns per record type. Required fields block a save until they are filled (US-49)."
      actions={
        <Button variant="primary" onClick={() => setOpen(true)} iconLeft={<Plus size={14} />}>
          Add field
        </Button>
      }
      padded={false}
    >
      <table className="w-full border-collapse text-body">
        <thead>
          <tr className="bg-surface-2 text-meta text-muted">
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Record</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Key</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Label</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Type</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Required</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {(fields.data?.rows ?? []).map((row) => (
            <tr key={String(row['id'])} className="border-b border-line last:border-0">
              <td className="px-3 py-2 text-text">{String(row['entity'])}</td>
              <td className="tnum px-3 py-2 text-text">{String(row['key'])}</td>
              <td className="px-3 py-2 text-text">{String(row['label'])}</td>
              <td className="px-3 py-2 text-muted">{String(row['type'])}</td>
              <td className="px-3 py-2">{Number(row['is_required']) === 1 ? <Chip tone="warning">required</Chip> : '—'}</td>
              <td className="px-3 py-2 text-right">
                <Button size="sm" variant="ghost" onClick={() => void archive(String(row['id']))} iconLeft={<Trash2 size={12} />}>
                  Archive
                </Button>
              </td>
            </tr>
          ))}
          {(fields.data?.rows ?? []).length === 0 ? (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-meta text-muted">
                No custom fields yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Add a custom field"
        description="Keys are permanent: they are stored on every record that uses them."
        busy={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => void save()} loading={busy}>Add field</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={entityId} className="text-meta font-medium text-text">Record type</label>
            <Select id={entityId} options={FIELD_ENTITIES} value={form.entity} onChange={(event) => setForm({ ...form, entity: event.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={keyId} className="text-meta font-medium text-text">Key</label>
            <Input id={keyId} value={form.key} onChange={(event) => setForm({ ...form, key: event.target.value })} placeholder="GSTIN" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={labelId} className="text-meta font-medium text-text">Label</label>
            <Input id={labelId} value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="GSTIN" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={typeId} className="text-meta font-medium text-text">Type</label>
            <Select id={typeId} options={FIELD_TYPES} value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-body text-text">
            <input
              type="checkbox"
              checked={form.required}
              onChange={(event) => setForm({ ...form, required: event.target.checked })}
              className="h-4 w-4 accent-[var(--accent)]"
            />
            Required — blocks save when empty
          </label>
        </div>
      </Modal>
    </Card>
  );
}

// ── demo data ────────────────────────────────────────────────────────────────

function DemoDataPanel(): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function run(action: 'seed' | 'remove'): Promise<void> {
    setBusy(true);
    try {
      const result = await invoke<{ created?: number; removed?: number }>(
        action === 'seed' ? 'settings.demoData.seed' : 'settings.demoData.remove',
        {},
      );
      invalidate('');
      toast.success(
        action === 'seed' ? 'Demo data loaded' : 'Demo data removed',
        action === 'seed'
          ? `${String(result.created ?? 0)} records created.`
          : `${String(result.removed ?? 0)} records removed. Your own records were left alone.`,
      );
    } catch (caught) {
      toast.error('Could not change the demo data', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      className="mt-4"
      title="Demo data"
      description="Seeded rows are tagged, so removing them never touches records you created."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void run('seed')} loading={busy} disabled={busy}>
          Load demo data
        </Button>
        <Button variant="danger" onClick={() => void run('remove')} loading={busy} disabled={busy}>
          Remove demo data
        </Button>
      </div>
    </Card>
  );
}

