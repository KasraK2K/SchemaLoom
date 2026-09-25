import { NotFoundException } from '@nestjs/common';
import {
  RawSchemaModel,
  RedactedDiffError,
  SchemaModelSchema,
  assembleModel,
  type SchemaModel,
} from '@schemaloom/schema-model';
import type { Prisma } from '../generated/prisma/client';
import { readProjectRows, type SchemaDb } from '../schema/row-read';

/**
 * Doc 04 §8.8-§8.9 — the UNREDACTED half of snapshots, and the one place in this module
 * where it exists.
 *
 * Restore is the only feature in the product that needs a raw `SchemaModel`:
 * `opsFromDiff` refuses a redacted input because a diff computed from a partial view
 * emits a `delete` for every object the viewer cannot see, atomically, through the
 * ordinary write path. §8.9's snapshot blob needs one for the same reason — a snapshot is
 * stored unredacted and redacted per viewer on READ.
 *
 * `LiveIr` is how that stays safe. It is a phantom-branded `SchemaModel` whose `redacted`
 * is narrowed to `false`, so neither a `RedactedModel` (its `redacted` is `boolean`) nor a
 * laundered `{ ...redacted, redacted: false }` is assignable to it. `asLive` is the only
 * minter, it re-checks the runtime flag, and `planRestore` accepts nothing else — so the
 * "a user restores a snapshot and deletes the tables they cannot see" path is a COMPILE
 * error, not a code-review question. `opsFromDiff`'s own throw is the second net.
 *
 * Nothing here is re-exported from `index.ts`.
 */

declare const LIVE: unique symbol;

/** A model that came from the database or from a stored blob, never from `redact`. */
export type LiveIr = SchemaModel & { readonly redacted: false; readonly [LIVE]: true };

/**
 * The only minter. The cast is unavoidable — a phantom brand has no runtime value — but
 * it is guarded by the runtime flag, so a `RedactedModel` forced through a cast still
 * throws here rather than reaching `opsFromDiff`.
 */
export function asLive(model: SchemaModel): LiveIr {
  if (model.redacted) throw new RedactedDiffError('live');
  return model as LiveIr;
}

/** §8.9 — a stored blob is a trust boundary, so it is PARSED, never trusted. The
 *  `irVersion: 1` literal inside `SchemaModelSchema` is the version seam: an `upgradeModel`
 *  switch belongs here the day an irVersion 2 exists, and not before. */
export const blobToLive = (blob: unknown): LiveIr => asLive(SchemaModelSchema.parse(blob));

/** C3: the snapshot blob is the ONLY place the IR is the stored form. Parsed on the way
 *  IN as well, so a blob that cannot be read back can never be written. */
export const snapshotBlob = (live: LiveIr): Prisma.InputJsonValue =>
  SchemaModelSchema.parse(live) as Prisma.InputJsonValue;

export interface LiveProject {
  /** For `planRestore` and for the snapshot blob. Never serialised to a client. */
  readonly live: LiveIr;
  /** The same model, boxed for `VisibilityFilter`. */
  readonly raw: RawSchemaModel;
  readonly engineId: string;
  /** `projects.engine_plugin_version` — what the stored `engineProps` were written under. */
  readonly enginePluginVersion: string;
  /** Doc 02 §11 — the restore concurrency check reads this before and after planning. */
  readonly schemaRevision: bigint;
}

/**
 * The same read `SchemaLoader` performs, kept unboxed. It reaches past `src/schema`'s
 * barrel into `row-read` deliberately and in exactly one file: the alternative is a second
 * Prisma↔IR mapping, and two of those drift.
 */
export async function loadLiveProject(db: SchemaDb, projectId: string): Promise<LiveProject> {
  const [project, rows] = await Promise.all([
    db.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        engineId: true,
        engineVersion: true,
        enginePluginVersion: true,
        schemaRevision: true,
      },
    }),
    readProjectRows(db, projectId),
  ]);
  if (project === null) {
    throw new NotFoundException({ code: 'not_found', resourceType: 'project', id: projectId });
  }

  const model = assembleModel({
    projectId,
    engineId: project.engineId,
    engineVersion: project.engineVersion,
    rows,
  });

  return {
    live: asLive(model),
    raw: new RawSchemaModel(model),
    engineId: project.engineId,
    enginePluginVersion: project.enginePluginVersion,
    schemaRevision: project.schemaRevision,
  };
}
