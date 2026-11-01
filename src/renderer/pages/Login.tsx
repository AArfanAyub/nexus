/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * `/login` — public route.
 *
 * Deliberately plain: one username, one password, one error line that never says
 * which half was wrong (that is decided in `services/auth.ts`). The form submits
 * on Enter and disables itself while the call is in flight so a double click
 * cannot burn a lockout attempt.
 */

import { useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { LoginResult } from '@shared/types';

import { NexusLogo } from '../components/BrandMark';
import { Button, Input } from '../components/ui';
import { invoke, isApiError } from '../lib/api';
import { clearQueryCache } from '../lib/useQuery';
import { useSession } from '../store';

export function Login(): JSX.Element {
  const navigate = useNavigate();
  const setUser = useSession((state) => state.setUser);
  const company = useSession((state) => state.company);
  const edition = useSession((state) => state.license?.edition ?? 'community');

  const usernameId = useId();
  const passwordId = useId();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function submit(): Promise<void> {
    if (username.trim() === '' || password === '') {
      setError('Enter your username and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<LoginResult>('auth.login', { username, password });
      clearQueryCache();
      setUser(result.user, result.permissions);
      navigate('/dashboard', { replace: true });
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'Sign-in failed. Try again.');
      setPassword('');
      passwordRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg">
      <div className="w-[26rem] rounded-card border border-line bg-surface p-6 shadow-[var(--shadow-overlay)]">
        <NexusLogo size={34} tagline="Where your business connects" />
        <div className="mt-5 flex items-end justify-between gap-3 border-t border-line pt-3">
          <div className="min-w-0">
            <p className="micro text-muted">Signed in to</p>
            <h1 className="truncate text-body font-semibold text-text">{company?.name ?? 'NEXUS'}</h1>
          </div>
          <span className="shrink-0 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-medium capitalize text-muted">
            {edition}
          </span>
        </div>

        <form
          className="mt-5 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={usernameId} className="text-meta font-medium text-text">
              Username
            </label>
            <Input
              id={usernameId}
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={passwordId} className="text-meta font-medium text-text">
              Password
            </label>
            <Input
              id={passwordId}
              ref={passwordRef}
              type="password"
              autoComplete="current-password"
              value={password}
              invalid={error !== null}
              aria-describedby={error ? `${passwordId}-error` : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {error ? (
            <p id={`${passwordId}-error`} role="alert" className="text-meta text-danger">
              {error}
            </p>
          ) : null}

          <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1">
            Sign in
          </Button>
        </form>

        <p className="mt-4 text-meta text-muted">
          NEXUS works entirely on this computer. Nothing you type here leaves the machine.
        </p>
      </div>
    </div>
  );
}
