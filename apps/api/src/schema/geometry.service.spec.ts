import { describe, expect, it, vi } from 'vitest';
import type { PermissionResolver, ProjectPermissionMap, ProjectSkeleton } from '../access';
import { fakePrisma } from './fake-prisma';
import { PROJECT, baseStore, entityRow } from './fixture';
import { GeometryWriter } from './geometry.service';
import { SchemaCommits } from './schema-writer.service';
import { GeometryBatchSchema } from './ops';

/**
 * Doc 04 §8.11 — the C7 carve-out. The two assertions that matter are ABSENCES, which is
 * exactly the kind of property a reader of the implementation cannot confirm at a glance
 * and a future refactor removes without noticing.
 */
describe('GeometryWriter', () => {
  const store = baseStore({
    entity: [
      entityRow('ent_orders', { version: 7, positionX: 0, positionY: 0 }),
      entityRow('ent_users', { version: 2 }),
    ],
  });

  const batch = GeometryBatchSchema.parse({
    batchId: 'btc_drag',
    entities: [
      { id: 'ent_orders', position: { x: 120, y: 40 }, width: 300 },
      { id: 'ent_users', position: { x: 0, y: 900 } },
    ],
  });

  const context = {
    projectId: PROJECT,
    actorUserId: 'usr_ana',
    map: {} as ProjectPermissionMap,
    skel: {} as ProjectSkeleton,
  };

  const build = () => {
    const prisma = fakePrisma(store);
    const assertAll = vi.fn();
    const writer = new GeometryWriter(
      prisma.client,
      { assertAll } as unknown as PermissionResolver,
      new SchemaCommits(),
    );
    return { prisma, writer, assertAll };
  };

  it('neither reads nor bumps version', async () => {
    const { prisma, writer } = build();
    await writer.apply(batch, context);

    for (const call of prisma.callsTo('entity', 'updateMany')) {
      // No optimistic-concurrency guard: one auto-layout rewrites 300 positions, and
      // 300 version bumps would 409 every other client's in-progress rename.
      expect(call.args.where).not.toHaveProperty('version');
      expect(call.args.data).not.toHaveProperty('version');
    }
    expect(prisma.store.entity?.[0]?.version).toBe(7);
    expect(prisma.store.entity?.[1]?.version).toBe(2);
  });

  it('writes the geometry it was given, scoped to the project', async () => {
    const { prisma, writer } = build();
    await writer.apply(batch, context);

    expect(prisma.callsTo('entity', 'updateMany')[0]).toMatchObject({
      args: {
        where: { id: 'ent_orders', projectId: PROJECT },
        data: { positionX: 120, positionY: 40, width: 300 },
      },
    });
    expect(prisma.store.entity?.[0]).toMatchObject({ positionX: 120, positionY: 40 });
  });

  it('checks schema:edit on each named entity — the full guard still applies', async () => {
    const { writer, assertAll } = build();
    await writer.apply(batch, context);

    expect(assertAll).toHaveBeenCalledTimes(1);
    expect(assertAll.mock.calls[0]?.[2]).toEqual([
      { type: 'entity', id: 'ent_orders' },
      { type: 'entity', id: 'ent_users' },
    ]);
    // `assertAll` tests `schema:view` across every ref BEFORE the atom on any of them, so
    // rule 1's visibility check comes free and an invisible entity is a 404.
    expect(assertAll.mock.calls[0]?.[3]).toBe('schema:edit');
  });

  it('reads the project sequence without advancing it', async () => {
    const { prisma, writer } = build();
    const result = await writer.apply(batch, context);

    // `schema_revision` is the engine-diagnostics cache key; dragging a table
    // invalidates nobody's diagnostics.
    expect(prisma.callsTo('project', 'update')).toHaveLength(0);
    expect(result.seq).toBe(41);
    expect(result.removed).toEqual([]);
    expect(Object.keys(result.changed.entity ?? {})).toEqual(['ent_orders', 'ent_users']);
  });
});
