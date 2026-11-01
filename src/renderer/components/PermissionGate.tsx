/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * `PermissionGate` — hides UI a role cannot use (BR-20, US-07).
 *
 * This is **cosmetic only**. The authoritative check is in the dispatcher, which
 * reads `CHANNEL_PERMISSIONS` and rejects the call even if the button is forced
 * into the DOM. Hiding it here just avoids showing dead controls.
 */

import type { ReactNode } from 'react';

import type { Permission } from '@shared/permissions';

import { useSession } from '../store';

export interface PermissionGateProps {
  /** One permission, or any-of when an array is given. */
  readonly permission: Permission | readonly Permission[];
  readonly children: ReactNode;
  /** Rendered instead when the permission is missing. Defaults to nothing. */
  readonly fallback?: ReactNode;
  /** When true every listed permission is required. */
  readonly requireAll?: boolean;
}

export function PermissionGate({
  permission,
  children,
  fallback = null,
  requireAll = false,
}: PermissionGateProps): JSX.Element | null {
  const permissions = useSession((state) => state.permissions);
  const list = Array.isArray(permission) ? permission : [permission as Permission];
  const allowed = requireAll
    ? list.every((entry) => permissions.has(entry))
    : list.some((entry) => permissions.has(entry));

  return <>{allowed ? children : fallback}</>;
}

/** The hook form, for logic that is not a simple render decision. */
export function usePermission(permission: Permission | readonly Permission[], requireAll = false): boolean {
  const permissions = useSession((state) => state.permissions);
  const list = Array.isArray(permission) ? permission : [permission as Permission];
  return requireAll ? list.every((entry) => permissions.has(entry)) : list.some((entry) => permissions.has(entry));
}
