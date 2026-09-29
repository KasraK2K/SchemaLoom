import { Injectable, NotFoundException } from '@nestjs/common';
import type { Id } from '@schemaloom/schema-model';
import { PermissionResolver, type ResourceRef } from '../access';
import { EngineGate } from '../engines/engine-gate.service';
import { PrismaService } from '../prisma/prisma.service';
import type { GeometryBatch, SchemaOperationResult } from './ops';
import { postImages } from './post-images';
import type { SchemaDb } from './row-read';
import { SchemaCommits, type WriteContext } from './schema-writer.service';

/**
 * Doc 04 §8.11 — canvas geometry, THE ONE WRITE THAT IS NOT AN OP.
 *
 * **It does not read and does not bump `version`, and it is last-write-wins by design**
 * (doc 02 §10.4, the C7 carve-out). One auto-layout rewrites 300 positions in a single
 * gesture; if that bumped 300 versions, every other client with an open property panel —
 * a rename in progress, a nullable toggle — would 409 on a change that conflicted with
 * nothing, and two people panning the same project would 409 each other's SEMANTIC edits
 * continuously. §7.4 already classifies `position` / `width` / `height` as `cosmetic`, so
 * the diff and the migration generator ignore them either way.
 *
 * It still goes through the full guard: `schema:edit` on each named entity, and rule 1's
 * visibility check — which comes free, because `assertAll` tests `schema:view` across
 * every ref before it tests the atom on any of them, so an invisible entity is a 404 and
 * not a 403.
 *
 * `seq` is READ, not incremented: `projects.schema_revision` is the engine-diagnostics
 * cache key, and dragging a table invalidates nobody's diagnostics. The frame rides a
 * lower-priority channel and a repeated `seq` is not a gap.
 */
@Injectable()
export class GeometryWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly commits: SchemaCommits,
    private readonly gate: EngineGate,
  ) {}

  async apply(
    batch: GeometryBatch,
    ctx: Omit<WriteContext, 'redacted'>,
  ): Promise<SchemaOperationResult> {
    const ids = [...new Set(batch.entities.map((e) => e.id))];
    const refs: ResourceRef[] = ids.map((id) => ({ type: 'entity', id }));
    this.resolver.assertAll(ctx.map, ctx.skel, refs, 'schema:edit');

    const result = await this.prisma.$transaction(async (tx) => this.run(tx, batch, ctx, ids));
    this.commits.results.next(result);
    return result;
  }

  private async run(
    tx: SchemaDb,
    batch: GeometryBatch,
    ctx: Omit<WriteContext, 'redacted'>,
    ids: readonly Id[],
  ): Promise<SchemaOperationResult> {
    const { projectId } = ctx;
    await this.gate.checkWrite(tx, projectId);

    await Promise.all(
      batch.entities.map((e) =>
        // No `version` in the WHERE and no `version` in the DATA. Both absences are the
        // point of this endpoint and both are asserted by its unit test.
        tx.entity.updateMany({
          where: { id: e.id, projectId },
          data: {
            positionX: e.position.x,
            positionY: e.position.y,
            width: e.width,
            height: e.height,
          },
        }),
      ),
    );

    const project = await tx.project.findFirst({
      where: { id: projectId },
      select: { schemaRevision: true },
    });
    if (project === null) {
      throw new NotFoundException({ code: 'not_found', resourceType: 'project', id: projectId });
    }

    return {
      batchId: batch.batchId,
      projectId,
      actorUserId: ctx.actorUserId,
      seq: Number(project.schemaRevision),
      changed: await postImages(
        tx,
        projectId,
        ids.map((id) => ({ type: 'entity' as const, id })),
      ),
      removed: [],
    };
  }
}
