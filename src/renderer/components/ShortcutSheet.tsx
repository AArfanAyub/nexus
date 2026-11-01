/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Shortcut sheet (R2) — `?`.
 *
 * One list, generated from data, so a shortcut cannot exist without appearing
 * here. The sheet is read-only and closes on `Esc`, `?` or a click outside, and
 * it is deliberately a modal rather than a route: a user who opened it did not
 * navigate away from what they were doing.
 *
 * The inverse rule matters more than this one: **every entry below is bound
 * somewhere in the app.** A sheet that lists a key nobody implemented is worse
 * than no sheet, because the user concludes the app is broken rather than the
 * documentation.
 */

import { useEffect, useRef } from 'react';

import { useOverlayRegistration } from './ui';

interface Shortcut {
  readonly keys: string;
  readonly label: string;
}

interface Group {
  readonly title: string;
  readonly items: readonly Shortcut[];
}

const GROUPS: readonly Group[] = [
  {
    title: 'Everywhere',
    items: [
      { keys: '⌘K', label: 'Open the command palette' },
      { keys: '/', label: 'Focus the search box' },
      { keys: '?', label: 'Show this sheet' },
      { keys: 'Esc', label: 'Close the topmost panel' },
    ],
  },
  {
    title: 'Go to',
    items: [
      { keys: 'g then d', label: 'Dashboard' },
      { keys: 'g then f', label: 'Invoices' },
      { keys: 'g then i', label: 'Products' },
      { keys: 'g then c', label: 'Deals' },
      { keys: 'g then s', label: 'Company settings' },
      { keys: 'g then ,', label: 'Company settings' },
    ],
  },
  {
    title: 'Lists',
    items: [
      { keys: '↓ ↑', label: 'Move between rows' },
      { keys: 'Space', label: 'Peek at the row' },
      { keys: '↵', label: 'Open the record' },
      { keys: 'x', label: 'Select the row' },
    ],
  },
  {
    title: 'Documents',
    items: [
      { keys: '⌘S', label: 'Save the draft' },
      { keys: '⌘↵', label: 'Post the document' },
      { keys: 'Tab', label: 'Move across the cells' },
    ],
  },
  {
    title: 'Command palette',
    items: [
      { keys: '↑ ↓', label: 'Move between results' },
      { keys: '↵', label: 'Open the highlighted result' },
      { keys: 'Esc', label: 'Close the palette' },
    ],
  },
];

export interface ShortcutSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ShortcutSheet({ open, onOpenChange }: ShortcutSheetProps): JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null);
  useOverlayRegistration(open);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault();
        event.stopPropagation();
        onOpenChange(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6 pt-[10vh]">
      <div className="fixed inset-0 bg-[var(--overlay)]" onClick={() => onOpenChange(false)} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="relative w-full max-w-2xl rounded-panel border border-line bg-surface shadow-popover"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <h2 className="text-title font-semibold text-text">Keyboard shortcuts</h2>
            <p className="mt-0.5 text-meta text-muted">Everything in NEXUS is reachable without a mouse.</p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-input px-2 py-1 text-meta text-muted hover:bg-surface-2 hover:text-text"
          >
            Close
          </button>
        </header>

        <div className="grid grid-cols-1 gap-6 px-5 py-4 md:grid-cols-3">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="micro">{group.title}</h3>
              <dl className="mt-2 space-y-1.5">
                {group.items.map((item) => (
                  <div key={item.keys} className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0">
                      <kbd className="rounded-input border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-text">
                        {item.keys}
                      </kbd>
                    </dt>
                    <dd className="text-right text-meta text-muted">{item.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <footer className="border-t border-line px-5 py-2 text-meta text-muted">
          Press <kbd className="font-mono">?</kbd> again to close.
        </footer>
      </div>
    </div>
  );
}
