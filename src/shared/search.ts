/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The search contract (R1).
 *
 * `search.global` and `search.palette` return this shape, and the renderer's
 * palette renders it. Declared here rather than in the service so the renderer
 * does not import from `main/` — the three trust zones stay separate even for a
 * type.
 */

export interface SearchHit {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  /** `invoice`, `customer`, `product`, … — drives the badge in the palette. */
  readonly kind: string;
  readonly route: string;
}

export interface SearchGroup {
  readonly kind: string;
  readonly label: string;
  readonly rows: readonly SearchHit[];
}

export interface SearchResult {
  readonly term: string;
  readonly groups: readonly SearchGroup[];
  readonly ms: number;
}
