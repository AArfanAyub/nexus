/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The stand-in for every route whose real screen lands in a later task.
 *
 * It is deliberately honest: it names the route, says which build step delivers
 * it, and shows the permission the page will require. That way the sidebar is
 * fully navigable today without pretending a feature exists.
 */

import { useLocation } from 'react-router-dom';

import { MODULES } from '@shared/modules';

import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/ui';

export interface PlaceholderProps {
  readonly title: string;
  /** Which task delivers the real screen, e.g. `T05`. */
  readonly task?: string;
}

export function Placeholder({ title, task = 'T05' }: PlaceholderProps): JSX.Element {
  const { pathname } = useLocation();
  const owner = MODULES.find((module) =>
    module.routes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)),
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={title} subtitle={pathname} />
      <div className="flex-1 overflow-y-auto p-4">
        <Card title="Coming in the next build step">
          <p className="text-body text-text">
            {title} is routed, permission-checked and themed — the screen itself arrives in {task}.
          </p>
          <dl className="mt-3 grid grid-cols-1 gap-2 text-meta md:grid-cols-3">
            <div>
              <dt className="text-muted">Module</dt>
              <dd className="text-text">{owner?.id ?? 'unknown'}</dd>
            </div>
            <div>
              <dt className="text-muted">Route</dt>
              <dd className="tnum text-text">{pathname}</dd>
            </div>
            <div>
              <dt className="text-muted">Required permission</dt>
              <dd className="tnum text-text">{owner?.permissions[0] ?? '—'}</dd>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}
