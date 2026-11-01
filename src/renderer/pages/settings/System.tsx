/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Settings → System: licence, audit log, backup, security policy, appearance
 * (US-04, BR-25, ARCHITECTURE §C.12).
 *
 * The audit tab is the tamper-evidence surface: `audit.verify` walks the hash
 * chain and reports the first broken `seq`, so a reviewer can point at the exact
 * row that was edited rather than "something looks wrong".
 */

import { Check, Copy, ShieldAlert } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { AuditDiff, AuditFieldChange } from '@shared/admin';
import type { AuditChainResult, AuditEntry, LicenseStatus, SecurityPolicy } from '@shared/types';

import { Drawer } from '../../components/Drawer';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, TableSkeleton } from '../../components/patterns';
import { BackupPanel } from './BackupPanel';
import { Button, Card, Chip, Input, Segmented, Tabs } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import { useQuery } from '../../lib/useQuery';
import { useSession, useUi, type AccentName, type DensityName, type ThemeName } from '../../store';

type SystemTab = 'license' | 'audit' | 'backup' | 'security' | 'appearance';

/** The route decides the tab — see the note in `Data.tsx`. */
const SYSTEM_ROUTES: Readonly<Record<SystemTab, string>> = {
  license: '/settings/license',
  audit: '/settings/audit-log',
  backup: '/settings/backup',
  security: '/settings/security',
  appearance: '/settings/appearance',
};

/** The heading names the tab — see the note in `Data.tsx`. */
const SYSTEM_LABELS: Readonly<Record<SystemTab, string>> = {
  license: 'Licence',
  audit: 'Audit log',
  backup: 'Backup',
  security: 'Security',
  appearance: 'Appearance',
};

export interface SystemProps {
  readonly tab: SystemTab;
}

export function System({ tab }: SystemProps): JSX.Element {
  const navigate = useNavigate();
  const active = tab;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={SYSTEM_LABELS[active]}
        subtitle="Licence, audit trail, security and appearance"
        toolbar={
          <Tabs
            ariaLabel="System sections"
            value={active}
            onChange={(next) => navigate(SYSTEM_ROUTES[next])}
            items={[
              { value: 'license', label: 'Licence' },
              { value: 'audit', label: 'Audit log' },
              { value: 'backup', label: 'Backup' },
              { value: 'security', label: 'Security' },
              { value: 'appearance', label: 'Appearance' },
            ]}
          />
        }
      />
      <div className="flex-1 overflow-y-auto p-4">
        {active === 'license' ? <LicensePanel /> : null}
        {active === 'audit' ? <AuditPanel /> : null}
        {active === 'backup' ? <BackupPanel /> : null}
        {active === 'security' ? <SecurityPanel /> : null}
        {active === 'appearance' ? <AppearancePanel /> : null}
      </div>
    </div>
  );
}

// ── licence ──────────────────────────────────────────────────────────────────

