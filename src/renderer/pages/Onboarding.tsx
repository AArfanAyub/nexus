/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * `/onboarding` — the five-step wizard (US-01…US-04, T04 acceptance #1–#5).
 *
 * Shape of the flow:
 *   1. company identity   2. industry preset (preview only — writes nothing)
 *   3. currency + fiscal year   4. administrator   5. licence (skippable)
 *
 * Nothing is written until the final **Complete setup** press, which is one
 * `onboarding.complete` call. If the licence step is skipped the company lands on
 * Community with a notice that stays dismissed (US-04, BR-25).
 */

import { Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { INDUSTRY_PRESETS } from '@shared/industry-presets';
import type { PresetPreview } from '@shared/industry-presets';
import { MODULES } from '@shared/modules';
import type { BootstrapResult } from '@shared/types';

import { Field, FormGrid } from '../components/Field';
import { currencyOptions } from '@shared/currencies';
import { Button, Card, Chip, Input, Select } from '../components/ui';
import { invoke, isApiError } from '../lib/api';
import { toast } from '../lib/toast';
import { clearQueryCache } from '../lib/useQuery';
import { useSession, useUi } from '../store';

const STEPS = ['Company', 'Industry', 'Books', 'Administrator', 'Licence'] as const;

const CURRENCIES = currencyOptions();

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
].map((label, index) => ({ value: String(index + 1), label }));

interface Draft {
  companyName: string;
  legalName: string;
  taxId: string;
  city: string;
  country: string;
  presetId: string;
  currency: string;
  fiscalStartMonth: string;
  adminUsername: string;
  adminFullName: string;
  adminEmail: string;
  adminPassword: string;
  adminConfirm: string;
  licenseKey: string;
  loadDemo: boolean;
}

const INITIAL: Draft = {
  companyName: '',
  legalName: '',
  taxId: '',
  city: '',
  country: '',
  presetId: 'wholesale_retail',
  currency: 'MYR',
  fiscalStartMonth: '1',
  adminUsername: '',
  adminFullName: '',
  adminEmail: '',
  adminPassword: '',
  adminConfirm: '',
  licenseKey: '',
  loadDemo: true,
};

export function Onboarding(): JSX.Element {
  const navigate = useNavigate();
  const applyBootstrap = useSession((state) => state.applyBootstrap);
  const hydrateUi = useUi((state) => state.hydrate);

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(INITIAL);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const [preview, setPreview] = useState<PresetPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);

  const preset = useMemo(
    () => INDUSTRY_PRESETS.find((candidate) => candidate.id === draft.presetId) ?? INDUSTRY_PRESETS[0],
    [draft.presetId],
  );

  // Step 2's preview is fetched from the main process, so the wizard shows exactly
  // what the preset will write — and still writes nothing.
  useEffect(() => {
    if (step !== 1) return;
    let cancelled = false;
    setPreviewBusy(true);
    invoke<PresetPreview>('onboarding.preview', { presetId: draft.presetId })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setPreviewBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, draft.presetId]);

  function update<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  function validateStep(index: number): boolean {
    const next: Partial<Record<keyof Draft, string>> = {};

    if (index === 0) {
      if (draft.companyName.trim().length < 2) next.companyName = 'Enter your company name.';
    }
    if (index === 3) {
      if (!/^[a-zA-Z0-9._-]{3,64}$/.test(draft.adminUsername)) {
        next.adminUsername = '3–64 characters: letters, numbers, dot, dash or underscore.';
      }
      if (draft.adminFullName.trim().length < 2) next.adminFullName = 'Enter the administrator’s name.';
      if (draft.adminPassword.length < 8) next.adminPassword = 'Use at least 8 characters.';
      if (draft.adminPassword !== draft.adminConfirm) next.adminConfirm = 'The two passwords do not match.';
      if (draft.adminPassword.toLowerCase().includes(draft.adminUsername.toLowerCase())) {
        next.adminPassword = 'The password must not contain the username.';
      }
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function goNext(): void {
    if (!validateStep(step)) return;
    setStep((current) => Math.min(STEPS.length - 1, current + 1));
  }

  function goBack(): void {
    setStep((current) => Math.max(0, current - 1));
  }

  async function complete(): Promise<void> {
    if (!validateStep(3)) {
      setStep(3);
      return;
    }
    setBusy(true);
    try {
      await invoke('onboarding.complete', {
        company: {
          name: draft.companyName.trim(),
          legalName: draft.legalName.trim() || undefined,
          taxId: draft.taxId.trim() || undefined,
          address:
            draft.city.trim() || draft.country.trim()
              ? { city: draft.city.trim() || undefined, country: draft.country.trim() || undefined }
              : undefined,
        },
        presetId: draft.presetId,
        currency: draft.currency,
        fiscalStartMonth: Number(draft.fiscalStartMonth),
        admin: {
          username: draft.adminUsername.trim(),
          fullName: draft.adminFullName.trim(),
          email: draft.adminEmail.trim() || undefined,
          password: draft.adminPassword,
        },
        licenseKey: draft.licenseKey.trim() || undefined,
        loadDemo: draft.loadDemo,
      });

      // Sign in as the new owner so the wizard lands on a working shell.
      await invoke('auth.login', { username: draft.adminUsername.trim(), password: draft.adminPassword });
      clearQueryCache();

      const boot = await invoke<BootstrapResult>('app.bootstrap', {});
      applyBootstrap(boot);
      hydrateUi(boot.prefs);

      if (!draft.licenseKey.trim()) {
        toast.info('Running on the Community edition', 'Activate a key any time in Settings → Licence.');
      }

      // The manifest owns the landing route — never build it from the module id,
      // because `inventory` lives at `/inventory/products`, not `/inventory`.
      const landingId = preset?.landingModule ?? 'dashboard';
      const landingRoute = MODULES.find((module) => module.id === landingId)?.route ?? '/dashboard';
      navigate(landingRoute, { replace: true });
    } catch (caught) {
      toast.error(
        'Setup could not be completed',
        isApiError(caught) ? caught.message : 'Nothing was written. Check the details and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg">
      <header className="border-b border-line bg-surface px-6 py-4">
        <h1 className="text-body font-semibold text-text">Set up NEXUS</h1>
        <p className="mt-0.5 text-meta text-muted">
          Five short steps. Nothing is written until you press Complete setup.
        </p>
        <ol className="mt-3 flex flex-wrap items-center gap-2" aria-label="Setup progress">
          {STEPS.map((label, index) => {
            const state = index === step ? 'current' : index < step ? 'done' : 'todo';
            return (
              <li key={label} className="flex items-center gap-2">
                <span
                  aria-current={state === 'current' ? 'step' : undefined}
                  className={
                    state === 'done'
                      ? 'flex h-5 w-5 items-center justify-center rounded-chip bg-success text-inverse'
                      : state === 'current'
                        ? 'flex h-5 w-5 items-center justify-center rounded-chip bg-accent text-inverse'
                        : 'flex h-5 w-5 items-center justify-center rounded-chip bg-surface-3 text-muted'
                  }
                >
                  {state === 'done' ? <Check size={12} aria-hidden="true" /> : index + 1}
                </span>
                <span className={state === 'todo' ? 'text-meta text-muted' : 'text-meta text-text'}>{label}</span>
                {index < STEPS.length - 1 ? <span className="text-muted">—</span> : null}
              </li>
            );
          })}
        </ol>
      </header>

      <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-6">
        {step === 0 ? <StepCompany draft={draft} errors={errors} update={update} /> : null}
        {step === 1 ? (
          <StepIndustry
            draft={draft}
            update={update}
            preview={preview}
            busy={previewBusy}
            landing={preset?.landingModule ?? 'dashboard'}
          />
        ) : null}
        {step === 2 ? <StepBooks draft={draft} update={update} /> : null}
        {step === 3 ? <StepAdmin draft={draft} errors={errors} update={update} /> : null}
        {step === 4 ? <StepLicence draft={draft} update={update} /> : null}
      </div>

      <footer className="sticky bottom-0 flex items-center justify-between border-t border-line bg-surface px-6 py-3">
        <Button variant="ghost" onClick={goBack} disabled={step === 0 || busy} iconLeft={<ChevronLeft size={14} />}>
          Back
        </Button>
        <div className="flex items-center gap-2">
          {step === 4 ? (
            <Button variant="ghost" onClick={() => void complete()} disabled={busy}>
              Skip licence
            </Button>
          ) : null}
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={goNext} iconRight={<ChevronRight size={14} />}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void complete()} loading={busy}>
              {busy ? 'Setting up…' : 'Complete setup'}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

// ── steps ────────────────────────────────────────────────────────────────────

interface StepProps {
  readonly draft: Draft;
  readonly update: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  readonly errors?: Partial<Record<keyof Draft, string>>;
}

function StepCompany({ draft, update, errors = {} }: StepProps): JSX.Element {
  const nameId = useId();
  const legalId = useId();
  const taxId = useId();
  const cityId = useId();
  const countryId = useId();

  return (
    <Card title="Your company" description="This appears on every document you print.">
      <FormGrid columns={2}>
        <Field label="Company name" required htmlFor={nameId} error={errors.companyName}>
          <Input
            id={nameId}
            autoFocus
            value={draft.companyName}
            invalid={Boolean(errors.companyName)}
            onChange={(event) => update('companyName', event.target.value)}
          />
        </Field>
        <Field label="Legal name" htmlFor={legalId} hint="Optional — used on tax documents.">
          <Input id={legalId} value={draft.legalName} onChange={(event) => update('legalName', event.target.value)} />
        </Field>
        <Field label="Tax id" htmlFor={taxId} hint="VAT, GST or EIN.">
          <Input id={taxId} value={draft.taxId} onChange={(event) => update('taxId', event.target.value)} />
        </Field>
        <Field label="City" htmlFor={cityId}>
          <Input id={cityId} value={draft.city} onChange={(event) => update('city', event.target.value)} />
        </Field>
        <Field label="Country" htmlFor={countryId}>
          <Input id={countryId} value={draft.country} onChange={(event) => update('country', event.target.value)} />
        </Field>
      </FormGrid>
    </Card>
  );
}

interface StepIndustryProps extends StepProps {
  readonly preview: PresetPreview | null;
  readonly busy: boolean;
  readonly landing: string;
}

function StepIndustry({ draft, update, preview, busy, landing }: StepIndustryProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <Card title="Pick your industry" description="This shapes the chart of accounts, taxes and fields. Nothing is written yet.">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {INDUSTRY_PRESETS.map((option) => {
            const selected = option.id === draft.presetId;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                onClick={() => update('presetId', option.id)}
                className={
                  selected
                    ? 'rounded-card border border-accent bg-accent-soft p-3 text-left'
                    : 'rounded-card border border-line bg-surface p-3 text-left hover:bg-surface-2'
                }
              >
                <p className="text-body font-medium text-text">{option.label}</p>
                <p className="mt-0.5 text-meta text-muted">{option.description}</p>
              </button>
            );
          })}
        </div>
      </Card>

      <Card
        title="What this will create"
        description={`Landing page after setup: ${landing}`}
        actions={busy ? <Loader2 size={14} className="animate-spin text-muted" aria-label="Loading preview" /> : null}
      >
        {preview ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              {preview.modules.map((module) => (
                <Chip key={module} tone="accent">
                  {module}
                </Chip>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <p className="text-meta text-muted">Chart of accounts · {preview.coa.count} accounts</p>
                <ul className="mt-1 flex flex-col gap-0.5 text-meta text-text">
                  {preview.coa.sample.map((account) => (
                    <li key={account.code} className="tnum">
                      {account.code} · {account.name}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-meta text-muted">Taxes</p>
                <ul className="mt-1 flex flex-col gap-0.5 text-meta text-text">
                  {preview.taxes.map((tax) => (
                    <li key={tax.name}>
                      {tax.name} · {(tax.rateBp / 100).toFixed(2)}%
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-meta text-muted">Numbering</p>
                <p className="mt-1 text-meta text-text">
                  {preview.numbering.map((entry) => `${entry.prefix}${'0'.repeat(entry.padding)}`).join(' · ')}
                </p>
              </div>
            </div>
            {preview.customFields.length > 0 ? (
              <div>
                <p className="text-meta text-muted">Custom fields</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {preview.customFields.map((field) => (
                    <Chip key={`${field.entity}.${field.key}`}>
                      {field.entity}.{field.key}
                      {field.isRequired ? ' *' : ''}
                    </Chip>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-meta text-muted">{busy ? 'Loading preview…' : 'Preview unavailable.'}</p>
        )}
      </Card>
    </div>
  );
}

function StepBooks({ draft, update }: StepProps): JSX.Element {
  const currencyId = useId();
  const monthId = useId();
  return (
    <Card title="Books and year" description="Both can be changed later — the currency only until the first entry is posted.">
      <FormGrid columns={2}>
        <Field label="Base currency" required htmlFor={currencyId} hint="Every amount is stored in this currency.">
          <Select
            id={currencyId}
            options={CURRENCIES}
            value={draft.currency}
            onChange={(event) => update('currency', event.target.value)}
          />
        </Field>
        <Field label="Fiscal year starts" required htmlFor={monthId} hint="Twelve monthly periods are created.">
          <Select
            id={monthId}
            options={MONTHS}
            value={draft.fiscalStartMonth}
            onChange={(event) => update('fiscalStartMonth', event.target.value)}
          />
        </Field>
      </FormGrid>

      <label className="mt-4 flex items-start gap-2 text-body text-text">
        <input
          type="checkbox"
          checked={draft.loadDemo}
          onChange={(event) => update('loadDemo', event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
        />
        <span>
          Load demo data
          <span className="block text-meta text-muted">
            Three customers, three vendors, eight products, six invoices, five deals and a warehouse — so the
            dashboard is not empty. Removable in one click later.
          </span>
        </span>
      </label>
    </Card>
  );
}

function StepAdmin({ draft, update, errors = {} }: StepProps): JSX.Element {
  const usernameId = useId();
  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const confirmId = useId();

  return (
    <Card title="Administrator account" description="The first account is the owner: full access, and it cannot be deleted.">
      <FormGrid columns={2}>
        <Field label="Username" required htmlFor={usernameId} error={errors.adminUsername}>
          <Input
            id={usernameId}
            autoComplete="username"
            value={draft.adminUsername}
            invalid={Boolean(errors.adminUsername)}
            onChange={(event) => update('adminUsername', event.target.value)}
          />
        </Field>
        <Field label="Full name" required htmlFor={nameId} error={errors.adminFullName}>
          <Input
            id={nameId}
            value={draft.adminFullName}
            invalid={Boolean(errors.adminFullName)}
            onChange={(event) => update('adminFullName', event.target.value)}
          />
        </Field>
        <Field label="Email" htmlFor={emailId} hint="Optional.">
          <Input id={emailId} type="email" value={draft.adminEmail} onChange={(event) => update('adminEmail', event.target.value)} />
        </Field>
        <Field label="Password" required htmlFor={passwordId} error={errors.adminPassword} hint="At least 8 characters, with a symbol.">
          <Input
            id={passwordId}
            type="password"
            autoComplete="new-password"
            value={draft.adminPassword}
            invalid={Boolean(errors.adminPassword)}
            onChange={(event) => update('adminPassword', event.target.value)}
          />
        </Field>
        <Field label="Confirm password" required htmlFor={confirmId} error={errors.adminConfirm}>
          <Input
            id={confirmId}
            type="password"
            autoComplete="new-password"
            value={draft.adminConfirm}
            invalid={Boolean(errors.adminConfirm)}
            onChange={(event) => update('adminConfirm', event.target.value)}
          />
        </Field>
      </FormGrid>
    </Card>
  );
}

function StepLicence({ draft, update }: StepProps): JSX.Element {
  const keyId = useId();
  return (
    <Card
      title="Licence (optional)"
      description="Without a key NEXUS runs on the Community edition — everything works, with a single-company limit."
    >
      <Field label="Licence key" htmlFor={keyId} hint="Paste the whole line, including the NEXUS- prefix.">
        <Input
          id={keyId}
          value={draft.licenseKey}
          spellCheck={false}
          placeholder="NEXUS-PRO-…"
          onChange={(event) => update('licenseKey', event.target.value)}
          className="font-mono text-meta"
        />
      </Field>
      <p className="mt-3 text-meta text-muted">
        You can skip this and activate later in Settings → Licence. The machine id is shown there so you can
        request a key for this computer.
      </p>
    </Card>
  );
}
