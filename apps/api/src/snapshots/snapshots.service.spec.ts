import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { EngineDefinition, EngineRegistry } from '@schemaloom/engine-sdk';
import {
  redact,
  type RawSchemaModel,
  type SchemaModel,
  type VisibilityContext,
} from '@schemaloom/schema-model';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ProjectPermissionMap, ProjectSkeleton, VisibilityFilter } from '../access';
import { EngineGate } from '../engines';
import type { PrismaService } from '../prisma/prisma.service';
import type { SchemaOperationBatch, SchemaWriter } from '../schema';
import { fakePrisma, type Row, type Store } from '../schema/fake-prisma';
import { PROJECT, baseStore, entityRow, fieldRow, projectRow, storeContext } from '../schema/fixture';
import { blobToLive } from './live-ir';
import { liveFrom } from './test-fixture';
import { SnapshotEngineMismatchException } from './restore-guards';
import { SnapshotsService, type SnapshotContext } from './snapshots.service';

/**
 * Docker is not a test dependency. Every rule step 19 encodes — the blob is the stored
 * form, a snapshot is redacted on read, a restore goes through `SchemaWriter` and not
 * around it, a concurrent change is `project_restored` — is a rule about WHICH calls this
 * service makes, and a fake that records them tests exactly that.
 */

const CTX: SnapshotContext = {
  projectId: PROJECT,
  subject: { kind: 'user', userId: 'usr_ana', orgId: 'org_acme' },
  actorUserId: 'usr_ana',
  map: {} as unknown as ProjectPermissionMap,
  skel: {} as unknown as ProjectSkeleton,
};

const storeOf = (over: Partial<Store> = {}, pluginVersion = '1.0.0'): Partial<Store> => ({
  ...baseStore(over),
  project: [projectRow({ enginePluginVersion: pluginVersion })],
});

interface Harness {
  readonly service: SnapshotsService;
  readonly apply: Mock<(batch: SchemaOperationBatch) => Promise<unknown>>;
  /** The `snapshots` table. */
  readonly rows: Row[];
  /** The live relational store, so a test can change the schema between snapshots. */
  readonly store: Store;
  /** Make every project read AFTER the next one report a bumped `schemaRevision`. */
  readonly drift: () => void;
  readonly writeCalls: () => string[];
}

function harness(
  seed: Partial<Store>,
  over: { context?: Partial<VisibilityContext>; engine?: string; imported?: SchemaModel } = {},
): Harness {
  const fake = fakePrisma(seed);
  const base = fake.client as unknown as Record<string, unknown>;
  const projects = base.project as { findFirst: (args: Row) => Promise<Row | null> };

  let reads = 0;
  let driftAfter = Number.POSITIVE_INFINITY;
  const rows: Row[] = [];

  const client: Record<string, unknown> = {
    ...base,
    project: {
      ...projects,
      findFirst: async (args: Row = {}): Promise<Row | null> => {
        const row = await projects.findFirst(args);
        if (row === null) return null;
        reads += 1;
        const revision = row.schemaRevision as bigint;
        return { ...row, schemaRevision: reads > driftAfter ? revision + 1n : revision };
      },
    },
    snapshot: {
      create: (args: Row = {}): Promise<Row> => {
        const row: Row = {
          id: `snap_${String(rows.length + 1)}`,
          createdAt: new Date(Date.UTC(2026, 0, rows.length + 1)),
          ...(args.data as Row),
        };
        rows.push(row);
        return Promise.resolve(row);
      },
      findMany: (): Promise<Row[]> => Promise.resolve([...rows].reverse()),
      findFirst: (args: Row = {}): Promise<Row | null> => {
        const where = args.where as Row;
        return Promise.resolve(
          rows.find((r) => r.id === where.id && r.projectId === where.projectId) ?? null,
        );
      },
    },
  };

  const visibility = storeContext(seed, over.context);
  const filter = {
    contextFrom: (): VisibilityContext => visibility,
    redactWith: (raw: RawSchemaModel) => redact(raw, visibility),
  } as unknown as VisibilityFilter;

  const apply = vi.fn((batch: SchemaOperationBatch) =>
    Promise.resolve({
      batchId: batch.batchId,
      projectId: PROJECT,
      actorUserId: CTX.actorUserId,
      seq: 99,
      changed: {},
      removed: [],
    }),
  );

  const gate = new EngineGate({
    tryGet: () => ({ version: over.engine ?? '1.0.0' }) as unknown as EngineDefinition,
  } as unknown as EngineRegistry);

  return {
    service: new SnapshotsService(
      client as unknown as PrismaService,
      { apply } as unknown as SchemaWriter,
      filter,
      gate,
      {
        tryGet: () =>
          ({
            capabilities: {
              importFormats: [{ id: 'ddl' }],
              defaultNamespaceName: 'public',
              identifiers: { foldsTo: 'lower' },
            },
            importer: {
              import: () => Promise.resolve({ model: over.imported, report: { statementCount: 1 } }),
            },
          }) as unknown as EngineDefinition,
      } as unknown as EngineRegistry,
    ),
    apply,
    rows,
    store: fake.store,
    drift: () => {
      driftAfter = reads + 1;
    },
    writeCalls: () =>
      fake
        .names()
        .filter((name) => /\.(create|createMany|update|updateMany|deleteMany)$/.test(name)),
  };
}

