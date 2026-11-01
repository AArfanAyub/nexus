/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The one and only bridge between the sandboxed renderer and the main process.
 *
 * `sandbox: true` means this file is bundled into a single CommonJS module by
 * `vite.preload.config.ts` — a sandboxed preload can only `require('electron')`,
 * so importing `CHANNELS` has to be inlined at build time.
 *
 * The allow-list is compiled in. A channel that is not in `CHANNELS` is
 * rejected HERE, before `ipcRenderer.invoke` is ever called (T02 acceptance #2).
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { CHANNELS, INVOKE_MESSAGE, MAIN_EVENTS } from '../shared/channels';

const ALLOWED: ReadonlySet<string> = new Set<string>(CHANNELS);
const EVENTS: ReadonlySet<string> = new Set<string>(MAIN_EVENTS);

const api = {
  /**
   * Invokes a main-process channel. Rejects locally for a channel outside the
   * allow-list so a compromised renderer cannot even probe the main process.
   */
  invoke: (channel: string, payload: unknown = {}): Promise<unknown> => {
    if (typeof channel !== 'string' || !ALLOWED.has(channel)) {
      return Promise.reject(new Error(`Blocked IPC channel: ${String(channel)}`));
    }
    return ipcRenderer.invoke(INVOKE_MESSAGE, { channel, payload });
  },

  /** Subscribes to a main → renderer event. Returns an unsubscribe function. */
  on: (event: string, listener: (payload: unknown) => void): (() => void) => {
    if (!EVENTS.has(event)) throw new Error(`Blocked event: ${String(event)}`);
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
      listener(payload);
    };
    ipcRenderer.on(event, wrapped);
    return () => {
      ipcRenderer.removeListener(event, wrapped);
    };
  },

  platform: process.platform,
  /** Electron runtime version; the app version arrives in `app.bootstrap`. */
  version: process.versions.electron ?? '0.0.0',
};

contextBridge.exposeInMainWorld('nexus', api);
