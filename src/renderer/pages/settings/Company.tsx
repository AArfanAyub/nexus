/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Settings → Company. Identity, logo, address, document terms.
 *
 * The logo is read with `FileReader` and sent as a data URL; the main process
 * re-checks the size and MIME type, because a client-side limit is a hint and not
 * a control.
 */

import { ImagePlus, Save } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type { BootstrapResult } from '@shared/types';

import { Field, FormGrid } from '../../components/Field';
import { PageHeader } from '../../components/PageHeader';
import { Button, Card, Chip, Input } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import { toast } from '../../lib/toast';
import { useSession } from '../../store';

const MAX_LOGO_BYTES = 256 * 1024;

export function Company(): JSX.Element {
  // The company profile arrives with `app.bootstrap`; there is no read channel for
  // it, because the shell must know the company name before it renders anything.
  const data = useSession((state) => state.company);
  const refresh = useCallback(() => {
    void invoke<BootstrapResult>('app.bootstrap', {}).then((boot) => {
      useSession.getState().applyBootstrap(boot);
    });
  }, []);

  const nameId = useId();
  const legalId = useId();
  const taxId = useId();
  const line1Id = useId();
  const cityId = useId();
  const regionId = useId();
  const postcodeId = useId();
  const countryId = useId();

  const [form, setForm] = useState({
    name: '',
    legalName: '',
    taxId: '',
    line1: '',
    city: '',
    region: '',
    postcode: '',
    country: '',
  });
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!data) return;
    setForm({
      name: data.name,
      legalName: data.legalName ?? '',
      taxId: data.taxId ?? '',
      line1: data.address?.line1 ?? '',
      city: data.address?.city ?? '',
      region: data.address?.region ?? '',
      postcode: data.address?.postcode ?? '',
      country: data.address?.country ?? '',
    });
    setDirty(false);
  }, [data]);

  function update(key: keyof typeof form, value: string): void {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await invoke('settings.company.save', {
        name: form.name.trim(),
        legalName: form.legalName.trim() || null,
        taxId: form.taxId.trim() || null,
        address: {
          line1: form.line1.trim() || undefined,
          city: form.city.trim() || undefined,
          region: form.region.trim() || undefined,
          postcode: form.postcode.trim() || undefined,
          country: form.country.trim() || undefined,
        },
      });
      setDirty(false);
      toast.success('Company details saved');
      refresh();
    } catch (caught) {
      toast.error('Could not save', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  async function uploadLogo(file: File): Promise<void> {
    if (file.size > MAX_LOGO_BYTES) {
      toast.error('That image is too large', 'The logo must be 256 kB or smaller.');
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(file);
    }).catch(() => null);

    if (!dataUrl) {
      toast.error('Could not read that file');
      return;
    }
    try {
      await invoke('settings.company.logo', { dataUrl });
      toast.success('Logo updated');
      refresh();
    } catch (caught) {
      toast.error('Logo not saved', isApiError(caught) ? caught.message : 'Try a PNG or JPEG.');
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Company"
        subtitle="Appears on every document you print"
        primaryAction={
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!dirty} iconLeft={<Save size={14} />}>
            Save
          </Button>
        }
        secondaryActions={dirty ? <Chip tone="warning">Unsaved changes</Chip> : null}
      />
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <Card title="Identity">
            <FormGrid columns={2}>
              <Field label="Company name" required htmlFor={nameId}>
                <Input id={nameId} value={form.name} onChange={(event) => update('name', event.target.value)} />
              </Field>
              <Field label="Legal name" htmlFor={legalId}>
                <Input id={legalId} value={form.legalName} onChange={(event) => update('legalName', event.target.value)} />
              </Field>
              <Field label="Tax id" htmlFor={taxId}>
                <Input id={taxId} value={form.taxId} onChange={(event) => update('taxId', event.target.value)} />
              </Field>
            </FormGrid>

            <h3 className="mt-5 text-meta font-medium text-text">Address</h3>
            <FormGrid columns={2} className="mt-2">
              <Field label="Street" htmlFor={line1Id}>
                <Input id={line1Id} value={form.line1} onChange={(event) => update('line1', event.target.value)} />
              </Field>
              <Field label="City" htmlFor={cityId}>
                <Input id={cityId} value={form.city} onChange={(event) => update('city', event.target.value)} />
              </Field>
              <Field label="Region" htmlFor={regionId}>
                <Input id={regionId} value={form.region} onChange={(event) => update('region', event.target.value)} />
              </Field>
              <Field label="Postcode" htmlFor={postcodeId}>
                <Input id={postcodeId} value={form.postcode} onChange={(event) => update('postcode', event.target.value)} />
              </Field>
              <Field label="Country" htmlFor={countryId}>
                <Input id={countryId} value={form.country} onChange={(event) => update('country', event.target.value)} />
              </Field>
            </FormGrid>
          </Card>

          <Card title="Logo" description="PNG, JPEG, WebP or SVG · 256 kB max">
            <div className="flex flex-col items-center gap-3">
              {data?.logoPath ? (
                <div className="flex h-24 w-full items-center justify-center rounded-card border border-line bg-surface-2 p-2">
                  <span className="truncate text-meta text-muted">{data.logoPath.split(/[\\/]/).pop()}</span>
                </div>
              ) : (
                <div className="flex h-24 w-full items-center justify-center rounded-card border border-dashed border-line-strong text-meta text-muted">
                  No logo yet
                </div>
              )}
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadLogo(file);
                  event.target.value = '';
                }}
              />
              <Button onClick={() => fileInput.current?.click()} iconLeft={<ImagePlus size={14} />}>
                Choose file
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

