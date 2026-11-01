/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Form field scaffolding (ARCHITECTURE §E.4).
 *
 * `Field` owns the label/`*`/error wiring: the error is a real element with an
 * id, and the control gets `aria-describedby` pointing at it. `MoneyInput` is
 * the only component allowed to turn typed text into cents, and it delegates
 * that to `parseCents` so no float ever touches a stored amount.
 */

import clsx from 'clsx';
import { useEffect, useId, useState, type ReactNode } from 'react';

import { formatCents, parseCents, type Cents } from '@shared/money';

export interface FieldProps {
  readonly label: string;
  readonly required?: boolean;
  readonly error?: string;
  readonly hint?: string;
  /** The id of the control this label belongs to. */
  readonly htmlFor: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Field({ label, required = false, error, hint, htmlFor, children, className }: FieldProps): JSX.Element {
  const hintId = `${htmlFor}-hint`;
  const errorId = `${htmlFor}-error`;
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-meta font-medium text-text">
        {label}
        {required ? (
          <span className="ml-0.5 text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
        {required ? <span className="sr-only"> (required)</span> : null}
      </label>
      {children}
      {hint && !error ? (
        <p id={hintId} className="text-meta text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-meta text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The `aria-describedby` a control should carry for a given field id. */
export function describedBy(htmlFor: string, hasHint: boolean, hasError: boolean): string | undefined {
  const ids = [hasError ? `${htmlFor}-error` : null, hasHint && !hasError ? `${htmlFor}-hint` : null].filter(
    (value): value is string => value !== null,
  );
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export interface FormGridProps {
  readonly columns?: 1 | 2 | 3;
  readonly children: ReactNode;
  readonly className?: string;
}

export function FormGrid({ columns = 2, children, className }: FormGridProps): JSX.Element {
  return (
    <div
      className={clsx(
        'grid gap-4',
        columns === 1 && 'grid-cols-1',
        columns === 2 && 'grid-cols-1 md:grid-cols-2',
        columns === 3 && 'grid-cols-1 md:grid-cols-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface MoneyInputProps {
  readonly valueCents: number | null;
  readonly onChange: (value: number | null) => void;
  readonly currency: string;
  readonly allowNegative?: boolean;
  readonly id: string;
  readonly disabled?: boolean;
  readonly onBlur?: () => void;
  readonly placeholder?: string;
  readonly invalid?: boolean;
}

/**
 * A text input that stores integer cents.
 *
 * It keeps the raw string while the user types (so `12.` is not destroyed) and
 * converts on blur. `parseCents` throws on nonsense, which becomes a local error
 * rather than a silent zero.
 */
export function MoneyInput({
  valueCents,
  onChange,
  currency,
  allowNegative = false,
  id,
  disabled = false,
  onBlur,
  placeholder,
  invalid = false,
}: MoneyInputProps): JSX.Element {
  const [text, setText] = useState<string>(() =>
    valueCents === null ? '' : (valueCents / 100).toFixed(2),
  );
  const [error, setError] = useState<string | null>(null);
  const errorId = `${id}-money-error`;

  useEffect(() => {
    setText(valueCents === null ? '' : (valueCents / 100).toFixed(2));
  }, [valueCents]);

  function commit(): void {
    const trimmed = text.trim();
    if (trimmed === '') {
      setError(null);
      onChange(null);
      onBlur?.();
      return;
    }
    try {
      const cents = parseCents(trimmed);
      if (!allowNegative && cents < 0) {
        setError('Enter a positive amount.');
        return;
      }
      setError(null);
      onChange(cents);
    } catch {
      setError(`Enter an amount such as ${formatCents(123456 as Cents, currency)}.`);
    } finally {
      onBlur?.();
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <input
          id={id}
          inputMode="decimal"
          value={text}
          disabled={disabled}
          placeholder={placeholder ?? '0.00'}
          aria-invalid={invalid || error !== null || undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
          className={clsx(
            'h-[var(--control-h)] w-full rounded-input border bg-surface px-2 pr-12 text-right text-body',
            'tnum text-text placeholder:text-muted',
            error || invalid ? 'border-danger' : 'border-line-strong',
          )}
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-meta text-muted">
          {currency}
        </span>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-meta text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A labelled read-only value, used in detail panes. */
export function ReadOnly({ label, value }: { readonly label: string; readonly value: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-meta text-muted">{label}</span>
      <span className="text-body text-text">{value}</span>
    </div>
  );
}

/**
 * Tracks whether a form has unsaved changes and warns before leaving.
 * Kept tiny on purpose: the builder owns the state, this only compares.
 */
export function useDirtyGuard(dirty: boolean, onAttempt: () => boolean): void {
  const id = useId();
  useEffect(() => {
    if (!dirty) return undefined;
    function beforeUnload(event: BeforeUnloadEvent): void {
      if (!onAttempt()) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, onAttempt, id]);
}
