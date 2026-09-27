import type { Metadata } from 'next';
import { CanvasClient } from '@/features/canvas/canvas-client';

export const metadata: Metadata = { title: 'Shared view', robots: { index: false } };

/**
 * The read-only canvas a share-link session lands on (doc 05 §12.2 step 4).
 *
 * No server prefetch, unlike the `(app)` canvas route: `sl_session` is host-only on the
 * API origin, so this Next server never sees it and a server-side IR fetch would be
 * anonymous. The canvas queries `GET /api/projects/:id/ir` from the browser, which is
 * in `SHARE_LINK_ROUTES` and is redacted exactly as for the link's viewer grant.
 */
export default async function SharedProjectPage({
  params,
}: {
  params: Promise<{ token: string; projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-4 text-sm">
        <span className="font-semibold text-text">SchemaLoom</span>
        <span className="text-text-subtle">·</span>
        <span className="text-text-muted">Shared view, read-only</span>
      </header>
      <main className="min-h-0 flex-1">
        <CanvasClient projectId={projectId} readOnly />
      </main>
    </div>
  );
}
