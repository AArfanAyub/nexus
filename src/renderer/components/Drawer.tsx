/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Drawer — the right-hand peek panel (ARCHITECTURE §E.4).
 *
 * The critical property (T03 acceptance #6) is that opening a Drawer must **not
 * unmount the route underneath**: it is a sibling overlay, so a half-typed form
 * is still there when the peek closes. Focus is trapped while open and returned
 * to the row that opened it (`returnFocusTo`).
 */

import clsx from 'clsx';
import { useEffect, useId, useRef, type ReactNode } from 'react';

import type { StatusChipSpec } from '@shared/types';

import { Badge, IconButton, useFocusTrap, useOverlayRegistration } from './ui';

export interface DrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly subtitle?: string;
  readonly status?: StatusChipSpec;
  /** Panel width in px. Default 420. */
  readonly width?: number;
  readonly footer?: ReactNode;
  readonly returnFocusTo?: HTMLElement | null;
  readonly children: ReactNode;
}

export function Drawer({
  open,
  onOpenChange,
  title,
  subtitle,
  status,
  width = 420,
  footer,
  returnFocusTo,
  children,
}: DrawerProps): JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null);
  const aside = useRef<HTMLElement>(null);
  const titleId = useId();

  useFocusTrap(open, panel);
  useOverlayRegistration(open);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onOpenChange(false);
        // Explicit restore, because the row may have been re-rendered.
        returnFocusTo?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange, returnFocusTo]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40">
      <div
        className="absolute inset-0 bg-[var(--overlay)]"
        onClick={() => {
          onOpenChange(false);
          returnFocusTo?.focus();
        }}
        aria-hidden="true"
      />
      <aside
        ref={aside}
        aria-label={title}
        className={clsx(
          'absolute right-0 top-0 flex h-full flex-col border-l border-line bg-surface',
          'shadow-[var(--shadow-overlay)]',
        )}
        style={{ width }}
      >
        <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="flex h-full flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <h2 id={titleId} className="truncate text-body font-semibold text-text">
                {title}
              </h2>
              {subtitle ? <p className="mt-0.5 truncate text-meta text-muted">{subtitle}</p> : null}
              {status ? (
                <div className="mt-2">
                  <Badge status={status.status} label={status.label} />
                </div>
              ) : null}
            </div>
            <IconButton
              label="Close panel"
              onClick={() => {
                onOpenChange(false);
                returnFocusTo?.focus();
              }}
            >
              <span aria-hidden="true">✕</span>
            </IconButton>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>

          {footer ? <footer className="border-t border-line px-4 py-3">{footer}</footer> : null}
        </div>
      </aside>
    </div>
  );
}
