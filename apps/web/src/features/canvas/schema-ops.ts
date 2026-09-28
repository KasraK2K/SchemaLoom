import type { Id } from '@schemaloom/schema-model';
import type { QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { irQueryKey } from './ir-query';

/**
 * One gesture, one batch (§8.2), then a refetch of the IR. There is no realtime echo in
 * the web app yet, so without the refetch a write succeeds and the canvas keeps showing
 * the model from before it.
 *
 * ponytail: refetch, not optimistic update; add the optimistic path with realtime.
 */
export async function postOps(
  queryClient: QueryClient,
  projectId: Id,
  ops: readonly unknown[],
  label?: string,
): Promise<void> {
  await apiFetch<unknown>(`/projects/${projectId}/schema/ops`, {
    method: 'POST',
    body: { batchId: crypto.randomUUID(), projectId, ops, label },
  });
  await queryClient.invalidateQueries({ queryKey: irQueryKey(projectId) });
}

export function deleteLinkOp(link: { readonly id: Id; readonly version: number }) {
  return { op: 'delete', type: 'link', id: link.id, expectedVersion: link.version } as const;
}
