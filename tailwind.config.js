/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Tailwind maps the design tokens from ARCHITECTURE.md §E.3 to utilities.
 * No raw colour values may appear in this file or in any component: every
 * colour below resolves to a CSS variable declared in `src/renderer/index.css`.
 */
export default {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-3': 'var(--surface-3)',
        line: 'var(--border)',
        'line-strong': 'var(--border-strong)',
        text: 'var(--text)',
        muted: 'var(--text-muted)',
        inverse: 'var(--text-inverse)',
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          soft: 'var(--accent-soft)',
          strong: 'var(--accent-strong)',
        },
        success: { DEFAULT: 'var(--success)', soft: 'var(--success-soft)' },
        warning: { DEFAULT: 'var(--warning)', soft: 'var(--warning-soft)' },
        danger: { DEFAULT: 'var(--danger)', soft: 'var(--danger-soft)' },
        info: 'var(--info)',
      },
      borderRadius: {
        input: 'var(--r-input)',
        card: 'var(--r-card)',
        panel: 'var(--r-card-lg)',
        chip: 'var(--r-chip)',
      },
      boxShadow: {
        raised: 'var(--shadow-raised)',
        overlay: 'var(--shadow-overlay)',
        popover: 'var(--shadow-popover)',
      },
      fontSize: {
        title: 'var(--fs-title)',
        body: 'var(--fs-body)',
        meta: 'var(--fs-meta)',
        micro: 'var(--fs-micro)',
        kpi: 'var(--fs-kpi)',
        code: 'var(--fs-code)',
      },
      spacing: {
        1: '4px',
        2: '8px',
        3: '12px',
        4: '16px',
        5: '24px',
        6: '32px',
        7: '48px',
        8: '64px',
      },
      transitionDuration: {
        fast: '120ms',
        base: '150ms',
        slow: '180ms',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
      },
      fontFamily: {
        ui: 'var(--font-ui)',
        mono: 'var(--font-mono)',
      },
    },
  },
  plugins: [],
};
