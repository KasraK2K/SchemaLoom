import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';

/**
 * The snapshot routes (`apps/api/src/snapshots`). Every response is parsed: it is a network
 * payload. The diff schema reads only what the history screen renders — entries stay
 * loose about object payloads, whose full shape is the IR's business.
 */

export const snapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(['manual', 'auto', 'import', 'restore']),
  createdAt: z.string(),
  createdById: z.string().nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

const named = z.looseObject({ name: z.string().optional() });

const propertySchema = z.object({
  path: z.array(z.string()),
  before: z.unknown(),
  after: z.unknown(),
  severity: z.enum(['structural', 'governance', 'documentation', 'cosmetic']),
});
export type DiffProperty = z.infer<typeof propertySchema>;

const entrySchema = z.object({
  objectType: z.string(),
  id: z.string(),
  change: z.enum(['added', 'removed', 'changed']),
  ownerEntityId: z.string().optional(),
  before: named.optional(),
  after: named.optional(),
  properties: z.array(propertySchema).optional(),
});
export type DiffEntry = z.infer<typeof entrySchema>;

const countsSchema = z.object({
  added: z.number(),
  removed: z.number(),
  changed: z.number(),
  structural: z.number(),
  governance: z.number(),
});
export type DiffCounts = z.infer<typeof countsSchema>;

export const diffSchema = z.object({
  entries: z.array(entrySchema),
  counts: countsSchema,
  /** Only on the live diff: whether the caller has the full view restore needs (R21′). */
  fullView: z.boolean().optional(),
});
export type HistoryDiff = z.infer<typeof diffSchema>;

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/snapshots`;

export const snapshotsKey = (projectId: string): readonly unknown[] => ['project', projectId, 'snapshots'];

export function snapshotsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: snapshotsKey(projectId),
    queryFn: async () => z.array(snapshotSchema).parse(await apiFetch<unknown>(base(projectId))),
    retry: false,
  });
}

/** `to === null` diffs against the current schema. */
export function diffQueryOptions(projectId: string, from: string, to: string | null) {
  const path = `${base(projectId)}/${encodeURIComponent(from)}/diff/${
    to === null ? 'live' : encodeURIComponent(to)
  }`;
  return queryOptions({
    queryKey: [...snapshotsKey(projectId), 'diff', from, to ?? 'live'],
    queryFn: async () => diffSchema.parse(await apiFetch<unknown>(path)),
    retry: false,
  });
}

const stepSchema = z.object({
  ordinal: z.number(),
  phase: z.string(),
  kind: z.string(),
  text: z.string(),
  destructive: z.boolean(),
  lossy: z.boolean(),
  requiresTableRewrite: z.boolean(),
  commentedOut: z.boolean(),
  reason: z.string().nullable(),
});
export type MigrationStep = z.infer<typeof stepSchema>;

/** `GET …/migration/…` (doc 03 §11.2): the engine's plan, reasons already rendered. */
export const migrationSchema = z.object({
  steps: z.array(stepSchema),
  summary: z.object({ total: z.number(), destructive: z.number(), lossy: z.number(), rewrites: z.number() }),
  unsupported: z.array(z.object({ change: z.string(), reason: z.string() })),
  script: z.string(),
  fileExtension: z.string(),
});
export type MigrationView = z.infer<typeof migrationSchema>;

/** `to === null` migrates to the current schema. */
export function migrationQueryOptions(
  projectId: string,
  from: string,
  to: string | null,
  allowDestructive: boolean,
) {
  const path = `${base(projectId)}/${encodeURIComponent(from)}/migration/${
    to === null ? 'live' : encodeURIComponent(to)
  }?allowDestructive=${String(allowDestructive)}`;
  return queryOptions({
    queryKey: [...snapshotsKey(projectId), 'migration', from, to ?? 'live', allowDestructive],
    queryFn: async () => migrationSchema.parse(await apiFetch<unknown>(path)),
    retry: false,
  });
}

export async function createSnapshot(
  projectId: string,
  input: { name: string; description?: string },
): Promise<Snapshot> {
  return snapshotSchema.parse(await apiFetch<unknown>(base(projectId), { method: 'POST', body: input }));
}

export async function restoreSnapshot(projectId: string, id: string): Promise<void> {
  await apiFetch<unknown>(`${base(projectId)}/${encodeURIComponent(id)}/restore`, { method: 'POST' });
}

export async function deleteSnapshot(projectId: string, id: string): Promise<void> {
  await apiFetch<unknown>(`${base(projectId)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** A display name for an entry: the object's name on whichever side has one. */
export const entryName = (entry: DiffEntry): string =>
  entry.after?.name ?? entry.before?.name ?? entry.id;

/** "3 tables removed, 12 changed" — the restore dialog's summary line. */
export function summarize(counts: DiffCounts): string {
  const parts = [
    counts.added > 0 && `${String(counts.added)} added`,
    counts.removed > 0 && `${String(counts.removed)} removed`,
    counts.changed > 0 && `${String(counts.changed)} changed`,
  ].filter(Boolean);
  return parts.length === 0 ? 'No differences' : parts.join(', ');
}

/** "Hide cosmetic": drop an entry only when EVERY change it carries is cosmetic. Adds and
 *  removes are never cosmetic, and a governance change is never hidden. */
export const isCosmeticOnly = (entry: DiffEntry): boolean =>
  entry.change === 'changed' &&
  (entry.properties ?? []).length > 0 &&
  (entry.properties ?? []).every((p) => p.severity === 'cosmetic');

/** `entriesByEntity`, over the parsed wire shape: an entity groups under itself. */
export function groupByEntity(entries: readonly DiffEntry[]): Map<string, DiffEntry[]> {
  const out = new Map<string, DiffEntry[]>();
  for (const entry of entries) {
    const key = entry.objectType === 'entity' ? entry.id : entry.ownerEntityId;
    if (key === undefined) continue;
    out.set(key, [...(out.get(key) ?? []), entry]);
  }
  return out;
}
