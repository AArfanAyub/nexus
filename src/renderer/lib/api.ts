/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The only way the renderer talks to the main process (CONVENTIONS §13).
 *
 * `invoke` unwraps `ApiResult<T>`: a success returns `data`, a failure throws a
 * typed `ApiError` carrying `.code`. Callers therefore never branch on
 * `result.ok` and can never accidentally render an error object as data.
 */

import type { Channel } from '@shared/channels';
import type { ErrorCode, NexusError } from '@shared/types';

/** A failure the user can be told about. `.code` drives the UI's reaction. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(error: NexusError) {
    super(error.message);
    this.name = 'ApiError';
    this.code = error.code;
    this.details = error.details as Readonly<Record<string, unknown>> | undefined;
  }
}

/** True when `value` is an `ApiError` (works across module boundaries). */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError || (value instanceof Error && value.name === 'ApiError');
}

function bridge(): Window['nexus'] {
  if (typeof window === 'undefined' || !window.nexus) {
    throw new ApiError({
      code: 'INTERNAL',
      message: 'The application bridge is not available. Restart NEXUS.',
    });
  }
  return window.nexus;
}

/**
 * Calls one channel and returns its payload.
 *
 * @throws ApiError when the main process refuses the call or the handler fails.
 */
export async function invoke<T>(channel: Channel, payload: unknown = {}): Promise<T> {
  const result = await bridge().invoke<T>(channel, payload);
  if (!result || typeof result !== 'object') {
    throw new ApiError({ code: 'INTERNAL', message: 'The application returned an empty response.' });
  }
  if (result.ok) return result.data;
  throw new ApiError(result.error);
}

/** Subscribe to a main-process event. Returns an unsubscribe function. */
export function onMainEvent(
  event: 'app:lock' | 'app:toast' | 'job:progress',
  listener: (payload: unknown) => void,
): () => void {
  if (typeof window === 'undefined' || !window.nexus) return () => undefined;
  return window.nexus.on(event, listener);
}

/** The Electron version string, shown in Settings → System. */
export function appVersion(): string {
  return typeof window !== 'undefined' && window.nexus ? window.nexus.version : 'dev';
}

/** `win32` | `darwin` | `linux` — used for shortcut hints only. */
export function platform(): string {
  return typeof window !== 'undefined' && window.nexus ? window.nexus.platform : 'web';
}
