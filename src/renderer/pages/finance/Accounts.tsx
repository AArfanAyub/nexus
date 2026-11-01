/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Chart of accounts (T05).
 *
 * A tree, not a table with a `parent_id` column: `coaTree()` returns the nodes
 * already ordered depth-first with a pre-computed `depth`, so this page only has
 * to decide which branches are open. Collapsing a branch hides descendants by
 * filtering on depth, which keeps the row count honest without re-querying.
 *
 * Two rules the UI enforces rather than merely displaying:
 *   - a parent is a summary and is never postable, so `isPostable` is only
 *     offered for a leaf;
 *   - an account with postings or children cannot be archived — the server says
 *     so, and the drawer repeats the reason instead of failing silently.
 */

import { AlertCircle, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import type { AccountInput, AccountNode, AccountType } from '@shared/finance';

import { Drawer } from '../../components/Drawer';
import { Modal } from '../../components/Modal';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, MoneyCell, TableSkeleton } from '../../components/patterns';
import { Button, Checkbox, Chip, IconButton, Input, Select, Textarea, Tooltip } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import { fk, useCoa } from '../../lib/finance';
import { amount } from '../../lib/format';
import { toast } from '../../lib/toast';
import { invalidate } from '../../lib/useQuery';
import { useSession } from '../../store';

const TYPE_LABEL: Record<AccountType, string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expense',
};

const TYPE_TONE: Record<AccountType, 'accent' | 'success' | 'warning' | 'danger' | 'info'> = {
  asset: 'accent',
  liability: 'warning',
  equity: 'info',
  income: 'success',
  expense: 'danger',
};

interface Draft {
  readonly id?: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly parentId: string | null;
  readonly isPostable: boolean;
  readonly currency: string;
  readonly description: string;
}

const EMPTY_DRAFT: Draft = {
  code: '',
  name: '',
  type: 'asset',
  parentId: null,
  isPostable: true,
  currency: '',
  description: '',
};

