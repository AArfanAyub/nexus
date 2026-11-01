/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The two Zustand stores (ARCHITECTURE §E.5).
 *
 *   `useSession` — who is signed in and what they may do. Written once at
 *                 bootstrap and cleared on logout. **Never holds rows.**
 *   `useUi`      — theme, density, accent, sidebar, palette, lock. Persisted to
 *                 `users.prefs_json` through a debounced `app.prefs.save`.
 *
 * Keeping them apart is what stops a theme toggle from re-rendering a table.
 */

import { create } from 'zustand';

import type { Permission } from '@shared/permissions';
import type { BootstrapResult, Company, LicenseStatus, User, UserPrefs } from '@shared/types';

import { invoke } from '../lib/api';

// ── session ──────────────────────────────────────────────────────────────────

export interface SessionState {
  readonly ready: boolean;
  readonly needsOnboarding: boolean;
  readonly user: User | null;
  readonly permissions: ReadonlySet<Permission>;
  readonly company: Company | null;
  readonly license: LicenseStatus | null;
  readonly modules: readonly string[];
  readonly suspectClock: boolean;
  readonly platform: string;
  readonly version: string;
  readonly locked: boolean;
  readonly idleTimeoutMin: number;
  readonly licenseNoticeDismissed: boolean;

  applyBootstrap(result: BootstrapResult): void;
  setLocked(locked: boolean): void;
  setUser(user: User | null, permissions: readonly Permission[]): void;
  can(permission: Permission | null): boolean;
  clear(): void;
}

const EMPTY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>();

export const useSession = create<SessionState>((set, get) => ({
  ready: false,
  needsOnboarding: true,
  user: null,
  permissions: EMPTY_PERMISSIONS,
  company: null,
  license: null,
  modules: [],
  suspectClock: false,
  platform: 'web',
  version: '0.0.0',
  locked: false,
  idleTimeoutMin: 15,
  licenseNoticeDismissed: false,

  applyBootstrap(result) {
    set({
      ready: true,
      needsOnboarding: result.needsOnboarding,
      user: result.user,
      permissions: new Set(result.permissions),
      company: result.company,
      license: result.license,
      modules: result.modules,
      suspectClock: result.suspectClock,
      platform: result.platform,
      version: result.version,
      locked: result.session.locked,
      idleTimeoutMin: result.session.idleTimeoutMin,
      licenseNoticeDismissed: result.prefs.licenseNoticeDismissed === true,
    });
  },

  setLocked(locked) {
    set({ locked });
  },

  setUser(user, permissions) {
    set({ user, permissions: new Set(permissions) });
  },

  can(permission) {
    if (permission === null) return true;
    return get().permissions.has(permission);
  },

  clear() {
    set({
      ready: true,
      user: null,
      permissions: EMPTY_PERMISSIONS,
      locked: false,
    });
  },
}));

// ── UI prefs ─────────────────────────────────────────────────────────────────

export type ThemeName = 'light' | 'dark';
export type DensityName = 'compact' | 'comfortable';
export type AccentName = 'blue' | 'teal' | 'violet' | 'amber';

export interface UiState {
  readonly theme: ThemeName;
  readonly density: DensityName;
  readonly accent: AccentName;
  readonly sidebarCollapsed: boolean;
  readonly paletteOpen: boolean;
  readonly lockOverlay: boolean;
  readonly licenseNoticeDismissed: boolean;

  hydrate(prefs: UserPrefs): void;
  setTheme(theme: ThemeName): void;
  toggleTheme(): void;
  setDensity(density: DensityName): void;
  toggleDensity(): void;
  setAccent(accent: AccentName): void;
  setSidebarCollapsed(collapsed: boolean): void;
  toggleSidebar(): void;
  setPaletteOpen(open: boolean): void;
  setLockOverlay(open: boolean): void;
  dismissLicenseNotice(): void;
}

/** Applies the theme/density/accent to `<html>` so CSS variables switch. */
function applyToDocument(state: Pick<UiState, 'theme' | 'density' | 'accent'>): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset['theme'] = state.theme;
  root.dataset['density'] = state.density;
  root.dataset['accent'] = state.accent;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: UserPrefs = {};

/** Debounced write of the UI prefs. One IPC call per burst of toggles. */
function persist(patch: UserPrefs): void {
  pending = { ...pending, ...patch };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const payload = pending;
    pending = {};
    saveTimer = null;
    void invoke('app.prefs.save', payload).catch(() => undefined);
  }, 250);
}

export const useUi = create<UiState>((set, get) => ({
  theme: 'light',
  density: 'comfortable',
  accent: 'blue',
  sidebarCollapsed: false,
  paletteOpen: false,
  lockOverlay: false,
  licenseNoticeDismissed: false,

  hydrate(prefs) {
    const next = {
      theme: prefs.theme ?? 'light',
      density: prefs.density ?? 'comfortable',
      accent: prefs.accent ?? 'blue',
      sidebarCollapsed: prefs.sidebarCollapsed === true,
      licenseNoticeDismissed: prefs.licenseNoticeDismissed === true,
    };
    set(next);
    applyToDocument(next);
  },

  setTheme(theme) {
    set({ theme });
    applyToDocument({ ...get(), theme });
    persist({ theme });
  },

  toggleTheme() {
    get().setTheme(get().theme === 'light' ? 'dark' : 'light');
  },

  setDensity(density) {
    set({ density });
    applyToDocument({ ...get(), density });
    persist({ density });
  },

  toggleDensity() {
    get().setDensity(get().density === 'compact' ? 'comfortable' : 'compact');
  },

  setAccent(accent) {
    set({ accent });
    applyToDocument({ ...get(), accent });
    persist({ accent });
  },

  setSidebarCollapsed(sidebarCollapsed) {
    set({ sidebarCollapsed });
    persist({ sidebarCollapsed });
  },

  toggleSidebar() {
    get().setSidebarCollapsed(!get().sidebarCollapsed);
  },

  setPaletteOpen(paletteOpen) {
    set({ paletteOpen });
  },

  setLockOverlay(lockOverlay) {
    set({ lockOverlay });
  },

  dismissLicenseNotice() {
    set({ licenseNoticeDismissed: true });
    persist({ licenseNoticeDismissed: true });
  },
}));
