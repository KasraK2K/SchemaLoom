import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ResourceRef } from './types';

/**
 * Doc 05 §10.3 step 4 — the owning project for every `ResourceRef` on one request.
 *
 * **Guards never loop** (§10.4). Whatever N is, this is at most TWO indexed lookups: one
 * `IN (...)` over entities, one over areas. `projectId` is C6's denormalized column on
 * both tables, so neither is a join, and a `{ project: … }` locator costs nothing at all.
 *
 * ponytail: no request-scoped memo and no skeleton-backed index yet — the resolver's own
 * Redis cache absorbs the repeat cost and this query is one indexed `IN`. Upgrade path if
 * a flame graph disagrees: memoise per request on `REQUEST` scope.
 */
@Injectable()
export class ResourceIndex {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @throws NotFoundException for an id that does not exist — the SAME shape §10.3 step 8
   *   uses for "you cannot see it", so the API is not an existence oracle.
   * @throws BadRequestException when the refs span two projects (§10.4: cross-project
   *   bulk is not supported) or when there are no refs at all.
   */
  async projectIdFor(refs: readonly ResourceRef[]): Promise<string> {
    const entityIds = idsOfType(refs, 'entity');
    const areaIds = idsOfType(refs, 'area');

    const [entities, areas] = await Promise.all([
      entityIds.length === 0
        ? []
        : this.prisma.entity.findMany({
            where: { id: { in: entityIds } },
            select: { id: true, projectId: true },
          }),
      areaIds.length === 0
        ? []
        : this.prisma.area.findMany({
            where: { id: { in: areaIds } },
            select: { id: true, projectId: true },
          }),
    ]);

    missing(entityIds, entities, 'entity');
    missing(areaIds, areas, 'area');

    const projectIds = new Set<string>([
      ...idsOfType(refs, 'project'),
      ...entities.map((e) => e.projectId),
      ...areas.map((a) => a.projectId),
    ]);

    const [only] = [...projectIds];
    if (only === undefined) {
      throw new BadRequestException({ code: 'missing_resource_id', locator: '' });
    }
    if (projectIds.size > 1) {
      throw new BadRequestException({ code: 'cross_project_refs', projectIds: [...projectIds] });
    }
    return only;
  }
}

const idsOfType = (refs: readonly ResourceRef[], type: ResourceRef['type']): string[] => [
  ...new Set(refs.filter((r) => r.type === type).map((r) => r.id)),
];

function missing(
  asked: readonly string[],
  found: readonly { id: string }[],
  resourceType: 'entity' | 'area',
): void {
  const present = new Set(found.map((r) => r.id));
  const gone = asked.find((id) => !present.has(id));
  if (gone !== undefined) {
    throw new NotFoundException({ code: 'not_found', resourceType, id: gone });
  }
}
