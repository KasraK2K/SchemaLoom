import { SchemaModelSchema, type Id, type SchemaModel } from '@schemaloom/schema-model';
import { QueryClient, dehydrate, type DehydratedState } from '@tanstack/react-query';
import { headers } from 'next/headers';
import { clientEnv } from '@/env.client';
import { irQueryKey } from './ir-query';

/**
 * The RSC half of doc 01 §5.2: the canvas route prefetches the IR query and dehydrates
 * ONLY that query, so first paint is not a client waterfall.
 *
 * It cannot reuse `apiFetch`. That module exists for the browser — `credentials:
 * 'include'` and a CSRF echo read from `document.cookie` — and on the server there is no
 * document and no ambient cookie jar, so the request would go out anonymous and come back
 * 401. Forwarding the incoming `cookie` header is the server-side equivalent, and it is
 * the only difference between the two fetchers.
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
  const cookie = (await headers()).get('cookie');
  const response = await fetch(`${clientEnv.NEXT_PUBLIC_API_URL}/projects/${projectId}/ir`, {
    headers: cookie === null ? { Accept: 'application/json' } : { Accept: 'application/json', cookie },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`IR fetch failed with status ${String(response.status)}`);
  return SchemaModelSchema.parse(await response.json());
}
