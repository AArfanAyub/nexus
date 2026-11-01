/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The 404 inside the shell. A hash router can be pointed anywhere by a stale
 * link, so this page must exist and must offer a way back rather than a dead end.
 */

import { useNavigate } from 'react-router-dom';

import { Button } from '../components/ui';

export function NotFound(): JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-kpi font-semibold text-text">404</p>
      <h1 className="text-body font-medium text-text">That page does not exist in this build</h1>
      <p className="max-w-md text-meta text-muted">
        The link may be from an older version, or the module it belongs to is not part of your industry
        preset.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" onClick={() => navigate('/dashboard')}>
          Go to dashboard
        </Button>
        <Button onClick={() => navigate(-1)}>Back</Button>
      </div>
    </div>
  );
}
