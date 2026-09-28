import { ConflictException, NotFoundException } from '@nestjs/common';
import { redact } from '@schemaloom/schema-model';
import { describe, expect, it, vi } from 'vitest';
import type {
  PermissionResolver,
  ProjectPermissionMap,
  ProjectSkeleton,
} from '../access';
import { fakePrisma, type FakePrisma, type Store } from './fake-prisma';
import {
  PROJECT,
  baseStore,
  constraintColumnRow,
  constraintRow,
  entityRow,
  fieldRow,
  indexColumnRow,
  indexRow,
  linkEndpointRow,
  linkRow,
  storeContext,
} from './fixture';
import { SchemaOperationBatchSchema, type SchemaOperationBatch } from './ops';
import { SchemaLoader } from './schema-loader.service';
import { SchemaWriter, type WriteContext } from './schema-writer.service';

/**
 * Doc 04 §8.6 — one test per safety rule, because each of them is a rule somebody will
 * otherwise "simplify" a year from now.
 */

const world = (): Partial<Store> =>
  baseStore({
    entity: [entityRow('ent_orders', { version: 2 }), entityRow('ent_users')],
    field: [
      fieldRow('fld_total', 'ent_orders', { position: 0, version: 3 }),
      fieldRow('fld_note', 'ent_orders', { position: 4 }),
      fieldRow('fld_id', 'ent_users'),
    ],
    schemaIndex: [indexRow('idx_total', 'ent_orders', { version: 0 })],
    schemaIndexColumn: [indexColumnRow('idx_total', 'fld_total')],
    constraint: [constraintRow('con_pk', 'ent_orders', { version: 0 })],
    constraintColumn: [constraintColumnRow('con_pk', 'fld_total')],
    link: [linkRow('lnk_ou', 'ent_orders', 'ent_users', { version: 0 })],
    linkEndpoint: [linkEndpointRow('lnk_ou', 'fld_total', 'fld_id')],
  });

const resolver = (): { spy: ReturnType<typeof vi.fn>; service: PermissionResolver } => {
  const spy = vi.fn();
  return {
    spy,
    service: { assertAll: spy, invalidate: vi.fn() } as unknown as PermissionResolver,
  };
};

function harness(store: Partial<Store> = world()): {
  prisma: FakePrisma;
  writer: SchemaWriter;
  assertAll: ReturnType<typeof vi.fn>;
  context: (over?: Partial<WriteContext>) => Promise<WriteContext>;
} {
  const prisma = fakePrisma(store);
  const { spy, service } = resolver();
  const writer = new SchemaWriter(prisma.client, service);
  const loader = new SchemaLoader(prisma.client);
  return {
    prisma,
    writer,
    assertAll: spy,
    context: async (over = {}) => ({
      projectId: PROJECT,
      actorUserId: 'usr_ana',
      map: {} as ProjectPermissionMap,
      skel: {} as ProjectSkeleton,
      redacted: redact(await loader.load(PROJECT), storeContext(store)),
      ...over,
    }),
  };
}

const batch = (ops: unknown[]): SchemaOperationBatch =>
  SchemaOperationBatchSchema.parse({ batchId: 'btc_1', projectId: PROJECT, ops });

