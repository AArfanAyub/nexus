/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Settings → People: users and roles (US-07, US-08, BR-20, BR-22).
 *
 * Two behaviours worth knowing:
 *   - disabling a user is preferred over deleting, and the main process refuses a
 *     hard delete once audit rows exist, returning a message that offers Disable;
 *   - the permission matrix writes `roles.permissions_json` through the entity
 *     family, which validates every key — a made-up permission is rejected in the
 *     main process, not silently stored.
 */

import { ShieldCheck, UserMinus, UserPlus } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { isPermission, type Permission } from '@shared/permissions';
import type { Paged, Role, User } from '@shared/types';

import { PageHeader } from '../../components/PageHeader';
import { Modal } from '../../components/Modal';
import { Button, Card, Chip, Input, Select, Switch, Tabs } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import { toast } from '../../lib/toast';
import { invalidate, useQuery } from '../../lib/useQuery';

/**
 * `permissions.catalog` returns `{key, label, risk}` per item, not a bare key.
 *
 * The renderer used to type these as strings and render them directly, which is
 * React error #31 — "objects are not valid as a React child" — and took the whole
 * route down with it.
 */
interface PermissionItem {
  readonly key: Permission;
  readonly label: string;
  readonly risk: 'low' | 'medium' | 'high';
}

interface PermissionGroup {
  readonly module: string;
  readonly items: readonly PermissionItem[];
}

/**
 * `entity.list` hands back the raw row, so a role arrives with
 * `permissions_json` (a string) and snake_case columns — not with the
 * `permissions` array the `Role` type promises. Casting the row and hoping is
 * what made the permission matrix crash on `selected.permissions.length`; every
 * consumer goes through this instead.
 */
function toRole(row: Record<string, unknown>): Role {
  const json = typeof row['permissions_json'] === 'string' ? row['permissions_json'] : '[]';
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(json);
  } catch {
    // A role whose JSON will not parse simply has no permissions; the matrix
    // then shows everything unchecked, which is the safe direction.
    parsed = [];
  }
  const permissions = Array.isArray(parsed)
    ? parsed.filter((entry): entry is Permission => typeof entry === 'string' && isPermission(entry))
    : [];
  return {
    id: String(row['id']),
    name: String(row['name']),
    description: typeof row['description'] === 'string' ? row['description'] : null,
    isSystem: Number(row['is_system'] ?? 0) === 1,
    permissions,
    createdAt: String(row['created_at'] ?? ''),
    updatedAt: String(row['updated_at'] ?? ''),
  };
}

/** The route decides the tab — see the note in `Data.tsx`. */
const PEOPLE_ROUTES = { users: '/settings/users', roles: '/settings/roles' } as const;

export interface PeopleProps {
  readonly tab: 'users' | 'roles';
}

export function People({ tab }: PeopleProps): JSX.Element {
  const navigate = useNavigate();
  const active = tab;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={active === 'users' ? 'Users' : 'Roles'}
        subtitle="Accounts and what each role may do"
        toolbar={
          <Tabs
            ariaLabel="People sections"
            value={active}
            onChange={(next) => navigate(PEOPLE_ROUTES[next])}
            items={[
              { value: 'users', label: 'Users' },
              { value: 'roles', label: 'Roles' },
            ]}
          />
        }
      />
      <div className="flex-1 overflow-y-auto p-4">{active === 'users' ? <UsersPanel /> : <RolesPanel />}</div>
    </div>
  );
}

// ── users ────────────────────────────────────────────────────────────────────

