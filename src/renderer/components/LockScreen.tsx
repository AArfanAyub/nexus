/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * LockScreen — a full-window overlay, **not** a route (US-06).
 *
 * The point of an overlay rather than a redirect is that the route stays mounted,
 * so an unsaved invoice survives a lock. Only the password field is focusable,
 * which makes the trap trivial and the behaviour predictable.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { invoke, isApiError } from '../lib/api';
import { useSession, useUi } from '../store';
import { Avatar, Button, Input } from './ui';

export function LockScreen(): JSX.Element | null {
  const open = useUi((state) => state.lockOverlay);
  const setLockOverlay = useUi((state) => state.setLockOverlay);
  const user = useSession((state) => state.user);
  const setUser = useSession((state) => state.setUser);

  const passwordId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword('');
    setError(null);
    const timer = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  async function unlock(): Promise<void> {
    if (password.length === 0) {
      setError('Enter your password.');
      return;
    }
    setBusy(true);
    try {
      const result = await invoke<{ user: typeof user; permissions: string[] }>('auth.unlock', { password });
      setUser(result.user, result.permissions as never);
      setLockOverlay(false);
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'That did not work. Try again.');
      setPassword('');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--overlay)]" role="dialog" aria-modal="true" aria-label="Session locked">
      <div className="w-80 rounded-card border border-line bg-surface p-6 shadow-[var(--shadow-overlay)]">
        <div className="flex flex-col items-center gap-2">
          <Avatar name={user?.fullName ?? 'Locked'} size={44} />
          <p className="text-body font-semibold text-text">{user?.fullName ?? 'Session locked'}</p>
          <p className="text-meta text-muted">Your work is still here. Sign back in to continue.</p>
        </div>

        <form
          className="mt-4 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void unlock();
          }}
        >
          <label htmlFor={passwordId} className="text-meta text-muted">
            Password
          </label>
          <Input
            id={passwordId}
            ref={input}
            type="password"
            autoComplete="current-password"
            value={password}
            invalid={error !== null}
            aria-describedby={error ? `${passwordId}-error` : undefined}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error ? (
            <p id={`${passwordId}-error`} role="alert" className="text-meta text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" loading={busy} className="mt-1">
            Unlock
          </Button>
        </form>
      </div>
    </div>
  );
}