describe('SchemaWriter — optimistic concurrency (C7)', () => {
  it('409s a stale expectedVersion and names the actual one', async () => {
    const { writer, context } = harness();
    const ops = batch([
      { op: 'update', type: 'field', id: 'fld_total', expectedVersion: 2, patch: { name: 'sum' } },
    ]);

    const error = await writer.apply(ops, await context()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'VERSION_CONFLICT',
      conflicts: [{ type: 'field', id: 'fld_total', expectedVersion: 2, actualVersion: 3 }],
    });
  });

  it('carries the REDACTED current object so the client can rebase without a refetch', async () => {
    const { writer, context } = harness();
    const ops = batch([
      { op: 'update', type: 'field', id: 'fld_total', expectedVersion: 2, patch: { name: 'sum' } },
    ]);

    const error = (await writer.apply(ops, await context()).catch((e: unknown) => e)) as
      ConflictException;
    const body = error.getResponse() as { conflicts: { current: { id: string } }[] };
    // Revision 1 shipped this RAW, which let anyone with `schema:edit` read a hidden
    // field out of a deliberately-stale 409 body.
    expect(body.conflicts[0]?.current.id).toBe('fld_total');
  });

  it('rolls the batch back: a conflict on op 2 means op 1 never wrote', async () => {
    const { prisma, writer, context } = harness();
    const ops = batch([
      { op: 'update', type: 'entity', id: 'ent_orders', expectedVersion: 2, patch: { name: 'o' } },
      { op: 'update', type: 'field', id: 'fld_total', expectedVersion: 0, patch: { name: 'x' } },
    ]);

    await expect(writer.apply(ops, await context())).rejects.toThrow(ConflictException);
    // The version pre-read runs for EVERY op before any write is issued, so nothing was
    // written at all — partial application of a user gesture is worse than a retry.
    expect(prisma.callsTo('entity', 'updateMany')).toHaveLength(0);
    expect(prisma.store.entity?.[0]?.name).toBe('ent_orders');
  });

  it('guards the write itself with the version, not only the pre-read', async () => {
    const { prisma, writer, context } = harness();
    const ops = batch([
      { op: 'update', type: 'entity', id: 'ent_orders', expectedVersion: 2, patch: { name: 'o' } },
    ]);
    await writer.apply(ops, await context());

    // Atomic with the write: a commit landing between the pre-read and here loses.
    expect(prisma.callsTo('entity', 'updateMany')[0]?.args.where).toMatchObject({
      id: 'ent_orders',
      projectId: PROJECT,
      version: 2,
    });
    expect(prisma.store.entity?.[0]?.version).toBe(3);
  });
});

describe('SchemaWriter — visibility before version (§8.6 rule 1)', () => {
  it('reports not-found for an invisible target and never reads its version', async () => {
    const store = world();
    const prisma = fakePrisma(store);
    const { service } = resolver();
    const writer = new SchemaWriter(prisma.client, service);
    const raw = await new SchemaLoader(prisma.client).load(PROJECT);
    // `ent_users` is invisible and the surviving link makes it a stub, so `fld_id` — a
    // field on a stub entity — is dropped entirely by redaction.
    const redacted = redact(
      raw,
      storeContext(store, {
        visibleEntityIds: new Set(['ent_orders']),
        restrictedOkEntityIds: new Set(['ent_orders']),
      }),
    );
    prisma.calls.length = 0;

    const ops = batch([
      { op: 'update', type: 'field', id: 'fld_id', expectedVersion: 999, patch: { name: 'x' } },
    ]);
    await expect(
      writer.apply(ops, {
        projectId: PROJECT,
        actorUserId: null,
        map: {} as ProjectPermissionMap,
        skel: {} as ProjectSkeleton,
        redacted,
      }),
    ).rejects.toThrow(NotFoundException);

    // The whole point: `expectedVersion` never became a read primitive. No query ran at
    // all, so nothing could have confirmed the row exists.
    expect(prisma.calls).toHaveLength(0);
  });
});

describe('SchemaWriter — server-assigned ordinal (§8.6 rule 6)', () => {
  it('appends after the true last sibling and ignores an ordinal the client sends', async () => {
    const { prisma, writer, context } = harness();
    const ops = batch([
      {
        op: 'create',
        type: 'field',
        object: {
          id: 'fld_new',
          name: 'new',
          engineProps: {},
          entityId: 'ent_orders',
          parentFieldId: null,
          // The client sent one anyway. It is not in the payload type, so zod strips it
          // before any handler code could be tempted to trust it.
          ordinal: 0,
          type: { name: 'text' },
          isNullable: true,
          isRestricted: false,
          isPii: false,
          isDeprecated: false,
        },
      },
    ]);
    expect(ops.ops[0]).not.toHaveProperty('object.ordinal');

    await writer.apply(ops, await context());

    // max(0, 4) + 1 — computed inside the transaction, so two concurrent appends get 5
    // and 6 instead of both reading 4 and both writing 5.
    expect(prisma.callsTo('field', 'create')[0]?.args.data).toMatchObject({ position: 5 });
  });

  it('hands out consecutive ordinals to two fields created in the same gesture', async () => {
    const { prisma, writer, context } = harness();
    const object = (id: string) => ({
      id,
      name: id,
      engineProps: {},
      entityId: 'ent_orders',
      parentFieldId: null,
      type: { name: 'text' },
      isNullable: true,
      isRestricted: false,
      isPii: false,
      isDeprecated: false,
    });
    await writer.apply(
      batch([
        { op: 'create', type: 'field', object: object('fld_a') },
        { op: 'create', type: 'field', object: object('fld_b') },
      ]),
      await context(),
    );

    const positions = prisma
      .callsTo('field', 'create')
      .map((c) => (c.args.data as { position: number }).position);
    expect(positions).toEqual([5, 6]);
    // One aggregate for the pair, not one per create.
    expect(prisma.callsTo('field', 'findFirst')).toHaveLength(1);
  });
});

