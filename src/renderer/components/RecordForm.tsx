/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * `RecordFormModal` — one create/edit dialog for every master record.
 *
 * The gap this closes: nine list screens had no way to add a row, because each
 * would have needed its own form. They all need the *same* form, driven by a
 * field spec, saving through the generic `entity.save` channel — which already
 * validates columns against the schema, enforces the write permission and writes
 * an audit row. A bespoke form per screen would be nine places for the rules to
 * drift and nine places to fix the same bug.
 *
 * Money is entered in the display currency and converted to cents on save;
 * quantities are entered in whole units and stored in milli. Both conversions
 * live here so no screen can get them wrong.
 */

import { useEffect, useMemo, useState } from 'react';

import type { EntityName } from '@shared/types';

import { Modal } from './Modal';
import { Field } from './Field';
import { Checkbox, Input, Select, Textarea } from './ui';
import { invoke } from '../lib/api';
import { invalidate } from '../lib/useQuery';
import { toast } from '../lib/toast';

export type FieldKind = 'text' | 'textarea' | 'money' | 'number' | 'quantity' | 'date' | 'select' | 'checkbox' | 'readonly';

export interface RecordField {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly required?: boolean;
  readonly help?: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly placeholder?: string;
  readonly span?: 1 | 2;
}

export interface RecordFormProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly entity: EntityName;
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly RecordField[];
  /**
   * Present when editing. Typed as `object` rather than `Record<string,
   * unknown>` so a caller can pass its own row interface without a cast — the
   * form only ever reads it by key.
   */
  readonly initial?: object | null;
  /** Extra keys written on create only, e.g. `{ warehouse_id: id }`. */
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly onSaved?: (row: Readonly<Record<string, unknown>>) => void;
  readonly invalidatePrefixes?: readonly string[];
}

function toInputValue(kind: FieldKind, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (kind === 'money') return (Number(value) / 100).toFixed(2);
  if (kind === 'quantity') return String(Number(value) / 1000);
  if (kind === 'checkbox') return value === true || value === 1 ? 'true' : 'false';
  if (kind === 'date') return String(value).slice(0, 10);
  return String(value);
}

function fromInputValue(kind: FieldKind, raw: string): unknown {
  if (kind === 'money') {
    const number = Number(raw.replace(/,/g, ''));
    return Number.isFinite(number) ? Math.round(number * 100) : 0;
  }
  if (kind === 'quantity') {
    const number = Number(raw.replace(/,/g, ''));
    return Number.isFinite(number) ? Math.round(number * 1000) : 0;
  }
  if (kind === 'number') {
    const number = Number(raw.replace(/,/g, ''));
    return Number.isFinite(number) ? number : 0;
  }
  if (kind === 'checkbox') return raw === 'true' ? 1 : 0;
  return raw.trim() === '' ? null : raw.trim();
}

export function RecordFormModal({
  open,
  onOpenChange,
  entity,
  title,
  description,
  fields,
  initial,
  defaults,
  onSaved,
  invalidatePrefixes,
}: RecordFormProps): JSX.Element {
  const record = (initial ?? {}) as Record<string, unknown>;
  const editing = Boolean(record['id']);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seed = useMemo(() => {
    const out: Record<string, string> = {};
    for (const field of fields) {
      const fromInitial = record[field.key];
      const fromDefault = defaults?.[field.key];
      out[field.key] = toInputValue(field.kind, fromInitial ?? fromDefault ?? null);
    }
    return out;
  }, [fields, record, defaults]);

  useEffect(() => {
    if (!open) return;
    setValues(seed);
    setError(null);
  }, [open, seed]);

  async function save(): Promise<void> {
    const missing = fields.filter(
      (field) => field.required === true && (values[field.key] ?? '').trim() === '',
    );
    if (missing.length > 0) {
      setError(`${missing.map((field) => field.label).join(', ')} ${missing.length === 1 ? 'is' : 'are'} required.`);
      return;
    }

    const payload: Record<string, unknown> = { ...(defaults ?? {}) };
    for (const field of fields) {
      if (field.kind === 'readonly') continue;
      payload[field.key] = fromInputValue(field.kind, values[field.key] ?? '');
    }

    setBusy(true);
    setError(null);
    try {
      const saved = await invoke<Record<string, unknown>>('entity.save', {
        entity,
        id: editing ? record['id'] : undefined,
        values: payload,
      });
      for (const prefix of invalidatePrefixes ?? []) invalidate(prefix);
      invalidate('ops:');
      toast.success(editing ? `${title} updated` : `${title} created`);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${title.toLowerCase()}` : `New ${title.toLowerCase()}`}
      description={description}
      size="lg"
      busy={busy}
      onConfirm={() => void save()}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-control px-3 py-1.5 text-meta text-muted hover:bg-elevated"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-control bg-accent px-3 py-1.5 text-meta font-medium text-inverse disabled:opacity-50"
            onClick={() => void save()}
            disabled={busy}
          >
            {busy ? 'Saving…' : editing ? 'Save changes' : `Create ${title.toLowerCase()}`}
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        {fields.map((field) => {
          const value = values[field.key] ?? '';
          const set = (next: string): void => setValues((current) => ({ ...current, [field.key]: next }));
          const wide = field.span === 2 || field.kind === 'textarea';
          const id = `${entity}-${field.key}`;
          return (
            <div key={field.key} className={wide ? 'col-span-2' : 'col-span-1'}>
              <Field label={field.label} required={field.required} hint={field.help} htmlFor={id}>
                {field.kind === 'select' ? (
                  <Select
                    id={id}
                    value={value}
                    onChange={(event) => set(event.target.value)}
                    options={[{ value: '', label: '—' }, ...(field.options ?? [])]}
                  />
                ) : field.kind === 'textarea' ? (
                  <Textarea
                    id={id}
                    rows={3}
                    value={value}
                    placeholder={field.placeholder}
                    onChange={(event) => set(event.target.value)}
                  />
                ) : field.kind === 'checkbox' ? (
                  <Checkbox
                    checked={value === 'true'}
                    onChange={(event) => set(event.target.checked ? 'true' : 'false')}
                    label={field.help ?? ''}
                  />
                ) : field.kind === 'readonly' ? (
                  <div className="text-meta text-muted">{value || '—'}</div>
                ) : (
                  <Input
                    id={id}
                    type={field.kind === 'date' ? 'date' : 'text'}
                    inputMode={field.kind === 'money' || field.kind === 'number' || field.kind === 'quantity' ? 'decimal' : undefined}
                    value={value}
                    placeholder={field.placeholder}
                    onChange={(event) => set(event.target.value)}
                  />
                )}
              </Field>
            </div>
          );
        })}
      </div>
      {error !== null ? (
        <p role="alert" className="mt-3 text-meta text-danger">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
