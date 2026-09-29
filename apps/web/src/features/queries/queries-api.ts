import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';

/**
 * The saved-query library routes (`apps/api/src/saved-queries`). Every response is parsed:
 * it is a network payload, and a drift should fail loudly here rather than render wrong.
 */

export const savedQuerySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  queryText: z.string(),
  language: z.string(),
  tags: z.array(z.string()),
  identifiersResolved: z.boolean(),
  touchedEntityIds: z.array(z.string()),
  createdById: z.string().nullable(),
  canEdit: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedQuery = z.infer<typeof savedQuerySchema>;

const rangeSchema = z.object({ start: z.number(), end: z.number() });

export const validationSchema = z.object({
  parsed: z.boolean(),
  parseErrors: z.array(z.object({ message: z.string(), range: rangeSchema })),
  identifiers: z.array(
    z.object({
      text: z.string(),
      range: rangeSchema,
      role: z.string(),
      status: z.string(),
      messageCode: z.string().nullable(),
      suggestions: z.array(z.string()),
    }),
  ),
  touchedEntityIds: z.array(z.string()),
  statementKinds: z.array(z.string()),
});
export type QueryValidation = z.infer<typeof validationSchema>;

export interface SavedQueryWrite {
  readonly name: string;
  readonly queryText: string;
  readonly tags: readonly string[];
}

export const savedQueriesKey = (projectId: string): readonly unknown[] => [
  'project',
  projectId,
  'saved-queries',
];

export function savedQueriesQueryOptions(projectId: string, tag: string) {
  const search = tag === '' ? '' : `?tag=${encodeURIComponent(tag)}`;
  return queryOptions({
    queryKey: [...savedQueriesKey(projectId), tag],
    queryFn: async (): Promise<SavedQuery[]> =>
      z
        .object({ queries: z.array(savedQuerySchema) })
        .parse(await apiFetch<unknown>(`/projects/${projectId}/saved-queries${search}`)).queries,
  });
}

export async function createSavedQuery(
  projectId: string,
  body: SavedQueryWrite,
): Promise<SavedQuery> {
  return savedQuerySchema.parse(
    await apiFetch<unknown>(`/projects/${projectId}/saved-queries`, { method: 'POST', body }),
  );
}

export async function updateSavedQuery(id: string, body: SavedQueryWrite): Promise<SavedQuery> {
  return savedQuerySchema.parse(
    await apiFetch<unknown>(`/saved-queries/${id}`, { method: 'PATCH', body }),
  );
}

export async function deleteSavedQuery(id: string): Promise<void> {
  await apiFetch<unknown>(`/saved-queries/${id}`, { method: 'DELETE' });
}

export async function validateQuery(projectId: string, query: string): Promise<QueryValidation> {
  return validationSchema.parse(
    await apiFetch<unknown>(`/projects/${projectId}/queries/validate`, {
      method: 'POST',
      body: { query },
    }),
  );
}

/** Statuses the editor underlines. `not-visible` never arrives (core sends no probe). */
export const FLAGGED_STATUSES: ReadonlySet<string> = new Set([
  'unknown',
  'ambiguous',
  'not-visible',
]);

/** Anything but SELECT is "not read-only" — the generic warning doc 03 §12 asks core for. */
export function isReadOnly(v: QueryValidation): boolean {
  return v.statementKinds.every((kind) => kind.toUpperCase() === 'SELECT');
}

export function parseTags(input: string): string[] {
  return [
    ...new Set(
      input
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
    ),
  ];
}
