/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Imperative toasts (ARCHITECTURE §E.5).
 *
 * `toast.error` is **sticky**: an error the user never saw is an error they will
 * report as a bug. Successes fade after 4 s. At most four are stacked; the
 * oldest is dropped first so the newest (usually the actionable one) survives.
 * The store is deliberately outside React so `api.ts` callers can toast without
 * a hook.
 */

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

/**
 * An undo action attached to a toast.
 *
 * It exists so a destructive action does not have to be irreversible. The rule is
 * that the label must describe something the app can *actually* do: archiving a
 * product is reversible (`entity.restore` clears the flag), voiding a posted
 * invoice is not (a reversing entry was written), so only the first offers undo.
 */
export interface ToastAction {
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

export interface ToastRecord {
  readonly id: string;
  readonly tone: ToastTone;
  readonly title: string;
  readonly body?: string;
  /** Set for `error`: the toast stays until dismissed. */
  readonly sticky: boolean;
  readonly action?: ToastAction;
  readonly createdAt: number;
}

const MAX_VISIBLE = 4;
const AUTO_DISMISS_MS = 4000;
/** Longer, because an undo needs time to be read and acted on. */
const UNDO_DISMISS_MS = 9000;

let counter = 0;
let toasts: readonly ToastRecord[] = [];
const listeners = new Set<(next: readonly ToastRecord[]) => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

function dismiss(id: string): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}

function push(tone: ToastTone, title: string, body?: string, action?: ToastAction): string {
  counter += 1;
  const id = `toast-${String(counter)}`;
  const sticky = tone === 'error';
  const next: ToastRecord = { id, tone, title, body, sticky, action, createdAt: Date.now() };

  // Newest first, then keep the window small.
  toasts = [next, ...toasts].slice(0, MAX_VISIBLE);
  emit();

  if (!sticky) {
    // An undo window is longer than a plain acknowledgement: four seconds is not
    // enough time to read a sentence, decide, and move the pointer.
    timers.set(
      id,
      setTimeout(() => dismiss(id), action ? UNDO_DISMISS_MS : AUTO_DISMISS_MS),
    );
  }
  return id;
}

/** The imperative API. Also exposed as `toast.success(...)` etc. */
export const toast = {
  success(title: string, body?: string): string {
    return push('success', title, body);
  },
  error(title: string, body?: string): string {
    return push('error', title, body);
  },
  info(title: string, body?: string): string {
    return push('info', title, body);
  },
  warning(title: string, body?: string): string {
    return push('warning', title, body);
  },
  /**
   * A success with an undo button. The action runs and the toast closes; a
   * failure inside the action is the caller's problem to report, so the promise
   * is awaited here only to close the toast at the right moment.
   */
  undoable(title: string, body: string, action: ToastAction): string {
    return push('success', title, body, action);
  },
  dismiss,
  dismissAll(): void {
    for (const id of [...timers.keys()]) dismiss(id);
    toasts = [];
    emit();
  },
};

/** Subscribe to the stack. Returns an unsubscribe function. */
export function subscribeToasts(listener: (next: readonly ToastRecord[]) => void): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => listeners.delete(listener);
}

/** Current stack, for tests and the `aria-live` region. */
export function currentToasts(): readonly ToastRecord[] {
  return toasts;
}
