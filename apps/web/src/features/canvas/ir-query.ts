import { SchemaModelSchema, type Id, type SchemaModel } from '@schemaloom/schema-model';
import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * The IR query. Doc 01 §5.2: its own query at the CANVAS route, never in the project
 * layout — a 300-entity model dehydrated into the layout is re-sent on every layout
 * render and paid in full by a user who navigated to `/settings`.
 *
 * The response is parsed, not cast. It is a network payload crossing a trust boundary,
 * and every node, edge, badge and link check downstream reads it as if the shape were
 * guaranteed; one drifted field would surface as a blank canvas with no error. `irVersion`
 * is a literal in the schema, so a server that starts sending v2 fails loudly here rather
 * than rendering half a diagram.
 */
export const irQueryKey = (projectId: Id): readonly unknown[] => ['project', projectId, 'ir'];

export function irQueryOptions(projectId: Id) {
  return queryOptions({
    queryKey: irQueryKey(projectId),
    queryFn: async (): Promise<SchemaModel> =>
      SchemaModelSchema.parse(await apiFetch<unknown>(`/projects/${projectId}/ir`)),
  });
}
