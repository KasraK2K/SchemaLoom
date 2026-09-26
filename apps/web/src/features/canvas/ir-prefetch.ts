import { SchemaModelSchema, type Id, type SchemaModel } from '@schemaloom/schema-model';
import { QueryClient, dehydrate, type DehydratedState } from '@tanstack/react-query';
import { serverFetch } from '@/lib/server-api';
import { irQueryKey } from './ir-query';

/**
 * The RSC half of doc 01 §5.2: the canvas route prefetches the IR query and dehydrates
 * ONLY that query, so first paint is not a client waterfall.
 *
 * It cannot reuse `apiFetch` — that module is the browser's, with `credentials: 'include'`
 * and a CSRF echo read from `document.cookie`, neither of which exists on the server. It
 * goes through `serverFetch` instead, which forwards the incoming `cookie` header.
 *
 * It used to hand-roll that fetch, and hand-rolled it WITHOUT the `/api` prefix, so the
 * prefetch 404'd against a healthy API on every render and silently fell back to the
 * client fetch it exists to avoid. One fetcher, one place the prefix is applied.
 *
 * The failure is swallowed deliberately. A dead API at render time degrades to a client
 * fetch with the query's own retry policy, rather than a 500 on a page that would
 * otherwise have rendered — and `dehydrate` omits a failed query, so nothing bad is
 * handed to the client either way.
 */
export async function dehydrateIr(projectId: Id): Promise<DehydratedState> {
  const client = new QueryClient();
  await client
    .query({ queryKey: irQueryKey(projectId), queryFn: () => fetchIr(projectId) })
    .catch(() => undefined);
  return dehydrate(client);
}

async function fetchIr(projectId: Id): Promise<SchemaModel> {
  return SchemaModelSchema.parse(await serverFetch<unknown>(`/projects/${projectId}/ir`));
}