describe('SchemaWriter — cascades (§8.6 rule 8)', () => {
  it('reports the descendants it removed AND the owners it modified', async () => {
    const store = world();
    store.field?.push(fieldRow('fld_child', 'ent_orders', { parentFieldId: 'fld_total' }));
    const { prisma, writer, context } = harness(store);

    const result = await writer.apply(
      batch([{ op: 'delete', type: 'field', id: 'fld_total', expectedVersion: 3 }]),
      await context(),
    );

    expect(result.removed).toEqual(
      expect.arrayContaining([
        { type: 'field', id: 'fld_total' },
        { type: 'field', id: 'fld_child' },
      ]),
    );
    // The fix for revision 1's worst convergence bug: without these post-images every
    // other client keeps rendering a column that no longer exists, and every later write
    // against the index 409s permanently for a reason nobody can see.
    expect(Object.keys(result.changed.index ?? {})).toEqual(['idx_total']);
    expect(Object.keys(result.changed.constraint ?? {})).toEqual(['con_pk']);
    expect(Object.keys(result.changed.link ?? {})).toEqual(['lnk_ou']);
    expect(result.changed.index?.idx_total?.columns).toHaveLength(0);
    expect(result.changed.constraint?.con_pk?.fieldIds).toHaveLength(0);

    // Cascade-modified objects are version-bumped although the deleting client never
    // held their versions — they are exempt from `expectedVersion`, not from the bump.
    expect(prisma.store.schemaIndex?.[0]?.version).toBe(1);
  });

  it('leaves an emptied link alive as an entity-level link', async () => {
    const { writer, context } = harness();
    const result = await writer.apply(
      batch([{ op: 'delete', type: 'field', id: 'fld_total', expectedVersion: 3 }]),
      await context(),
    );
    // Dropping a column must not silently erase the relationship line a human drew.
    expect(result.removed).not.toContainEqual({ type: 'link', id: 'lnk_ou' });
    expect(result.changed.link?.lnk_ou?.from.fieldIds).toEqual([]);
  });

  it('deleting an entity removes its children and every link touching it', async () => {
    const { writer, context } = harness();
    const result = await writer.apply(
      batch([{ op: 'delete', type: 'entity', id: 'ent_orders', expectedVersion: 2 }]),
      await context(),
    );

    expect(result.removed).toEqual(
      expect.arrayContaining([
        { type: 'entity', id: 'ent_orders' },
        { type: 'field', id: 'fld_total' },
        { type: 'index', id: 'idx_total' },
        { type: 'constraint', id: 'con_pk' },
        { type: 'link', id: 'lnk_ou' },
      ]),
    );
    expect(result.changed).toEqual({});
  });

  it('refuses to delete a namespace anything still references, with a typed 422', async () => {
    const { writer, context } = harness();
    await expect(
      writer.apply(
        batch([{ op: 'delete', type: 'namespace', id: 'ns_public', expectedVersion: 0 }]),
        await context(),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('SchemaWriter — batch mechanics', () => {
  it('resolves permissions against the map it was handed, one assertAll per atom', async () => {
    const { writer, context, assertAll } = harness();
    await writer.apply(
      batch([
        { op: 'update', type: 'entity', id: 'ent_orders', expectedVersion: 2, patch: { name: 'o' } },
        { op: 'update', type: 'field', id: 'fld_note', expectedVersion: 0, patch: { name: 'n' } },
      ]),
      await context(),
    );
    // Two ops, one atom, ONE call: doc 05 §10.4's "guards never loop".
    expect(assertAll).toHaveBeenCalledTimes(1);
    const refs = assertAll.mock.calls[0]?.[2] as { type: string; id: string }[];
    expect(refs).toEqual([{ type: 'entity', id: 'ent_orders' }]);
  });

  it('checks a field on an entity created in the SAME batch against the entity’s scope', async () => {
    const { writer, context, assertAll } = harness();
    await writer.apply(
      batch([
        {
          op: 'create',
          type: 'entity',
          object: { id: 'ent_new', name: 'new', engineProps: {}, namespaceId: 'ns_public', kind: 'table', areaId: null, position: { x: 0, y: 0 }, color: null },
        },
        {
          op: 'create',
          type: 'field',
          object: { id: 'fld_new', name: 'id', engineProps: {}, entityId: 'ent_new', parentFieldId: null, type: { name: 'text' }, isNullable: true, isRestricted: false, isPii: false, isDeprecated: false },
        },
      ]),
      await context(),
    );
    // Not `entity:ent_new`: the skeleton has never heard of it, and assertAll would 404.
    const refs = assertAll.mock.calls[0]?.[2] as { type: string; id: string }[];
    expect(refs).toEqual([{ type: 'project', id: PROJECT }]);
  });

  it('stores an unnamed constraint as NULL, so two of them do not collide', async () => {
    const { prisma, writer, context } = harness();
    await writer.apply(
      batch([
        {
          op: 'create',
          type: 'constraint',
          object: { id: 'con_u', name: '', engineProps: {}, entityId: 'ent_users', kind: 'unique', fieldIds: ['fld_id'] },
        },
      ]),
      await context(),
    );
    expect(prisma.callsTo('constraint', 'create')[0]?.args.data).toMatchObject({ name: null });
  });

  it('assigns a monotonic seq from the project row, inside the transaction', async () => {
    const { prisma, writer, context } = harness();
    const result = await writer.apply(
      batch([{ op: 'update', type: 'entity', id: 'ent_orders', expectedVersion: 2, patch: {} }]),
      await context(),
    );
    expect(result.seq).toBe(42);
    expect(result.batchId).toBe('btc_1');
    expect(result.actorUserId).toBe('usr_ana');
    expect(prisma.callsTo('project', 'update')).toHaveLength(1);
  });

  // Doc 05 §9.3: the cached skeleton is keyed by `pg`, so a write that changes what the
  // skeleton says and does not bump it serves a stale area/entity list until TTL.
  it('bumps permGeneration once for a skeleton-changing batch, and not for a rename', async () => {
    const { prisma, writer, context } = harness();
    const generation = (): unknown => prisma.store.project?.[0]?.permGeneration;

    await writer.apply(
      batch([{ op: 'update', type: 'entity', id: 'ent_orders', expectedVersion: 2, patch: { name: 'orders2' } }]),
      await context(),
    );
    expect(generation()).toBe(0);

    await writer.apply(
      batch([
        { op: 'create', type: 'area', object: { id: 'are_a', name: 'A', engineProps: {}, color: 'amber', ordinal: 0 } },
        { op: 'create', type: 'area', object: { id: 'are_b', name: 'B', engineProps: {}, color: 'amber', ordinal: 1 } },
      ]),
      await context(),
    );
    expect(generation(), 'R29: one bump per batch, not per object').toBe(1);
  });

  it('refuses a batch whose body names a different project', async () => {
    const { writer, context } = harness();
    const ops = SchemaOperationBatchSchema.parse({
      batchId: 'btc_1',
      projectId: 'prj_other',
      ops: [{ op: 'delete', type: 'entity', id: 'ent_orders', expectedVersion: 2 }],
    });
    await expect(writer.apply(ops, await context())).rejects.toMatchObject({ status: 400 });
  });
});