describe('SnapshotsService.create', () => {
  it('freezes the current IR as a blob that round-trips through JSON', async () => {
    const seed = storeOf({
      entity: [entityRow('ent_a')],
      field: [fieldRow('f_a', 'ent_a')],
    });
    const h = harness(seed);

    const summary = await h.service.create(CTX, { name: 'v1', description: 'before rework' });

    const stored = h.rows[0] ?? {};
    // C3 — the blob is the ONLY place the IR is the stored form; the live schema stays
    // relational, so nothing else here writes one.
    const blob = blobToLive(JSON.parse(JSON.stringify(stored.ir)) as unknown);
    expect(blob.objects.entity).toHaveProperty('ent_a');
    expect(blob.redacted).toBe(false);
    expect(blobToLive(JSON.parse(JSON.stringify(blob)) as unknown)).toEqual(blob);

    // §15.2 — the snapshot carries its own engine stamp, taken from the project row.
    expect(summary.enginePluginVersion).toBe('1.0.0');
    expect(stored.kind).toBe('manual');
    expect(stored.createdById).toBe('usr_ana');
    expect(summary.description).toBe('before rework');
  });
});

describe('SnapshotsService.list / read', () => {
  it('lists newest first and never ships the blob in a summary', async () => {
    const h = harness(storeOf({ entity: [entityRow('ent_a')] }));
    await h.service.create(CTX, { name: 'v1' });
    await h.service.create(CTX, { name: 'v2' });

    const list = await h.service.list(PROJECT);
    expect(list.map((s) => s.name)).toEqual(['v2', 'v1']);
    expect(list[0]).not.toHaveProperty('ir');
  });

  it('redacts a snapshot on read with the CURRENT context (L18)', async () => {
    const seed = storeOf({
      entity: [entityRow('ent_a')],
      field: [fieldRow('f_secret', 'ent_a', { isRestricted: true })],
    });
    // The caller may open the project and see the entity, but not its restricted field —
    // whatever they could see on the day the snapshot was taken.
    const h = harness(seed, { context: { restrictedOkEntityIds: new Set() } });

    const { id } = await h.service.create(CTX, { name: 'v1' });
    const view = await h.service.read(CTX, id);

    expect(view.ir.redacted).toBe(true);
    expect(view.ir.objects.field.f_secret?.restricted).toBe(true);
    expect(view.ir.objects.field.f_secret?.name).toBe('');
  });
});

describe('SnapshotsService.diff', () => {
  it('produces the step-18 diff shape between two snapshots', async () => {
    const seed = storeOf({ entity: [entityRow('ent_a'), entityRow('ent_b')] });
    const h = harness(seed);

    const later = await h.service.create(CTX, { name: 'v2' });
    h.store.entity = (h.store.entity ?? []).filter((e) => e.id !== 'ent_b');
    const earlier = await h.service.create(CTX, { name: 'v1' });

    const diff = await h.service.diff(CTX, earlier.id, later.id);

    expect(diff.irVersion).toBe(1);
    expect(diff.from).toMatchObject({ kind: 'snapshot', id: earlier.id, label: 'v1' });
    expect(diff.to).toMatchObject({ kind: 'snapshot', id: later.id, label: 'v2' });
    // Both sides went through `redact` first (L18), which is what makes this diff
    // permanently ineligible for `opsFromDiff`.
    expect(diff.redacted).toBe(true);
    expect(diff.entries).toContainEqual(
      expect.objectContaining({ change: 'added', objectType: 'entity', id: 'ent_b' }),
    );
    expect(diff.summary.added).toBe(1);
  });
});

