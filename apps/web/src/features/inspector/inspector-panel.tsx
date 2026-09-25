import type { Id } from '@schemaloom/schema-model';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@schemaloom/ui';
import { EngineGate } from '@/features/project/engine-gate';
import { InspectorBody } from './inspector-body';

/**
 * The right-hand context panel. Its tabs are fixed by the product spec (entity / field /
 * link / docs); the contents follow the canvas selection.
 *
 * The tab chrome is a Server Component and the body is not: the frame is static and there
 * is no reason to ship it, or to blank it while the engine chunk loads.
 */
export function InspectorPanel({ projectId }: { readonly projectId: Id }) {
  return (
    <Tabs defaultValue="entity" className="flex h-full flex-col p-2">
      <TabsList>
        <TabsTrigger value="entity">Entity</TabsTrigger>
        <TabsTrigger value="field">Field</TabsTrigger>
        <TabsTrigger value="link">Link</TabsTrigger>
        <TabsTrigger value="docs">Docs</TabsTrigger>
      </TabsList>
      <EngineGate
        projectId={projectId}
        fallback={<p className="p-2 text-sm text-text-subtle">Loading…</p>}
      >
        <InspectorBody projectId={projectId} />
      </EngineGate>
      <TabsContent value="docs" className="text-sm text-text-muted">
        Documentation arrives with the docs editor.
      </TabsContent>
    </Tabs>
  );
}
