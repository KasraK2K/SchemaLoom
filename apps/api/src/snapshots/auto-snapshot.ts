import type { SchemaDb } from '../schema/row-read';
import { snapshotBlob, type LiveIr } from './live-ir';

/** Phase 4 Q4 — how long automatic snapshots live. Manual ones are never pruned. */
export const AUTO_SNAPSHOTS_KEPT = 50;
export const AUTO_SNAPSHOT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface AutoSnapshotInput {
  readonly projectId: string;
  /** `auto`: before a change request is merged (Phase 10). */
  readonly kind: 'import' | 'restore' | 'auto';
  readonly name: string;
  /** The model as it was BEFORE the write this snapshot precedes. */
  readonly live: LiveIr;
  readonly enginePluginVersion: string;
  readonly createdById: string | null;
  readonly now: Date;
}

/**
 * Written inside the transaction of the import or restore batch it precedes
 * (`WriteContext.beforeWrite`), so an import that rolls back leaves no snapshot and a
 * committed one always has its undo point. The same transaction prunes: a non-manual
 * snapshot goes only when it is BOTH beyond the newest 50 non-manual ones AND older than
 * 90 days — no scheduler needed.
 */
export async function writeAutoSnapshot(tx: SchemaDb, input: AutoSnapshotInput): Promise<void> {
  await tx.snapshot.create({
    data: {
      projectId: input.projectId,
      createdById: input.createdById,
      name: input.name,
      kind: input.kind,
      ir: snapshotBlob(input.live),
      irSchemaVersion: input.live.irVersion,
      enginePluginVersion: input.enginePluginVersion,
    },
    select: { id: true },
  });

  const beyond = await tx.snapshot.findMany({
    where: { projectId: input.projectId, kind: { not: 'manual' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: AUTO_SNAPSHOTS_KEPT,
    select: { id: true, createdAt: true },
  });
  const cutoff = input.now.getTime() - AUTO_SNAPSHOT_MAX_AGE_MS;
  const stale = beyond.filter((row) => row.createdAt.getTime() < cutoff).map((row) => row.id);
  if (stale.length === 0) return;
  await tx.snapshot.deleteMany({
    where: { id: { in: stale }, projectId: input.projectId, kind: { not: 'manual' } },
  });
}