function UsersPanel(): JSX.Element {
  const users = useQuery<Paged<Record<string, unknown>>>(
    'users:list',
    () => invoke<Paged<Record<string, unknown>>>('entity.list', { entity: 'users', limit: 200, sort: { key: 'username', dir: 'asc' } }),
    { staleMs: 15_000 },
  );
  const roles = useQuery<readonly Role[]>(
    'roles:list',
    () =>
      invoke<Paged<Record<string, unknown>>>('entity.list', { entity: 'roles', limit: 100 }).then(
        (page) => page.rows.map(toRole),
      ),
    { staleMs: 60_000 },
  );

  const [inviteOpen, setInviteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const rows = users.data?.rows ?? [];

  async function setActive(id: string, active: boolean): Promise<void> {
    setBusy(true);
    try {
      await invoke('users.setActive', { id, active, reason: active ? 'Re-enabled in People' : 'Disabled in People' });
      invalidate('users');
      users.refresh();
      toast.success(active ? 'Account enabled' : 'Account disabled');
    } catch (caught) {
      toast.error('Could not change the account', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card
        title="Users"
        description="Disable an account instead of deleting it — history stays attributable."
        actions={
          <Button variant="primary" onClick={() => setInviteOpen(true)} iconLeft={<UserPlus size={14} />}>
            Invite user
          </Button>
        }
        padded={false}
      >
        {users.loading && rows.length === 0 ? (
          <p className="p-4 text-meta text-muted">Loading…</p>
        ) : users.error ? (
          <div className="p-4">
            <p role="alert" className="text-body text-danger">
              {users.error.message}
            </p>
            <Button className="mt-2" onClick={users.refresh}>
              Try again
            </Button>
          </div>
        ) : (
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="bg-surface-2 text-meta text-muted">
                <th scope="col" className="border-b border-line px-3 py-2 text-left">Username</th>
                <th scope="col" className="border-b border-line px-3 py-2 text-left">Name</th>
                <th scope="col" className="border-b border-line px-3 py-2 text-left">Email</th>
                <th scope="col" className="border-b border-line px-3 py-2 text-left">Status</th>
                <th scope="col" className="border-b border-line px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const id = String(row['id']);
                const isActive = Number(row['is_active']) === 1;
                return (
                  <tr key={id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 text-text">{String(row['username'])}</td>
                    <td className="px-3 py-2 text-text">{String(row['full_name'])}</td>
                    <td className="px-3 py-2 text-muted">{row['email'] ? String(row['email']) : '—'}</td>
                    <td className="px-3 py-2">
                      <Chip tone={isActive ? 'success' : 'danger'}>{isActive ? 'Active' : 'Disabled'}</Chip>
                      {Number(row['is_owner']) === 1 ? <Chip tone="accent" className="ml-1">Owner</Chip> : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || Number(row['is_owner']) === 1}
                        onClick={() => void setActive(id, !isActive)}
                        iconLeft={<UserMinus size={12} />}
                      >
                        {isActive ? 'Disable' : 'Enable'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <InviteModal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        roles={roles.data ?? []}
        onCreated={() => {
          invalidate('users');
          users.refresh();
        }}
      />
    </>
  );
}

interface InviteModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly roles: readonly Role[];
  readonly onCreated: () => void;
}

function InviteModal({ open, onOpenChange, roles, onCreated }: InviteModalProps): JSX.Element {
  const usernameId = useId();
  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const roleId = useId();
  const [form, setForm] = useState({ username: '', fullName: '', email: '', password: '', roleId: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await invoke('users.create', {
        username: form.username.trim(),
        fullName: form.fullName.trim(),
        email: form.email.trim() || undefined,
        password: form.password,
        roleIds: form.roleId ? [form.roleId] : [roles[0]?.id].filter(Boolean),
      });
      toast.success('User created', 'They must change the password at first sign-in.');
      setForm({ username: '', fullName: '', email: '', password: '', roleId: '' });
      onCreated();
      onOpenChange(false);
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'The user could not be created.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Invite a user"
      description="A local account — nothing is emailed, the password is handed over in person."
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            Create user
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={usernameId} className="text-meta font-medium text-text">Username</label>
          <Input id={usernameId} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="text-meta font-medium text-text">Full name</label>
          <Input id={nameId} value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={emailId} className="text-meta font-medium text-text">Email</label>
          <Input id={emailId} type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={passwordId} className="text-meta font-medium text-text">Temporary password</label>
          <Input
            id={passwordId}
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={roleId} className="text-meta font-medium text-text">Role</label>
          <Select
            id={roleId}
            placeholder="Choose a role"
            value={form.roleId}
            options={roles.map((role) => ({ value: role.id, label: role.name }))}
            onChange={(event) => setForm({ ...form, roleId: event.target.value })}
          />
        </div>
        {error ? (
          <p role="alert" className="text-meta text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

// ── roles ────────────────────────────────────────────────────────────────────

function RolesPanel(): JSX.Element {
  const roles = useQuery<readonly Role[]>(
    'roles:list',
    () => invoke<Paged<Record<string, unknown>>>('entity.list', { entity: 'roles', limit: 100 }).then((page) => page.rows.map(toRole)),
    { staleMs: 60_000 },
  );
  const catalog = useQuery<{ groups: readonly PermissionGroup[] }>(
    'permissions:catalog',
    () => invoke<{ groups: readonly PermissionGroup[] }>('permissions.catalog', {}),
    { staleMs: 600_000 },
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<Permission>>(new Set());
  const [busy, setBusy] = useState(false);

  const selected = useMemo(
    () => (roles.data ?? []).find((role) => role.id === selectedId) ?? (roles.data ?? [])[0] ?? null,
    [roles.data, selectedId],
  );

  // Keep the draft in sync with the chosen role, without a stale closure.
  const draftKey = `${selected?.id ?? 'none'}:${(selected?.permissions ?? []).join(',')}`;
  const [loadedKey, setLoadedKey] = useState('');
  if (selected && loadedKey !== draftKey) {
    setLoadedKey(draftKey);
    setDraft(new Set(selected.permissions));
  }

  const dirty = selected ? draft.size !== selected.permissions.length || selected.permissions.some((p) => !draft.has(p)) : false;

  async function save(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    try {
      await invoke('entity.save', {
        entity: 'roles',
        id: selected.id,
        values: { permissions_json: JSON.stringify([...draft].sort()) },
      });
      invalidate('roles');
      roles.refresh();
      toast.success('Role updated', 'Affected users see the change at their next sign-in.');
    } catch (caught) {
      toast.error('Could not save the role', isApiError(caught) ? caught.message : 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  if (roles.loading && !roles.data) return <p className="text-meta text-muted">Loading roles…</p>;
  if (roles.error) {
    return (
      <div>
        <p role="alert" className="text-body text-danger">{roles.error.message}</p>
        <Button className="mt-2" onClick={roles.refresh}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <Card title="Roles" padded={false}>
        <ul>
          {(roles.data ?? []).map((role) => (
            <li key={role.id}>
              <button
                type="button"
                onClick={() => setSelectedId(role.id)}
                aria-current={selected?.id === role.id ? 'true' : undefined}
                className={
                  selected?.id === role.id
                    ? 'flex w-full items-center justify-between bg-accent-soft px-3 py-2 text-left text-body text-accent'
                    : 'flex w-full items-center justify-between px-3 py-2 text-left text-body text-text hover:bg-surface-2'
                }
              >
                <span className="truncate">{role.name}</span>
                {role.isSystem ? <Chip tone="neutral">system</Chip> : null}
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title={selected ? `${selected.name} permissions` : 'Permissions'}
        description={selected?.description ?? 'Tick what this role may do. The main process enforces it regardless of the UI.'}
        actions={
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!dirty} iconLeft={<ShieldCheck size={14} />}>
            Save role
          </Button>
        }
      >
        {(catalog.data?.groups ?? []).map((group) => (
          <div key={group.module} className="mb-4">
            <p className="mb-1 text-meta uppercase tracking-wide text-muted">{group.module}</p>
            <div className="grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
              {group.items.map((permission) => (
                <label key={permission.key} className="flex items-start gap-2 text-body text-text" title={permission.key}>
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-[var(--accent)]"
                    checked={draft.has(permission.key)}
                    onChange={(event) => {
                      setDraft((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(permission.key);
                        else next.delete(permission.key);
                        return next;
                      });
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block">{permission.label}</span>
                    {permission.risk === 'high' ? (
                      <span className="tnum block text-meta text-muted">{permission.key} · high risk</span>
                    ) : (
                      <span className="tnum block text-meta text-muted">{permission.key}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
        {catalog.loading ? <p className="text-meta text-muted">Loading permission catalogue…</p> : null}
      </Card>
    </div>
  );
}

/** Kept for the T06 user-detail drawer; exported so the import is not dead. */
export function UserSummary({ user }: { readonly user: User }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Switch checked={user.isActive} onChange={() => undefined} label={user.fullName} disabled />
      <span className="text-meta text-muted">{user.username}</span>
    </div>
  );
}

