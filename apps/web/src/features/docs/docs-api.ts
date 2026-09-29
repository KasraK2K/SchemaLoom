import { docTargetTypeSchema, type DocTargetType, type FieldDocFacts } from '@schemaloom/contracts';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';

/** Wire shapes of `apps/api/src/docs`. Parsed, not cast: they are network payloads. */

export const docSchema = z.object({
  targetType: docTargetTypeSchema,
  targetId: z.string(),
  /** Sanitised TipTap JSON (StarterKit nodes only), already filtered for this reader. */
  content: z.record(z.string(), z.unknown()),
  structured: z.record(z.string(), z.unknown()).nullable(),
  plainText: z.string(),
  version: z.number(),
  updatedAt: z.string().nullable(),
  canEdit: z.boolean(),
});
export type DocView = z.infer<typeof docSchema>;

export interface DocTarget {
  readonly targetType: DocTargetType;
  readonly targetId: string;
}

/** Every docs query of a project shares this prefix. */
export const docsKey = (projectId: string): readonly unknown[] => ['project', projectId, 'docs'];

const path = (projectId: string, t: DocTarget): string =>
  `/projects/${encodeURIComponent(projectId)}/docs/${t.targetType}/${encodeURIComponent(t.targetId)}`;

export function docQueryOptions(projectId: string, target: DocTarget) {
  return queryOptions({
    queryKey: [...docsKey(projectId), target.targetType, target.targetId],
    queryFn: async (): Promise<DocView> =>
      docSchema.parse(await apiFetch<unknown>(path(projectId, target))),
  });
}

export function docsListQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: [...docsKey(projectId), 'list'],
    queryFn: async (): Promise<DocView[]> =>
      z
        .object({ docs: z.array(docSchema) })
        .parse(await apiFetch<unknown>(`/projects/${encodeURIComponent(projectId)}/docs`)).docs,
  });
}

export async function writeDoc(
  projectId: string,
  target: DocTarget,
  body: { content: unknown; structured?: unknown; version: number },
): Promise<DocView> {
  return docSchema.parse(await apiFetch<unknown>(path(projectId, target), { method: 'PUT', body }));
}

export const EMPTY_FACTS: FieldDocFacts = {
  targetType: 'field',
  businessMeaning: '',
  allowedValues: [],
  examples: [],
  unit: null,
  ownerUserId: null,
};

/** A field doc's facts, defaulted; anything malformed reads as empty rather than throwing. */
export function fieldFacts(doc: DocView | undefined): FieldDocFacts {
  const s = doc?.structured;
  if (s?.targetType !== 'field') return EMPTY_FACTS;
  return { ...EMPTY_FACTS, ...(s as Partial<FieldDocFacts>) };
}