describe('SnapshotsService.restore', () => {
  const setup = (engine?: string): Harness =>
    harness(
      storeOf(
        { entity: [entityRow('ent_a'), entityRow('ent_b')] },
        engine ?? '1.0.0',
      ),
      { engine: engine ?? '1.0.0' },
    );

  /** Snapshot both entities, then drop one from the live store so restore must re-create it. */
  const snapshotThenDrop = async (h: Harness): Promise<string> => {
    const { id } = await h.service.create(CTX, { name: 'v1' });
    h.store.entity = (h.store.entity ?? []).filter((e) => e.id !== 'ent_a');
    return id;
  };

  it('applies through the schema write path, never a private one', async () => {
    const h = setup();
    const id = await snapshotThenDrop(h);

    const result = await h.service.restore(CTX, id);

    expect(h.apply).toHaveBeenCalledTimes(1);
    const batch = h.apply.mock.calls[0]?.[0];
    expect(batch?.projectId).toBe(PROJECT);
    expect(batch?.label).toBe('Restore "v1"');
    expect(batch?.ops).toEqual([
      { op: 'create', type: 'entity', object: expect.objectContaining({ id: 'ent_a' }) as unknown },
    ]);
    expect(result.seq).toBe(99);
    // Nothing in this service writes a schema row itself: `SchemaWriter` owns all of it.
    expect(h.writeCalls()).toEqual([]);
  });

  it('is a no-op when the snapshot already matches live', async () => {
    const h = setup();
    const { id } = await h.service.create(CTX, { name: 'v1' });

    const result = await h.service.restore(CTX, id);

    expect(h.apply).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual({});
  });

  it('returns 409 project_restored when the project changed mid-restore', async () => {
    const h = setup();
    const id = await snapshotThenDrop(h);
    h.drift();

    await expect(h.service.restore(CTX, id)).rejects.toMatchObject({
      status: 409,
      // Doc 02 §11 — NOT `stale_version`: the client's correct response is reload.
      response: { code: 'project_restored' },
    });
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('reports a version conflict from the write path as project_restored too', async () => {
    const h = setup();
    const id = await snapshotThenDrop(h);
    h.apply.mockRejectedValueOnce(new ConflictException({ code: 'VERSION_CONFLICT' }));

    await expect(h.service.restore(CTX, id)).rejects.toMatchObject({
      response: { code: 'project_restored' },
    });
  });

  it('refuses a caller whose view of the project is partial (R21′)', async () => {
    const h = harness(
      storeOf({ entity: [entityRow('ent_a'), entityRow('ent_b')] }),
      { context: { visibleEntityIds: new Set(['ent_a']) } },
    );
    const { id } = await h.service.create(CTX, { name: 'v1' });

    await expect(h.service.restore(CTX, id)).rejects.toThrow(ForbiddenException);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('refuses a snapshot taken under a different engine MAJOR (§15.2)', async () => {
    const h = setup();
    const id = await snapshotThenDrop(h);
    const row = h.rows[0];
    if (row !== undefined) row.enginePluginVersion = '0.9.0';

    await expect(h.service.restore(CTX, id)).rejects.toThrow(SnapshotEngineMismatchException);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('still restores a snapshot taken under an older PATCH', async () => {
    const h = setup('1.4.2');
    const id = await snapshotThenDrop(h);
    const row = h.rows[0];
    if (row !== undefined) row.enginePluginVersion = '1.4.0';

    await h.service.restore(CTX, id);
    expect(h.apply).toHaveBeenCalledTimes(1);
  });
});

describe('SnapshotsService.importSource', () => {
  /** What the importer hands back: its OWN default namespace id, as a real one does. */
  const importedModel = async (): Promise<SchemaModel> => {
    const live = await liveFrom(storeOf({ entity: [entityRow('ent_a')] }));
    return JSON.parse(JSON.stringify(live).replaceAll('"ns_public"', '"ns_imported"')) as SchemaModel;
  };

  it('creates the imported objects inside the project’s own default namespace', async () => {
    const h = harness(storeOf(), { imported: await importedModel() });

    await h.service.importSource(CTX, 'CREATE TABLE a ();');

    const ops = h.apply.mock.calls[0]?.[0].ops;
    expect(ops).toEqual([
      {
        op: 'create',
        type: 'entity',
        object: expect.objectContaining({ id: 'ent_a', namespaceId: 'ns_public' }) as unknown,
      },
    ]);
  });

  it('refuses a project that already has tables (no merge rules yet)', async () => {
    const h = harness(storeOf({ entity: [entityRow('ent_b')] }), { imported: await importedModel() });

    await expect(h.service.importSource(CTX, 'CREATE TABLE a ();')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(h.apply).not.toHaveBeenCalled();
  });
});
