/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Modal (ARCHITECTURE §E.4).
 *
 * `confirmText` switches it into typed-confirmation mode, which is what every
 * destructive action uses: the primary button stays disabled until the operator
 * types the word. Focus is trapped, `Esc` closes (unless a destructive confirm
 * is pending and busy), and focus returns to the trigger.
 */

import clsx from 'clsx';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Button, IconButton, Input, useFocusTrap, useOverlayRegistration } from './ui';

export interface ModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly size?: 'sm' | 'md' | 'lg' | 'xl';
  readonly footer?: ReactNode;
  /** When set, the operator must type this word to confirm. */
  readonly confirmText?: string;
  readonly destructive?: boolean;
  readonly busy?: boolean;
  /** Called by the default footer’s primary button. */
  readonly onConfirm?: () => void;
  readonly children?: ReactNode;
}

const WIDTHS: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  footer,
  confirmText,
  destructive = false,
  busy = false,
  onConfirm,
  children,
}: ModalProps): JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [typed, setTyped] = useState('');

  useFocusTrap(open, panel);
  useOverlayRegistration(open);

  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation();
        onOpenChange(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onOpenChange]);

  if (!open) return null;

  const confirmSatisfied = !confirmText || typed.trim().toLowerCase() === confirmText.toLowerCase();

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6 pt-[10vh]">
      <div
        className="fixed inset-0 bg-[var(--overlay)]"
        onClick={() => (busy ? undefined : onOpenChange(false))}
        aria-hidden="true"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={clsx(
          'relative w-full rounded-card border border-line bg-surface shadow-[var(--shadow-overlay)]',
          WIDTHS[size],
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-body font-semibold text-text">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-0.5 text-meta text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label="Close" onClick={() => onOpenChange(false)} disabled={busy}>
            <span aria-hidden="true">✕</span>
          </IconButton>
        </header>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-4">
          {children}
          {confirmText ? (
            <div className="mt-4">
              <label htmlFor={`${titleId}-confirm`} className="text-meta text-muted">
                Type <strong className="text-text">{confirmText}</strong> to continue
              </label>
              <Input
                id={`${titleId}-confirm`}
                value={typed}
                autoComplete="off"
                onChange={(event) => setTyped(event.target.value)}
                className="mt-1"
              />
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          {footer ?? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant={destructive ? 'danger' : 'primary'}
                disabled={!confirmSatisfied}
                loading={busy}
                onClick={() => (onConfirm ? onConfirm() : onOpenChange(false))}
              >
                Continue
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
