import type { Id } from '@schemaloom/schema-model';
import type { QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { irQueryKey } from './ir-query';

/**
 * One gesture, one batch (§8.2), then a refetch of the IR. The realtime echo
 * (`realtime.ts`) also merges this batch's frame, but only while the socket is up; the
 * refetch keeps a write visible without one.
 *
 * ponytail: refetch, not optimistic update; apply the HTTP result with `applyPatch`
 * when the refetch shows up in a profile.
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