function LicensePanel(): JSX.Element {
  const license = useSession((state) => state.license);
  const machine = useQuery<{ machineId: string }>(
    'license:machine',
    () => invoke<{ machineId: string }>('license.machineId', {}),
    { staleMs: 600_000 },
  );
  const keyId = useId();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function activate(): Promise<void> {
    setBusy(true);
    try {
      const status = await invoke<LicenseStatus>('license.activate', { key: key.trim() });
      useSession.setState({ license: status });
      toast.success(`Activated: ${status.edition}`, status.licensee ?? undefined);
      setKey('');
    } catch (caught) {
      toast.error('That key was not accepted', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(): Promise<void> {
    setBusy(true);
    try {
      const status = await invoke<LicenseStatus>('license.deactivate', { reason: 'Deactivated in Settings' });
      useSession.setState({ license: status });
      toast.info('Licence deactivated', 'The application is back on the Community edition.');
    } catch (caught) {
      toast.error('Could not deactivate', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  async function copyMachine(): Promise<void> {
    const value = machine.data?.machineId ?? '';
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy', 'Select the id and copy it manually.');
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Current licence">
        <dl className="flex flex-col gap-2 text-body">
          <Row label="Edition" value={<Chip tone="accent">{license?.edition ?? 'community'}</Chip>} />
          <Row label="Licensee" value={license?.licensee ?? '—'} />
          <Row label="Seats" value={String(license?.seats ?? 1)} />
          <Row label="Expires" value={<span className="text-success">Never — perpetual</span>} />
          <Row
            label="Machine id"
            value={
              <span className="flex items-center gap-2">
                <code className="tnum text-text">{machine.data?.machineId ?? '…'}</code>
                <Button size="sm" variant="ghost" onClick={() => void copyMachine()} iconLeft={copied ? <Check size={12} /> : <Copy size={12} />}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </span>
            }
          />
        </dl>
        {license?.suspectClock ? (
          <p className="mt-3 flex items-center gap-2 rounded-input bg-warning-soft px-2 py-1.5 text-meta text-warning">
            <ShieldAlert size={14} aria-hidden="true" />
            The system clock moved backwards. Licence dates are ignored; work is unaffected.
          </p>
        ) : null}
        {license?.edition !== 'community' ? (
          <Button className="mt-4" variant="danger" onClick={() => void deactivate()} loading={busy}>
            Deactivate
          </Button>
        ) : null}
      </Card>

      <Card title="Activate a key" description="Paste a customer key in full (it starts with NEXUS-), or enter the owner code.">
        <div className="flex flex-col gap-2">
          <label htmlFor={keyId} className="text-meta font-medium text-text">
            Licence key
          </label>
          <Input
            id={keyId}
            value={key}
            spellCheck={false}
            placeholder="NEXUS-PRO-… or the owner code"
            className="font-mono text-meta"
            onChange={(event) => setKey(event.target.value)}
          />
          <Button variant="primary" onClick={() => void activate()} loading={busy} disabled={key.trim().length < 6}>
            Activate
          </Button>
          <p className="text-meta text-muted">
            Keys are verified offline with Ed25519. Nothing is sent anywhere; a customer key that does not
            match this machine is refused with the reason. The owner code activates this machine permanently.
          </p>
        </div>
      </Card>
    </div>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line pb-1.5 last:border-0">
      <dt className="text-meta text-muted">{label}</dt>
      <dd className="text-body text-text">{value}</dd>
    </div>
  );
}

// ── audit ────────────────────────────────────────────────────────────────────

function AuditPanel(): JSX.Element {
  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const entries = useQuery<{ rows: readonly AuditEntry[]; total: number }>(
    `audit:list:${action}:${entity}:${actor}:${from}:${to}`,
    () =>
      invoke<{ rows: readonly AuditEntry[]; total: number }>('audit.list', {
        action: action || undefined,
        entity: entity || undefined,
        actorId: actor || undefined,
        from: from || undefined,
        to: to ? `${to}T23:59:59.999Z` : undefined,
        limit: 100,
      }),
    { staleMs: 5_000 },
  );
  const [verifying, setVerifying] = useState(false);
  const [chain, setChain] = useState<AuditChainResult | null>(null);

  async function verify(): Promise<void> {
    setVerifying(true);
    try {
      const result = await invoke<AuditChainResult>('audit.verify', {});
      setChain(result);
      if (result.ok) toast.success('Audit chain intact', `${String(result.checked)} entries verified.`);
      else toast.error('Audit chain broken', `The first mismatch is at entry ${String(result.brokenAtSeq)}.`);
    } catch (caught) {
      toast.error('Could not verify', isApiError(caught) ? caught.message : 'Try again.');
    } finally {
      setVerifying(false);
    }
  }

  return (
    <Card
      title="Audit log"
      description="Every write is hash-chained: changing a row breaks the chain at that entry."
      actions={
        <>
          <Input
            aria-label="Filter by action"
            placeholder="Action…"
            value={action}
            onChange={(event) => setAction(event.target.value)}
            className="w-32"
          />
          <Input
            aria-label="Filter by entity"
            placeholder="Entity…"
            value={entity}
            onChange={(event) => setEntity(event.target.value)}
            className="w-32"
          />
          <Input
            aria-label="Filter by user id"
            placeholder="User id…"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            className="w-32"
          />
          <Input
            aria-label="From date"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="w-36"
          />
          <Input
            aria-label="To date"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="w-36"
          />
          <Button onClick={() => void verify()} loading={verifying}>
            Verify chain
          </Button>
        </>
      }
      padded={false}
    >
      {chain ? (
        <div
          className={
            chain.ok
              ? 'border-b border-line bg-success-soft px-3 py-2 text-meta text-success'
              : 'border-b border-line bg-danger-soft px-3 py-2 text-meta text-danger'
          }
          role="status"
        >
          {chain.ok
            ? `Chain intact — ${String(chain.checked)} entries verified.`
            : `Chain broken at entry ${String(chain.brokenAtSeq)} of ${String(chain.checked)}.`}
        </div>
      ) : null}

      <table className="w-full border-collapse text-body">
        <thead>
          <tr className="bg-surface-2 text-meta text-muted">
            <th scope="col" className="border-b border-line px-3 py-2 text-left">#</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-left">When</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Actor</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Action</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Record</th>
            <th scope="col" className="border-b border-line px-3 py-2 text-left">Hash</th>
          </tr>
        </thead>
        <tbody>
          {(entries.data?.rows ?? []).map((entry) => (
            <tr
              key={entry.id}
              className="cursor-pointer border-b border-line last:border-0 hover:bg-elevated/60"
              onClick={() => setSelected(entry)}
              title="Open the before/after diff"
            >
              <td className="tnum px-3 py-2 text-muted">{entry.seq}</td>
              <td className="px-3 py-2 text-text">{dateTime(entry.at)}</td>
              <td className="px-3 py-2 text-text">{entry.actorName}</td>
              <td className="px-3 py-2 text-text">{entry.action}</td>
              <td className="px-3 py-2 text-muted">
                {entry.entity}
                {entry.entityId ? ` · ${entry.entityId.slice(0, 8)}` : ''}
              </td>
              <td className="tnum px-3 py-2 text-muted">{entry.hash.slice(0, 10)}…</td>
            </tr>
          ))}
          {(entries.data?.rows ?? []).length === 0 ? (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-meta text-muted">
                No entries match.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <Drawer
        open={selected !== null}
        onOpenChange={(next) => {
          if (!next) setSelected(null);
        }}
        title={selected ? `${selected.action} · ${selected.entity}` : ''}
        subtitle={selected ? `${dateTime(selected.at)} · ${selected.actorName}` : undefined}
        width={520}
      >
        {selected ? <AuditDiffView entry={selected} /> : null}
      </Drawer>
    </Card>
  );
}

/**
 * The before/after diff for one entry.
 *
 * The server does the field-by-field comparison (`audit.diff`) rather than the
 * browser, because "changed" has to mean the same thing here as it does in the
 * chain verification — and because `before`/`after` are arbitrary JSON, which a
 * naive client-side compare would flatten into uselessness.
 */
function AuditDiffView({ entry }: { readonly entry: AuditEntry }): JSX.Element {
  const diff = useQuery<AuditDiff>(`audit:diff:${String(entry.seq)}`, () =>
    invoke<AuditDiff>('audit.diff', { seq: entry.seq }),
  );

  if (diff.loading) return <TableSkeleton rows={4} columns={2} />;
  if (diff.error) return <EmptyState title="The diff could not load" description={diff.error.message} />;
  if (!diff.data) return <EmptyState title="Nothing to show" description="This entry has no before/after." />;

  const sections: readonly { readonly label: string; readonly rows: readonly AuditFieldChange[] }[] = [
    { label: 'Changed', rows: diff.data.changed },
    { label: 'Added', rows: diff.data.added },
    { label: 'Removed', rows: diff.data.removed },
  ];
  const empty = sections.every((section) => section.rows.length === 0);

  return (
    <div className="space-y-3">
      {empty ? (
        <EmptyState title="No field changes" description="The entry records an action with no before/after payload." />
      ) : (
        sections
          .filter((section) => section.rows.length > 0)
          .map((section) => (
            <div key={section.label}>
              <h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted">{section.label}</h3>
              <table className="w-full text-meta">
                <tbody className="divide-y divide-line">
                  {section.rows.map((row) => (
                    <tr key={row.field}>
                      <td className="py-1 pr-2 align-top font-mono text-[11px] text-muted">{row.field}</td>
                      <td className="py-1 pr-2 align-top text-danger line-through">{row.before ?? '—'}</td>
                      <td className="py-1 align-top text-success">{row.after ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
      )}
      <dl className="rounded-card border border-line p-2 text-[11px]">
        <div className="flex justify-between">
          <dt className="text-muted">Sequence</dt>
          <dd className="tabular-nums text-text">{entry.seq}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Hash</dt>
          <dd className="truncate font-mono text-text" title={entry.hash}>
            {entry.hash.slice(0, 24)}…
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Previous</dt>
          <dd className="truncate font-mono text-text" title={entry.prevHash}>
            {entry.prevHash.slice(0, 24)}…
          </dd>
        </div>
      </dl>
      <p className="text-[11px] text-muted">
        This log is append-only: there is no edit or clear affordance anywhere in the application, by design.
      </p>
    </div>
  );
}

// ── security ─────────────────────────────────────────────────────────────────

function SecurityPanel(): JSX.Element {
  const idleId = useId();
  const lengthId = useId();
  const attemptsId = useId();
  const lockoutId = useId();
  const [form, setForm] = useState<SecurityPolicy>({
    idleTimeoutMin: 15,
    minPasswordLength: 10,
    requireSymbol: true,
    maxAttempts: 5,
    lockoutMin: 15,
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void invoke<Record<string, unknown>>('settings.get', { keys: ['security'] })
      .then((bag) => {
        const stored = bag['security'] as Partial<SecurityPolicy> | undefined;
        if (stored) setForm((current) => ({ ...current, ...stored }));
      })
      .catch(() => undefined);
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const saved = await invoke<SecurityPolicy>('settings.security.save', form);
      setForm(saved);
      toast.success('Security policy saved', 'New rules apply at the next sign-in.');
    } catch (caught) {
      toast.error('Could not save', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Security"
      description="Applies to this company file only."
      actions={
        <Button variant="primary" onClick={() => void save()} loading={busy}>
          Save policy
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={idleId} className="text-meta font-medium text-text">Lock after (minutes idle)</label>
          <Input
            id={idleId}
            inputMode="numeric"
            value={String(form.idleTimeoutMin)}
            onChange={(event) => setForm({ ...form, idleTimeoutMin: Number(event.target.value) || 0 })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={lengthId} className="text-meta font-medium text-text">Minimum password length</label>
          <Input
            id={lengthId}
            inputMode="numeric"
            value={String(form.minPasswordLength)}
            onChange={(event) => setForm({ ...form, minPasswordLength: Number(event.target.value) || 0 })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={attemptsId} className="text-meta font-medium text-text">Failed attempts before lockout</label>
          <Input
            id={attemptsId}
            inputMode="numeric"
            value={String(form.maxAttempts)}
            onChange={(event) => setForm({ ...form, maxAttempts: Number(event.target.value) || 0 })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={lockoutId} className="text-meta font-medium text-text">Lockout duration (minutes)</label>
          <Input
            id={lockoutId}
            inputMode="numeric"
            value={String(form.lockoutMin)}
            onChange={(event) => setForm({ ...form, lockoutMin: Number(event.target.value) || 0 })}
          />
        </div>
      </div>
      <label className="mt-3 flex items-center gap-2 text-body text-text">
        <input
          type="checkbox"
          checked={form.requireSymbol}
          onChange={(event) => setForm({ ...form, requireSymbol: event.target.checked })}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        Require a symbol in passwords
      </label>
      <p className="mt-3 text-meta text-muted">
        Passwords are hashed with scrypt (N=16384, r=8, p=1) and compared in constant time. A locked account is
        recorded in the audit log on every attempt.
      </p>
    </Card>
  );
}

// ── appearance ───────────────────────────────────────────────────────────────

function AppearancePanel(): JSX.Element {
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const density = useUi((state) => state.density);
  const setDensity = useUi((state) => state.setDensity);
  const accent = useUi((state) => state.accent);
  const setAccent = useUi((state) => state.setAccent);

  return (
    <Card title="Appearance" description="Changes apply immediately and are remembered per user.">
      <div className="flex flex-col gap-4">
        <div>
          <p className="mb-1 text-meta text-muted">Theme</p>
          <Segmented<ThemeName>
            ariaLabel="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
        <div>
          <p className="mb-1 text-meta text-muted">Row density</p>
          <Segmented<DensityName>
            ariaLabel="Row density"
            value={density}
            onChange={setDensity}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </div>
        <div>
          <p className="mb-1 text-meta text-muted">Accent</p>
          <Segmented<AccentName>
            ariaLabel="Accent colour"
            value={accent}
            onChange={setAccent}
            options={[
              { value: 'blue', label: 'Blue' },
              { value: 'teal', label: 'Teal' },
              { value: 'violet', label: 'Violet' },
              { value: 'amber', label: 'Amber' },
            ]}
          />
        </div>
        <p className="text-meta text-muted">
          Focus rings stay 2px in every theme, and motion is disabled automatically when your system asks for
          reduced motion. Density changes the table row height only — the type scale is untouched.
        </p>
      </div>
    </Card>
  );
}
