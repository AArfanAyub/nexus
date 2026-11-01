/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * `useNewParam` — the one-line bridge between a palette action and a page's
 * create flow.
 *
 * The command palette navigates with `?new=1` rather than trying to open a modal
 * it does not own. The page reads the flag on mount, opens its own dialog, and
 * clears the parameter so a refresh does not re-open it. That keeps the palette
 * free of side effects and means there is exactly one implementation of "start a
 * new product", which is the page's.
 *
 * `onOpen` is held in a ref so a page can pass an inline arrow without the effect
 * re-firing on every render — the flag is what should trigger the open, not the
 * identity of the callback.
 */

import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

export function useNewParam(onOpen: () => void): void {
  const [params, setParams] = useSearchParams();
  const wants = params.get('new') === '1';
  const callback = useRef(onOpen);
  callback.current = onOpen;

  useEffect(() => {
    if (!wants) return;
    callback.current();
    const next = new URLSearchParams(params.toString());
    next.delete('new');
    setParams(next, { replace: true });
    // `params` is intentionally omitted: including it would re-run the effect
    // after the clear and fire the callback a second time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wants]);
}
