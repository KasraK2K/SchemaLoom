import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { ResourceIndex } from './resource-index';
import type { ResourceRef } from './types';

/** Doc 05 §10.3 step 4 / §10.4 — at most two queries, whatever N is. */

interface Row {
  id: string;
  projectId: string;
}

function makeIndex(entities: Row[] = [], areas: Row[] = []) {
  const entityFind = vi.fn().mockResolvedValue(entities);
  const areaFind = vi.fn().mockResolvedValue(areas);
  const prisma = { entity: { findMany: entityFind }, area: { findMany: areaFind } };
  return {
    index: new ResourceIndex(prisma as unknown as PrismaService),
    entityFind,
    areaFind,
  };
}

const entityRefs = (ids: readonly string[]): ResourceRef[] =>
  ids.map((id) => ({ type: 'entity', id }));

describe('ResourceIndex.projectIdFor', () => {
  it('answers a project locator with no query at all', async () => {
    const { index, entityFind, areaFind } = makeIndex();
    await expect(index.projectIdFor([{ type: 'project', id: 'prj_shop' }])).resolves.toBe(
      'prj_shop',
    );
    expect(entityFind).not.toHaveBeenCalled();
    expect(areaFind).not.toHaveBeenCalled();
  });

  it('resolves 300 entity refs in ONE indexed lookup', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `ent_${String(i)}`);
    const { index, entityFind } = makeIndex(ids.map((id) => ({ id, projectId: 'prj_shop' })));

    await expect(index.projectIdFor(entityRefs(ids))).resolves.toBe('prj_shop');
    expect(entityFind).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated ids before it queries', async () => {
    const { index, entityFind } = makeIndex([{ id: 'ent_1', projectId: 'prj_shop' }]);
    await index.projectIdFor(entityRefs(['ent_1', 'ent_1', 'ent_1']));
    expect(entityFind.mock.calls[0]?.[0]).toEqual({
      where: { id: { in: ['ent_1'] } },
      select: { id: true, projectId: true },
    });
  });

  it('404s an id that does not exist — the same shape as "you cannot see it"', async () => {
    const { index } = makeIndex([{ id: 'ent_1', projectId: 'prj_shop' }]);
    await expect(index.projectIdFor(entityRefs(['ent_1', 'ent_ghost']))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('400s refs that span two projects — cross-project bulk is not supported', async () => {
    const { index } = makeIndex([
      { id: 'ent_1', projectId: 'prj_shop' },
      { id: 'ent_2', projectId: 'prj_other' },
    ]);
    await expect(index.projectIdFor(entityRefs(['ent_1', 'ent_2']))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('mixes an entity and an area in one project, one query each', async () => {
    const { index, entityFind, areaFind } = makeIndex(
      [{ id: 'ent_1', projectId: 'prj_shop' }],
      [{ id: 'area_1', projectId: 'prj_shop' }],
    );
    await expect(
      index.projectIdFor([
        { type: 'entity', id: 'ent_1' },
        { type: 'area', id: 'area_1' },
      ]),
    ).resolves.toBe('prj_shop');
    expect(entityFind).toHaveBeenCalledTimes(1);
    expect(areaFind).toHaveBeenCalledTimes(1);
  });

  it('400s an empty locator list rather than resolving nothing', async () => {
    const { index } = makeIndex();
    await expect(index.projectIdFor([])).rejects.toThrow(BadRequestException);
  });
});