export function Accounts(): JSX.Element {
  const baseCurrency = useSession((state) => state.company?.baseCurrency ?? 'USD');
  const canWrite = useSession((state) => state.can('finance.account.write'));
  const canArchive = useSession((state) => state.can('finance.account.delete'));

  const [includeArchived, setIncludeArchived] = useState(false);
  const { accounts, loading, error } = useCoa(includeArchived);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selected, setSelected] = useState<AccountNode | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState<AccountNode | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * Hides every node under a collapsed ancestor. Walking once in order means a
   * node is visible only when *all* of its ancestors are open.
   */
  const visible = useMemo(() => {
    const hiddenBelow: number[] = [];
    return accounts.filter((account) => {
      while (hiddenBelow.length > 0 && (hiddenBelow[hiddenBelow.length - 1] ?? 0) >= account.depth) {
        hiddenBelow.pop();
      }
      if (hiddenBelow.length > 0) return false;
      if (collapsed.has(account.id) && account.hasChildren) hiddenBelow.push(account.depth);
      return true;
    });
  }, [accounts, collapsed]);

  const totals = useMemo(() => {
    const byType = new Map<AccountType, number>();
    for (const account of accounts) {
      if (!account.isPostable || account.isArchived) continue;
      byType.set(account.type, (byType.get(account.type) ?? 0) + account.ownBalanceCents);
    }
    return byType;
  }, [accounts]);

  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function openNew(parentId: string | null): void {
    const parent = parentId ? accounts.find((account) => account.id === parentId) : undefined;
    setFormError(null);
    setDraft({
      ...EMPTY_DRAFT,
      type: parent?.type ?? 'asset',
      parentId,
      isPostable: parent ? !parent.hasChildren : true,
      code: parent ? `${parent.code}` : '',
    });
  }

  function openEdit(account: AccountNode): void {
    setFormError(null);
    setDraft({
      id: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      parentId: account.parentId,
      isPostable: account.isPostable,
      currency: account.currency ?? '',
      description: account.description ?? '',
    });
  }

  async function save(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    setFormError(null);
    try {
      const payload: AccountInput = {
        id: draft.id,
        code: draft.code.trim(),
        name: draft.name.trim(),
        type: draft.type,
        parentId: draft.parentId,
        isPostable: draft.isPostable,
        currency: draft.currency.trim() === '' ? null : draft.currency.trim().toUpperCase(),
        description: draft.description.trim() === '' ? null : draft.description.trim(),
      };
      const saved = await invoke<AccountNode>('finance.coa.save', payload);
      invalidate(fk.coa(false));
      invalidate(fk.coa(true));
      setDraft(null);
      setSelected((current) => (current && current.id === saved.id ? saved : current));
      toast.success(draft.id ? 'Account updated' : 'Account created', `${saved.code} · ${saved.name}`);
    } catch (caught) {
      setFormError(isApiError(caught) ? caught.message : 'That account could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function archive(): Promise<void> {
    if (!archiving) return;
    setSaving(true);
    try {
      await invoke('finance.coa.archive', { id: archiving.id, reason: archiveReason.trim() });
      invalidate(fk.coa(false));
      invalidate(fk.coa(true));
      setArchiving(null);
      setArchiveReason('');
      setSelected(null);
      toast.success('Account archived', `${archiving.code} no longer appears in pickers.`);
    } catch (caught) {
      toast.error(
        'That account cannot be archived',
        isApiError(caught) ? caught.message : 'It may have postings or child accounts.',
      );
    } finally {
      setSaving(false);
    }
  }

  const parentOptions = useMemo(
    () =>
      accounts
        .filter((account) => !account.isArchived && account.id !== draft?.id)
        .map((account) => ({
          value: account.id,
          label: `${'· '.repeat(account.depth)}${account.code} ${account.name}`,
        })),
    [accounts, draft?.id],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Chart of accounts"
        subtitle={`Base currency ${baseCurrency}`}
        count={accounts.filter((account) => !account.isArchived).length}
        countLabel="accounts"
        secondaryActions={
          <Checkbox
            label="Show archived"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
        }
        primaryAction={
          canWrite ? (
            <Button variant="primary" iconLeft={<Plus size={14} aria-hidden="true" />} onClick={() => openNew(null)}>
              New account
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-2">
        {(Object.keys(TYPE_LABEL) as AccountType[]).map((type) => (
          <Chip key={type} tone={TYPE_TONE[type]}>
            <span className="micro text-current">{TYPE_LABEL[type]}</span>
            <MoneyCell>{amount(totals.get(type) ?? 0)}</MoneyCell>
          </Chip>
        ))}
        <span className="ml-auto text-meta text-muted">
          A parent is a summary and is never posted to.
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="m-5 flex items-start gap-2 rounded-card border border-danger bg-danger-soft p-3 text-body text-danger" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : loading ? (
          <TableSkeleton rows={10} columns={5} />
        ) : visible.length === 0 ? (
          <EmptyState
            title="No accounts yet"
            description="An industry preset seeds a full chart of accounts. Apply one in Settings → Data, or add the first account here."
            action={
              canWrite ? (
                <Button variant="primary" onClick={() => openNew(null)}>
                  New account
                </Button>
              ) : null
            }
          />
        ) : (
          <table className="w-full border-collapse text-body" aria-label="Chart of accounts">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr>
                <th scope="col" className="w-28 px-3 py-2 text-left text-meta font-medium text-muted">
                  Code
                </th>
                <th scope="col" className="px-3 py-2 text-left text-meta font-medium text-muted">
                  Name
                </th>
                <th scope="col" className="w-32 px-3 py-2 text-left text-meta font-medium text-muted">
                  Type
                </th>
                <th scope="col" className="w-28 px-3 py-2 text-left text-meta font-medium text-muted">
                  Postable
                </th>
                <th scope="col" className="w-36 px-3 py-2 text-right text-meta font-medium text-muted">
                  Balance
                </th>
                <th scope="col" className="w-24 px-2 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((account) => {
                const open = !collapsed.has(account.id);
                return (
                  <tr
                    key={account.id}
                    tabIndex={0}
                    onClick={() => setSelected(account)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') setSelected(account);
                      if (event.key === 'ArrowRight' && account.hasChildren && !open) toggle(account.id);
                      if (event.key === 'ArrowLeft' && account.hasChildren && open) toggle(account.id);
                    }}
                    className={[
                      'group cursor-pointer border-b border-line transition-colors duration-fast',
                      selected?.id === account.id ? 'bg-surface-3' : 'hover:bg-surface-2',
                      account.isArchived ? 'opacity-55' : '',
                    ].join(' ')}
                    style={{ height: 'var(--row-h)' }}
                  >
                    <td className="px-3 font-mono text-code text-muted">{account.code}</td>
                    <td className="px-3">
                      <span className="flex items-center gap-1" style={{ paddingLeft: account.depth * 16 }}>
                        {account.hasChildren ? (
                          <button
                            type="button"
                            aria-label={open ? `Collapse ${account.name}` : `Expand ${account.name}`}
                            aria-expanded={open}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggle(account.id);
                            }}
                            className="rounded-input p-0.5 text-muted hover:bg-surface-3 hover:text-text"
                          >
                            {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                          </button>
                        ) : (
                          <span className="inline-block w-[18px]" aria-hidden="true" />
                        )}
                        <span className={account.hasChildren ? 'font-medium text-text' : 'text-text'}>
                          {account.name}
                        </span>
                        {account.isArchived ? <Chip tone="neutral">Archived</Chip> : null}
                      </span>
                    </td>
                    <td className="px-3">
                      <Chip tone={TYPE_TONE[account.type]}>{TYPE_LABEL[account.type]}</Chip>
                    </td>
                    <td className="px-3 text-meta text-muted">{account.isPostable ? 'Yes' : 'Summary'}</td>
                    <td className="px-3 text-right">
                      <MoneyCell muted={account.balanceCents === 0}>{amount(account.balanceCents)}</MoneyCell>
                    </td>
                    <td className="px-2 text-right" onClick={(event) => event.stopPropagation()}>
                      <div className="flex justify-end gap-1 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100">
                        {canWrite ? (
                          <Tooltip label="Add a child account">
                            <IconButton label={`Add a child of ${account.name}`} size="sm" onClick={() => openNew(account.id)}>
                              <Plus size={14} aria-hidden="true" />
                            </IconButton>
                          </Tooltip>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── detail drawer ─────────────────────────────────────────────────── */}
      <Drawer
        open={selected !== null}
        onOpenChange={(open) => (open ? undefined : setSelected(null))}
        title={selected ? `${selected.code} ${selected.name}` : ''}
        subtitle={selected ? `${TYPE_LABEL[selected.type]}${selected.isPostable ? ' · postable' : ' · summary'}` : undefined}
        footer={
          selected ? (
            <div className="flex items-center justify-between gap-2">
              {canArchive && !selected.isArchived ? (
                <Button variant="ghost" onClick={() => { setArchiving(selected); setArchiveReason(''); }}>
                  Archive
                </Button>
              ) : (
                <span />
              )}
              {canWrite ? (
                <Button variant="primary" onClick={() => openEdit(selected)}>
                  Edit
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {selected ? (
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-y-2 text-body">
            <dt className="text-muted">Balance</dt>
            <dd className="text-right">
              <MoneyCell>{amount(selected.balanceCents)}</MoneyCell>
            </dd>
            <dt className="text-muted">Own postings</dt>
            <dd className="text-right">
              <MoneyCell muted>{amount(selected.ownBalanceCents)}</MoneyCell>
            </dd>
            <dt className="text-muted">Lines posted</dt>
            <dd className="text-right tabular-nums">{selected.postingCount.toLocaleString()}</dd>
            <dt className="text-muted">Currency</dt>
            <dd className="text-right">{selected.currency ?? `${baseCurrency} (base)`}</dd>
            <dt className="text-muted">Children</dt>
            <dd className="text-right">{selected.hasChildren ? 'Yes' : 'None'}</dd>
            {selected.description ? (
              <>
                <dt className="text-muted">Description</dt>
                <dd className="text-right">{selected.description}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </Drawer>

      {/* ── create / edit ─────────────────────────────────────────────────── */}
      <Modal
        open={draft !== null}
        onOpenChange={(open) => (open ? undefined : setDraft(null))}
        title={draft?.id ? 'Edit account' : 'New account'}
        description="A code must be unique. Leave the currency empty to use the company base currency."
        size="md"
        busy={saving}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!draft || draft.code.trim() === '' || draft.name.trim() === ''}
              onClick={() => void save()}
            >
              {draft?.id ? 'Save changes' : 'Create account'}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="micro">Code</span>
              <Input
                value={draft.code}
                autoFocus
                onChange={(event) => setDraft({ ...draft, code: event.target.value })}
                placeholder="1100"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="micro">Type</span>
              <Select
                value={draft.type}
                options={(Object.keys(TYPE_LABEL) as AccountType[]).map((type) => ({
                  value: type,
                  label: TYPE_LABEL[type],
                }))}
                onChange={(event) => setDraft({ ...draft, type: event.target.value as AccountType })}
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="micro">Name</span>
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Trade receivables"
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="micro">Parent</span>
              <Select
                value={draft.parentId ?? ''}
                placeholder="No parent (top level)"
                options={parentOptions}
                onChange={(event) =>
                  setDraft({ ...draft, parentId: event.target.value === '' ? null : event.target.value })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="micro">Currency</span>
              <Input
                value={draft.currency}
                maxLength={3}
                onChange={(event) => setDraft({ ...draft, currency: event.target.value.toUpperCase() })}
                placeholder={baseCurrency}
              />
            </label>
            <div className="flex items-end pb-1">
              <Checkbox
                label="Postable"
                checked={draft.isPostable}
                onChange={(event) => setDraft({ ...draft, isPostable: event.target.checked })}
              />
            </div>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="micro">Description</span>
              <Textarea
                rows={2}
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            {formError ? (
              <p className="col-span-2 rounded-input border border-danger bg-danger-soft px-2 py-1.5 text-meta text-danger" role="alert">
                {formError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* ── archive ───────────────────────────────────────────────────────── */}
      <Modal
        open={archiving !== null}
        onOpenChange={(open) => (open ? undefined : setArchiving(null))}
        title="Archive account"
        description="Archived accounts keep their history and stay in every report. They disappear from pickers."
        size="sm"
        destructive
        busy={saving}
        footer={
          <>
            <Button variant="ghost" onClick={() => setArchiving(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={saving}
              disabled={archiveReason.trim().length < 3}
              onClick={() => void archive()}
            >
              Archive
            </Button>
          </>
        }
      >
        <label className="flex flex-col gap-1">
          <span className="micro">Reason (recorded in the audit log)</span>
          <Input
            autoFocus
            value={archiveReason}
            onChange={(event) => setArchiveReason(event.target.value)}
            placeholder="Duplicate of 1100"
          />
        </label>
        {archiving ? (
          <p className="mt-2 text-meta text-muted">
            {archiving.code} · {archiving.name} — {archiving.postingCount.toLocaleString()} postings.
            {archiving.postingCount > 0 ? ' An account with postings cannot be archived.' : ''}
          </p>
        ) : null}
      </Modal>

      <p className="border-t border-line bg-surface px-5 py-1.5 text-meta text-muted">
        {selected
          ? `${selected.code} · ${selected.postingCount.toLocaleString()} postings · ${selected.hasChildren ? 'has children' : 'leaf'}`
          : 'Select an account to see its detail. ← and → collapse and expand a branch.'}
      </p>
    </div>
  );
}
