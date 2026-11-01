/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The primitive kit (ARCHITECTURE §E.4). Hand-rolled on purpose: no component
 * library, `clsx` is the only helper.
 *
 * House rules enforced here:
 *   - colours come from token utilities (`bg-surface`, `text-muted`, `border-line`),
 *     never from a hex literal or an inline `style={{ color }}`;
 *   - every interactive element is a real `<button>`/`<input>`/`<select>`, so the
 *     2px focus ring from `index.css` appears without extra work;
 *   - `aria-*` is set on the element that actually owns the behaviour.
 */

import clsx from 'clsx';
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

// ── Button ───────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-input font-medium transition-colors ' +
  'duration-fast disabled:opacity-50 disabled:cursor-not-allowed select-none whitespace-nowrap';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-inverse hover:bg-accent-hover',
  secondary: 'bg-surface text-text border border-line-strong hover:bg-surface-2',
  ghost: 'bg-transparent text-text hover:bg-surface-2',
  danger: 'bg-danger text-inverse hover:opacity-90',
  quiet: 'bg-transparent text-muted hover:text-text hover:bg-surface-2',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-meta',
  md: 'h-8 px-3 text-body',
  lg: 'h-10 px-4 text-body',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly iconLeft?: ReactNode;
  readonly iconRight?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, iconLeft, iconRight, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={clsx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      {...rest}
    >
      {loading ? <Spinner /> : iconLeft}
      {children}
      {iconRight}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control must have an accessible name. */
  readonly label: string;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', size = 'md', className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      aria-label={label}
      title={label}
      className={clsx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], 'aspect-square px-0', className)}
      {...rest}
    >
      {children}
    </button>
  );
});

/** The indeterminate spinner used inside buttons and skeletons. */
export function Spinner({ size = 14 }: { readonly size?: number }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-block animate-spin rounded-chip border-2 border-current border-t-transparent"
      style={{ width: size, height: size }}
    />
  );
}

// ── inputs ───────────────────────────────────────────────────────────────────

const CONTROL =
  'w-full rounded-input border bg-surface px-2 text-body text-text placeholder:text-muted ' +
  'transition-colors duration-fast disabled:opacity-60 disabled:cursor-not-allowed';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={clsx(CONTROL, invalid ? 'border-danger' : 'border-line-strong', 'h-[var(--control-h)]', className)}
      {...rest}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly invalid?: boolean;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid = false, options, placeholder, className, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={clsx(CONTROL, invalid ? 'border-danger' : 'border-line-strong', 'h-[var(--control-h)]', className)}
      {...rest}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 3, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={clsx(CONTROL, 'border-line-strong py-2', className)}
        {...rest}
      />
    );
  },
);

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  readonly label: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className, ...rest },
  ref,
) {
  return (
    <label className={clsx('inline-flex items-center gap-2 text-body text-text', className)}>
      <input ref={ref} type="checkbox" className="h-4 w-4 rounded-input border-line-strong accent-[var(--accent)]" {...rest} />
      <span>{label}</span>
    </label>
  );
});

export interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export function Switch({ checked, onChange, label, description, disabled = false }: SwitchProps): JSX.Element {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-body text-text">
          {label}
        </label>
        {description ? <p className="mt-1 text-meta text-muted">{description}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative h-5 w-9 shrink-0 rounded-chip transition-colors duration-fast',
          checked ? 'bg-accent' : 'bg-surface-3',
          disabled && 'opacity-50',
        )}
      >
        <span
          className={clsx(
            'absolute top-0.5 h-4 w-4 rounded-chip bg-surface transition-transform duration-fast',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

// ── status & data display ────────────────────────────────────────────────────

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-surface-2 text-info border-transparent',
};

export interface ChipProps {
  readonly tone?: Tone;
  readonly children: ReactNode;
  readonly className?: string;
  readonly title?: string;
}

export function Chip({ tone = 'neutral', children, className, title }: ChipProps): JSX.Element {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1 rounded-chip border px-2 py-0.5 text-meta leading-5',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A status chip whose tone is derived from the status word. */
export function Badge({ status, label }: { readonly status: string; readonly label?: string }): JSX.Element {
  const tone: Tone =
    status === 'paid' || status === 'posted' || status === 'won' || status === 'active'
      ? 'success'
      : status === 'partially_paid' || status === 'pending' || status === 'low'
        ? 'warning'
        : status === 'overdue' || status === 'void' || status === 'lost' || status === 'disabled'
          ? 'danger'
          : status === 'draft'
            ? 'neutral'
            : 'accent';
  return <Chip tone={tone}>{label ?? status.replace(/_/g, ' ')}</Chip>;
}

export interface TabsProps<T extends string> {
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly items: readonly { readonly value: T; readonly label: string; readonly count?: number }[];
  readonly ariaLabel: string;
}

export function Tabs<T extends string>({ value, onChange, items, ariaLabel }: TabsProps<T>): JSX.Element {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex items-center gap-1 border-b border-line">
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={clsx(
              'relative -mb-px border-b-2 px-3 py-2 text-body transition-colors duration-fast',
              active ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text',
            )}
          >
            {item.label}
            {item.count === undefined ? null : (
              <span className="ml-2 rounded-chip bg-surface-2 px-1.5 text-meta text-muted">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface CardProps {
  readonly title?: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly padded?: boolean;
}

export function Card({ title, description, actions, children, className, padded = true }: CardProps): JSX.Element {
  return (
    <section className={clsx('rounded-card border border-line bg-surface', className)}>
      {title || actions ? (
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="text-body font-semibold text-text">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-meta text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function Separator({ className }: { readonly className?: string }): JSX.Element {
  return <hr className={clsx('border-0 border-t border-line', className)} />;
}

export function Skeleton({ height = 12, width = '100%' }: { readonly height?: number; readonly width?: number | string }): JSX.Element {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

/** A short hint on hover/focus. Keyboard reachable via focus on the trigger. */
export function Tooltip({ label, children }: { readonly label: string; readonly children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open ? (
        <span
          role="tooltip"
          id={id}
          className="absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 whitespace-nowrap rounded-input bg-text px-2 py-1 text-meta text-inverse shadow-[var(--shadow-overlay)]"
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}

export interface SegmentedProps<T extends string> {
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: readonly { readonly value: T; readonly label: string; readonly icon?: ReactNode }[];
  readonly ariaLabel: string;
}

export function Segmented<T extends string>({ value, onChange, options, ariaLabel }: SegmentedProps<T>): JSX.Element {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex rounded-input border border-line-strong bg-surface p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={clsx(
            'inline-flex items-center gap-1 rounded-[3px] px-2 py-1 text-meta transition-colors duration-fast',
            option.value === value ? 'bg-accent-soft text-accent' : 'text-muted hover:text-text',
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Avatar({ name, size = 28 }: { readonly name: string; readonly size?: number }): JSX.Element {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center rounded-chip bg-accent-soft text-meta font-semibold text-accent"
      style={{ width: size, height: size }}
    >
      {initials || '?'}
    </span>
  );
}

export function ProgressBar({ value, max = 100, label }: { readonly value: number; readonly max?: number; readonly label?: string }): JSX.Element {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? 'Progress'}
      className="h-1.5 w-full overflow-hidden rounded-chip bg-surface-3"
    >
      <div className="h-full rounded-chip bg-accent transition-[width] duration-base" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A keyboard hint such as `⌘K`. */
export function Kbd({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <kbd className="rounded-input border border-line bg-surface-2 px-1.5 py-0.5 font-ui text-meta text-muted">
      {children}
    </kbd>
  );
}

// ── focus management ─────────────────────────────────────────────────────────

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Elements inside `container` that can hold focus, in DOM order. */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

/**
 * Traps Tab inside `ref` while `active`, and restores focus to the element that
 * had it when the trap started. Shared by `Modal` and `Drawer`.
 */
export function useFocusTrap(active: boolean, ref: React.RefObject<HTMLElement>): void {
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const node = ref.current;
    if (node) {
      const [first] = focusableWithin(node);
      (first ?? node).focus();
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Tab' || !ref.current) return;
      const items = focusableWithin(ref.current);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const target = restoreTo.current;
      if (target && document.contains(target)) target.focus();
    };
  }, [active, ref]);
}

/** True while any overlay owns the screen — global shortcuts stand down. */
const OverlayContext = createContext<{ count: number; push(): () => void } | null>(null);

export function OverlayProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [count, setCount] = useState(0);
  const value = {
    count,
    push() {
      setCount((current) => current + 1);
      return () => setCount((current) => Math.max(0, current - 1));
    },
  };
  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}

/** Number of open overlays. Lists use it to disable row shortcuts. */
export function useOverlayDepth(): number {
  return useContext(OverlayContext)?.count ?? 0;
}

/** Registers an overlay for the duration of `open`. */
export function useOverlayRegistration(open: boolean): void {
  const context = useContext(OverlayContext);
  const push = context?.push;
  useEffect(() => {
    if (!open || !push) return undefined;
    return push();
  }, [open, push]);
}
