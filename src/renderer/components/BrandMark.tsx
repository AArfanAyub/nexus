/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The NEXUS identity, drawn inline.
 *
 * The mark is a node network folded into an "N" inside a hexagon — five nodes,
 * three edges, one gradient. It is inline SVG rather than an `<img>` for three
 * reasons: it inherits `currentColor` where it needs to, it survives the strict
 * CSP (`img-src 'self' data:` would allow a file, but inline costs no request),
 * and it scales to any density without a second asset.
 *
 * The gradient id is generated per instance so two marks on one page cannot
 * collide — an SVG `id` is document-global, and a duplicate id silently wins.
 */

import { useId } from 'react';

export interface MarkProps {
  readonly size?: number;
  /** Accessible name. Pass `null` when the mark sits next to the wordmark. */
  readonly title?: string | null;
  readonly className?: string;
}

/** The hexagon + network "N". Square by construction. */
export function NexusMark({ size = 28, title = 'NEXUS', className }: MarkProps): JSX.Element {
  const gradientId = `nx-grad-${useId().replace(/:/g, '')}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      className={className}
      role={title === null ? 'presentation' : 'img'}
      aria-hidden={title === null ? true : undefined}
      aria-label={title ?? undefined}
    >
      {title === null ? null : <title>{title}</title>}
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand-from)" />
          <stop offset="1" stopColor="var(--brand-to)" />
        </linearGradient>
      </defs>
      <g transform="translate(7.5,7.5)">
        <polygon
          points="225,130 177.5,212.3 82.5,212.3 35,130 82.5,47.7 177.5,47.7"
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="9"
          strokeLinejoin="round"
          opacity="0.35"
        />
        <g stroke={`url(#${gradientId})`} strokeWidth="11" strokeLinecap="round">
          <line x1="70" y1="60" x2="70" y2="200" />
          <line x1="190" y1="60" x2="190" y2="200" />
          <line x1="70" y1="60" x2="190" y2="200" />
        </g>
        <g fill={`url(#${gradientId})`}>
          <circle cx="70" cy="60" r="11" />
          <circle cx="70" cy="200" r="11" />
          <circle cx="190" cy="60" r="11" />
          <circle cx="190" cy="200" r="11" />
          <circle cx="130" cy="130" r="13" />
        </g>
      </g>
    </svg>
  );
}

export interface LogoProps {
  readonly size?: number;
  readonly tagline?: string | null;
  readonly className?: string;
}

/**
 * Mark + wordmark, stacked for narrow containers.
 *
 * The wordmark uses `currentColor`, so it is indigo-black on light and off-white
 * on dark without a second asset — the supplied logo file hard-codes `#1E1B4B`,
 * which would disappear in dark mode.
 */
export function NexusLogo({ size = 40, tagline = null, className }: LogoProps): JSX.Element {
  return (
    <div className={className}>
      <div className="flex items-center gap-2.5">
        <NexusMark size={size} title={null} />
        <span className="text-[1.35em] font-semibold leading-none tracking-[0.16em] text-text">NEXUS</span>
      </div>
      {tagline ? (
        <p className="mt-1.5 pl-[calc(theme(spacing.2)+1px)] text-[10px] font-semibold uppercase tracking-[0.32em] text-accent">
          {tagline}
        </p>
      ) : null}
    </div>
  );
}
