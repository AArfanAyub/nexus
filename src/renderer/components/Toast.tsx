/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The toast viewport (bottom-right). Reads the imperative store in `lib/toast`
 * and renders it as a polite live region — errors are sticky, so the region is
 * `assertive` only for `error` items via a nested alert.
 *
 * A toast that carries an undo action renders it as a button, not a link: the
 * action is a real mutation, and it gets the same weight as Dismiss. The button
 * is the only reason the 9-second window exists, so it is never hidden behind a
 * hover state.
 */

import clsx from 'clsx';
import { useEffect, useState } from 'react';

import { subscribeToasts, toast, type ToastRecord } from '../lib/toast';

const TONES: Record<ToastRecord['tone'], string> = {
  success: 'border-l-success',
  error: 'border-l-danger',
  warning: 'border-l-warning',
  info: 'border-l-accent',
};

export function ToastViewport(): JSX.Element {
  const [items, setItems] = useState<readonly ToastRecord[]>([]);
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => subscribeToasts(setItems), []);

  async function runUndo(item: ToastRecord): Promise<void> {
    if (!item.action) return;
    setRunning(item.id);
    try {
      await item.action.run();
    } finally {
      setRunning(null);
      toast.dismiss(item.id);
    }
  }

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2"
      aria-live="polite"
      aria-atomic="false"
    >
      {items.map((item) => (
        <div
          key={item.id}
          role={item.tone === 'error' ? 'alert' : 'status'}
          className={clsx(
            'pointer-events-auto rounded-card border border-line border-l-2 bg-surface px-3 py-2',
            'shadow-[var(--shadow-overlay)]',
            TONES[item.tone],
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-body font-medium text-text">{item.title}</p>
              {item.body ? <p className="mt-0.5 text-meta text-muted">{item.body}</p> : null}
              {item.action ? (
                <button
                  type="button"
                  disabled={running === item.id}
                  onClick={() => void runUndo(item)}
                  className="mt-1.5 rounded-control border border-line-strong px-2 py-0.5 text-meta font-medium text-text transition-colors duration-fast hover:bg-surface-2 disabled:opacity-50"
                >
                  {running === item.id ? 'Undoing…' : item.action.label}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => toast.dismiss(item.id)}
              className="shrink-0 rounded-input px-1 text-meta text-muted hover:text-text"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
