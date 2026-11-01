/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The shape of `window.nexus`, as exposed by `src/preload/index.ts`.
 * The renderer has no other way to reach the system: no `require`, no `fs`,
 * no `ipcRenderer` (CONVENTIONS §13).
 */

import type { ApiResult } from '@shared/types';

export interface NexusBridge {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<ApiResult<T>>;
  on(event: 'app:lock' | 'app:toast' | 'job:progress', listener: (payload: unknown) => void): () => void;
  readonly platform: string;
  readonly version: string;
}

declare global {
  interface Window {
    readonly nexus: NexusBridge;
  }
}
