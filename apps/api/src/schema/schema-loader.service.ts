import { Injectable, NotFoundException } from '@nestjs/common';
import { RawSchemaModel, assembleModel } from '@schemaloom/schema-model';
import { PrismaService } from '../prisma/prisma.service';
import { readProjectRows, type SchemaDb } from './row-read';

/**
 * Doc 04 §8.1, build-order step 13 — the read path.
 *
 * **It returns a `RawSchemaModel` and nothing else.** Not a `SchemaModel`, not
 * `{ model, context }`, not a getter. Doc 05 §8.6's single-path rule is a property of
 * this return type: the payload lives in a module-private `WeakMap` inside
 * `schema-model`, `toJSON` throws, and the only exported function that accepts the box
 * is `redact`. A handler that wants to serialise schema data therefore has exactly one
 * route to it — `VisibilityFilter` — and the compiler, not a reviewer, is what says so.
 *
 * Everything else here is plumbing: read the rows, hand them to the pure
 * `assembleModel`, box the result.
 */
@Injectable()
export class SchemaLoader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @throws NotFoundException when the project does not exist or is soft-deleted. The
   *   guard has already established that the subject may open it, so this is a genuine
   *   404 and not an authorization answer.
   */
  async load(projectId: string, db: SchemaDb = this.prisma): Promise<RawSchemaModel> {
    const [project, rows] = await Promise.all([
      db.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { engineId: true, engineVersion: true },
      }),
      readProjectRows(db, projectId),
    ]);
    if (project === null) {
      throw new NotFoundException({ code: 'not_found', resourceType: 'project', id: projectId });
    }

    return new RawSchemaModel(
      assembleModel({
        projectId,
        engineId: project.engineId,
        engineVersion: project.engineVersion,
        rows,
      }),
    );
  }
}
