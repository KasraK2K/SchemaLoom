'use client';

import type { EngineCapabilities, EngineFeature } from '@schemaloom/engine-sdk/ui';
import type { ReactNode } from 'react';
import { useEngine } from './engine-provider';

/**
 * §16.5 — the generic gate for anything that is not an inspector tab.
 *
 * Takes an ATOM for the ten headline features, or a PREDICATE for anything answered by a
 * descriptor list (`(c) => hasConstraintKind(c, 'check')`). One atom per surface cannot
 * express "any of these": gating the Constraints tab on `checkConstraints` alone would cost
 * an engine with primary keys but no CHECK its entire Constraints tab, primary-key editing
 * included.
 *
 * It reads the capabilities of whatever facet the registry resolved. There is no engine id
 * anywhere in this file, and that is the point — a Cassandra engine with
 * `features.indexes: false` hides the same surfaces with no Cassandra-specific code.
 *
 * UI gating is convenience; `assertFeature` on the server is the guarantee.
 */
export function CapabilityGate({
  feature,
  when,
  children,
  fallback,
}: {
  readonly feature?: EngineFeature;
  readonly when?: (caps: EngineCapabilities) => boolean;
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}) {
  const { capabilities } = useEngine();
  // Neither supplied is a caller bug, and rendering the children would silently defeat the
  // gate. Closed is the safe direction.
  const ok =
    feature === undefined ? (when?.(capabilities) ?? false) : capabilities.features[feature];
  return <>{ok ? children : (fallback ?? null)}</>;
}
