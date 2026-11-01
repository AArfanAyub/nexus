/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Topbar — search, notifications, density/theme toggles, user menu (§E.2).
 *
 * The search field is a real `<input>` (so `/` can focus it) that opens the
 * command palette on focus, which keeps one search implementation rather than
 * two. Notification count comes from `notifications.list` and is invalidated by
 * the scheduler's `job:progress` event.
 */

import { Bell, Moon, Rows3, Search, Sun, UserCircle2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Notification } from '@shared/types';

import { invoke } from '../lib/api';
import { relative } from '../lib/format';
import { useQuery } from '../lib/useQuery';
import { useSession, useUi } from '../store';
import { Avatar, IconButton, Kbd, Tooltip } from './ui';

export function Topbar(): JSX.Element {
  const navigate = useNavigate();
  const user = useSession((state) => state.user);
  const theme = useUi((state) => state.theme);
  const toggleTheme = useUi((state) => state.toggleTheme);
  const density = useUi((state) => state.density);
  const toggleDensity = useUi((state) => state.toggleDensity);
  const setPaletteOpen = useUi((state) => state.setPaletteOpen);

  const search = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);

  const notifications = useQuery<readonly Notification[]>(
    'notifications:list',
    () => invoke<readonly Notification[]>('notifications.list', { limit: 20 }),
    { staleMs: 60_000 },
  );

  const unread = (notifications.data ?? []).filter((item) => item.readAt === null).length;

  // `/` focuses search, exactly like the documented keyboard map.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      if (event.key === '/' && !typing) {
        event.preventDefault();
        search.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <header className="flex h-[var(--topbar-h)] items-center gap-3 border-b border-line bg-surface px-3">
      <div className="relative w-80 max-w-[40vw]">
        <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
        <input
          ref={search}
          type="search"
          placeholder="Search everything…"
          aria-label="Search everything"
          onFocus={() => setPaletteOpen(true)}
          className="h-7 w-full rounded-input border border-line-strong bg-surface pl-7 pr-14 text-body text-text placeholder:text-muted"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
          <Kbd>⌘K</Kbd>
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Tooltip label={density === 'compact' ? 'Comfortable rows' : 'Compact rows'}>
          <IconButton label="Toggle row density" onClick={toggleDensity}>
            <Rows3 size={16} aria-hidden="true" />
          </IconButton>
        </Tooltip>

        <Tooltip label={theme === 'light' ? 'Dark theme' : 'Light theme'}>
          <IconButton label="Toggle colour theme" onClick={toggleTheme}>
            {theme === 'light' ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
          </IconButton>
        </Tooltip>

        <div className="relative">
          <IconButton
            label={unread > 0 ? `Notifications, ${String(unread)} unread` : 'Notifications'}
            aria-expanded={bellOpen}
            onClick={() => setBellOpen((open) => !open)}
          >
            <Bell size={16} aria-hidden="true" />
            {unread > 0 ? (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-chip bg-danger" aria-hidden="true" />
            ) : null}
          </IconButton>

          {bellOpen ? (
            <div className="absolute right-0 top-9 z-40 w-80 rounded-card border border-line bg-surface shadow-[var(--shadow-overlay)]">
              <div className="flex items-center justify-between border-b border-line px-3 py-2">
                <p className="text-body font-medium text-text">Notifications</p>
                <button
                  type="button"
                  className="text-meta text-accent hover:underline"
                  onClick={() => {
                    void invoke('notifications.markRead', { all: true })
                      .then(() => notifications.refresh())
                      .catch(() => undefined);
                  }}
                >
                  Mark all read
                </button>
              </div>
              <ul className="max-h-80 overflow-y-auto">
                {(notifications.data ?? []).length === 0 ? (
                  <li className="px-3 py-6 text-center text-meta text-muted">Nothing needs your attention.</li>
                ) : (
                  (notifications.data ?? []).map((item) => (
                    <li key={item.id} className="border-b border-line last:border-0">
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-left hover:bg-surface-2"
                        onClick={() => {
                          setBellOpen(false);
                          if (item.link) navigate(item.link);
                        }}
                      >
                        <p className="text-body text-text">{item.title}</p>
                        <p className="text-meta text-muted">{relative(item.createdAt)}</p>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="relative ml-1">
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-label="Account menu"
            onClick={() => setMenuOpen((open) => !open)}
            className="flex items-center gap-2 rounded-input px-1 py-0.5 hover:bg-surface-2"
          >
            <Avatar name={user?.fullName ?? 'Signed out'} size={24} />
            <span className="hidden max-w-[10rem] truncate text-body text-text md:inline">
              {user?.fullName ?? 'Signed out'}
            </span>
            <UserCircle2 size={14} aria-hidden="true" className="text-muted" />
          </button>

          {menuOpen ? (
            <div className="absolute right-0 top-9 z-40 w-56 rounded-card border border-line bg-surface py-1 shadow-[var(--shadow-overlay)]">
              <p className="px-3 py-1.5 text-meta text-muted">{user?.email ?? user?.username}</p>
              <MenuLink label="Appearance" onClick={() => { setMenuOpen(false); navigate('/settings/appearance'); }} />
              <MenuLink label="Company settings" onClick={() => { setMenuOpen(false); navigate('/settings/company'); }} />
              <MenuLink
                label="Lock now"
                onClick={() => {
                  setMenuOpen(false);
                  void invoke('auth.lock', {}).catch(() => undefined);
                  useUi.getState().setLockOverlay(true);
                }}
              />
              <MenuLink
                label="Sign out"
                onClick={() => {
                  setMenuOpen(false);
                  void invoke('auth.logout', {}).then(() => {
                    useSession.getState().clear();
                    navigate('/login');
                  });
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function MenuLink({ label, onClick }: { readonly label: string; readonly onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left text-body text-text hover:bg-surface-2"
    >
      {label}
    </button>
  );
}
