'use client';

import { EngineGate } from '@/features/project/engine-gate';
import { WhoHasAccessDialog } from './who-has-access-dialog';

/**
 * The top bar's entry point to sharing.
 *
 * It sits in its own `EngineGate` for the same reason the inspector does: the gate is
 * mounted per PANE, not above the whole shell, so the engine chunk's `<Suspense>` never
 * blanks out the bar. Both registries memoise the PROMISE, so this third gate resolves to
 * the same facet object the canvas and the inspector already hold.
 *
 * The engine is needed because the dialog names resources, and an *entity* is a Table in
 * PostgreSQL and a Collection in MongoDB (§16.2).
 */
export function ProjectShareButton({ projectId }: { readonly projectId: string }) {
  return (
    <EngineGate
      projectId={projectId}
      fallback={
        <span className="px-2 text-sm text-text-subtle" aria-hidden="true">
          Share
        </span>
      }
    >
      <WhoHasAccessDialog projectId={projectId} />
    </EngineGate>
  );
}
