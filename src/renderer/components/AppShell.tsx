/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * AppShell — the frame every authenticated page renders inside (§E.2).
 *
 * Landmarks: `nav` (Sidebar), `main` (content, `id="main"`), `aside` (Drawer).
 * The skip link is the **first** focusable node in the document, so one `Tab`
 * from the address bar reaches it (T03 acceptance #10).
 *
 * The shell also owns the global shortcuts that are not list-specific: `Ctrl/Cmd+K`
 * for the palette, `g`-prefixed navigation, and the `app:lock` event from main.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';

import { onMainEvent } from '../lib/api';
import { toast } from '../lib/toast';
import { useSession, useUi } from '../store';
import { CommandPalette } from './CommandPalette';
import { LockScreen } from './LockScreen';
import { ShortcutSheet } from './ShortcutSheet';
import { Sidebar } from './Sidebar';
import { ToastViewport } from './Toast';
import { Topbar } from './Topbar';
import { OverlayProvider, useOverlayDepth } from './ui';

const FAVOURITES_KEY = 'nexus.favourites';

function readFavourites(): string[] {
  try {
    const raw = window.localStorage.getItem(FAVOURITES_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export interface AppShellProps {
  readonly children?: ReactNode;
}

export function AppShell({ children }: AppShellProps): JSX.Element {
  return (
    <OverlayProvider>
      <ShellBody>{children}</ShellBody>
    </OverlayProvider>
  );
}

function ShellBody({ children }: AppShellProps): JSX.Element {
  const navigate = useNavigate();
  const overlayDepth = useOverlayDepth();
  const setLockOverlay = useUi((state) => state.setLockOverlay);
  const setLocked = useSession((state) => state.setLocked);
  const [favourites, setFavourites] = useState<string[]>(readFavourites);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const toggleFavourite = useCallback((path: string) => {
    setFavourites((current) => {
      const next = current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path];
      try {
        window.localStorage.setItem(FAVOURITES_KEY, JSON.stringify(next));
      } catch {
        // Favourites are a convenience; losing them must not break the shell.
      }
      return next;
    });
  }, []);

  // Main-process events: a lock arrives from the idle timer, not from the UI.
  useEffect(() => {
    const offLock = onMainEvent('app:lock', () => {
      setLocked(true);
      setLockOverlay(true);
    });
    const offToast = onMainEvent('app:toast', (payload) => {
      const record = (payload ?? {}) as { tone?: string; title?: string; body?: string };
      const title = record.title ?? 'Notice';
      if (record?.tone === 'error') toast.error(title, record.body);
      else if (record?.tone === 'success') toast.success(title, record.body);
      else toast.info(title, record.body);
    });
    return () => {
      offLock();
      offToast();
    };
  }, [setLocked, setLockOverlay]);

  // Global keyboard map (§E.6). Overlays win, and inputs keep their own keys.
  useEffect(() => {
    let awaitingG = false;
    let gTimer: ReturnType<typeof setTimeout> | null = null;

    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        useUi.getState().setPaletteOpen(true);
        return;
      }

      if (typing || overlayDepth > 0) return;

      // `/` focuses the page's search box, the way every list-heavy tool does.
      // It has to come before the `g` chord so a stray slash never starts one.
      if (event.key === '/') {
        const search = document.querySelector<HTMLInputElement>('[data-search-input]');
        if (search) {
          event.preventDefault();
          search.focus();
          search.select();
          return;
        }
      }

      // `?` is the shortcut sheet. Shift+/ on a US layout, so match the char.
      if (event.key === '?') {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      if (awaitingG) {
        awaitingG = false;
        if (gTimer) clearTimeout(gTimer);
        const routes: Record<string, string> = {
          d: '/dashboard',
          f: '/finance/invoices',
          i: '/inventory/products',
          c: '/crm/deals',
          s: '/settings/company',
          ',': '/settings/company',
        };
        const to = routes[event.key.toLowerCase()];
        if (to) {
          event.preventDefault();
          navigate(to);
        }
        return;
      }

      if (event.key.toLowerCase() === 'g') {
        awaitingG = true;
        gTimer = setTimeout(() => {
          awaitingG = false;
        }, 900);
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (gTimer) clearTimeout(gTimer);
    };
  }, [navigate, overlayDepth]);

  return (
    <div className="grid h-full grid-cols-[auto_minmax(0,1fr)] grid-rows-[var(--topbar-h)_minmax(0,1fr)]">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <div className="row-span-2 min-h-0">
        <Sidebar favourites={favourites} onToggleFavourite={toggleFavourite} />
      </div>

      <Topbar />

      <main id="main" tabIndex={-1} className="min-h-0 overflow-hidden">
        {children ?? <Outlet />}
      </main>

      <LockScreen />
      <CommandPalette />
      <ShortcutSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <ToastViewport />
    </div>
  );
}
