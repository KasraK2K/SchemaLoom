import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { EngineDefinition, EngineRegistry, ImportedDoc } from '@schemaloom/engine-sdk';
import {
  redact,
  type RawSchemaModel,
  type SchemaModel,
  type VisibilityContext,
} from '@schemaloom/schema-model';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type {
  PermissionResolver,
  ProjectPermissionMap,
  ProjectSkeleton,
  VisibilityFilter,
} from '../access';
import type { DocsService } from '../docs';
import { EngineGate } from '../engines';
import { ENGINE_MANIFEST } from '../engines/engines.manifest';
import type { PrismaService } from '../prisma/prisma.service';
import type { SchemaOperationBatch, SchemaWriter, WriteContext } from '../schema';
import { fakePrisma, type Row, type Store } from '../schema/fake-prisma';
import {
  PROJECT,
  baseStore,
  entityRow,
  fieldRow,
  projectRow,
  storeContext,
} from '../schema/fixture';
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
  readonly apply: Mock<(batch: SchemaOperationBatch, ctx?: WriteContext) => Promise<unknown>>;
  /** The `snapshots` table. */
  readonly rows: Row[];
  /** The live relational store, so a test can change the schema between snapshots. */
  readonly store: Store;
  /** Make every project read AFTER the next one report a bumped `schemaRevision`. */
  readonly drift: () => void;
  readonly writeCalls: () => string[];
  readonly importDocs: Mock<DocsService['importDocs']>;
}

function harness(
  seed: Partial<Store>,
  over: {
    context?: Partial<VisibilityContext>;
    engine?: string;
    imported?: SchemaModel;
    /** `ImportResult.docs` from the fake importer */
    importedDocs?: readonly ImportedDoc[];
    /** the real registered engine, for the migration routes */
    realEngine?: boolean;
  } = {},
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
      findMany: (args: Row = {}): Promise<Row[]> => {
        const where = (args.where ?? {}) as Row;
        const notKind = (where.kind as Row | undefined)?.not;
        const hits = [...rows].reverse().filter((r) => notKind === undefined || r.kind !== notKind);
        return Promise.resolve(hits.slice((args.skip as number | undefined) ?? 0));
      },
      deleteMany: (args: Row = {}): Promise<{ count: number }> => {
        const where = args.where as Row;
        const ids = (where.id as Row | undefined)?.in as string[] | undefined;
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const r = rows[i]!;
          const idOk = ids === undefined ? r.id === where.id : ids.includes(r.id as string);
          const kind = where.kind as string | Row | undefined;
          const kindOk =
            kind === undefined ||
            (typeof kind === 'string' ? r.kind === kind : r.kind !== kind.not);
          if (idOk && r.projectId === where.projectId && kindOk) {
            rows.splice(i, 1);
          }
        }
        return Promise.resolve({ count: before - rows.length });
      },
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

  // Stands in for `SchemaWriter.apply`: runs the in-transaction hook (the auto snapshot)
  // and mirrors `update { name }` into the store, so a re-read after a rename sees it.
  const apply = vi.fn(async (batch: SchemaOperationBatch, ctx?: WriteContext) => {
    await ctx?.beforeWrite?.(client as never);
    for (const op of batch.ops) {
      if (op.op !== 'update' || !('name' in op.patch)) continue;
      const row = (fake.store[op.type] ?? []).find((r) => r.id === op.id);
      if (row !== undefined) row.name = op.patch.name;
    }
    return {
      batchId: batch.batchId,
      projectId: PROJECT,
      actorUserId: CTX.actorUserId,
      seq: 99,
      changed: {},
      removed: [],
    };
  });

  const importDocs = vi.fn<DocsService['importDocs']>((_s, _p, docs) =>
    Promise.resolve(docs.length),
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
          over.realEngine === true
            ? ENGINE_MANIFEST[0]
            : ({
                capabilities: {
                  importFormats: [{ id: 'ddl' }],
                  defaultNamespaceName: 'public',
                  identifiers: { foldsTo: 'lower' },
                },
                importer: {
                  import: () =>
                    Promise.resolve({
                      model: over.imported,
                      report: { statementCount: 1 },
                      docs: over.importedDocs,
                    }),
                },
              } as unknown as EngineDefinition),
      } as unknown as EngineRegistry,
      {
        resolveProject: () => Promise.resolve(CTX.map),
        skeleton: () => Promise.resolve(CTX.skel),
      } as unknown as PermissionResolver,
      { importDocs } as unknown as DocsService,
    ),
    importDocs,
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
    harness(storeOf({ entity: [entityRow('ent_a'), entityRow('ent_b')] }, engine ?? '1.0.0'), {
      engine: engine ?? '1.0.0',
    });

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
    const h = harness(storeOf({ entity: [entityRow('ent_a'), entityRow('ent_b')] }), {
      context: { visibleEntityIds: new Set(['ent_a']) },
    });
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
    return JSON.parse(
      JSON.stringify(live).replaceAll('"ns_public"', '"ns_imported"'),
    ) as SchemaModel;
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

  it('merges into a project that already has tables, touching nothing that exists', async () => {
    const h = harness(storeOf({ entity: [entityRow('ent_a'), entityRow('ent_b')] }), {
      imported: await importedModel(),
    });

    const { existing } = await h.service.importSource(CTX, 'CREATE TABLE ent_a ();');

    expect(existing).toEqual(['ent_a']);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('re-resolves the skeleton between batches, so batch 2 can see batch 1’s tables', async () => {
    const entity = Array.from({ length: 1500 }, (_, i) => entityRow(`ent_${String(i)}`));
    const field = entity.map((e, i) => fieldRow(`fld_${String(i)}`, e.id as string));
    const imported = await liveFrom(storeOf({ entity, field }));
    const h = harness(storeOf(), { imported });
    const skeleton = vi.fn(() => Promise.resolve(CTX.skel));
    (h.service as unknown as { resolver: { skeleton: typeof skeleton } }).resolver.skeleton =
      skeleton;

    await h.service.importSource(CTX, 'CREATE TABLE …');

    expect(h.apply.mock.calls.map(([batch]) => batch.ops.length)).toEqual([2000, 1000]);
    expect(skeleton).toHaveBeenCalledTimes(1);
  });

  it('hands comments to the docs module under LIVE ids, after the schema writes', async () => {
    // The imported `ent_x` matches live `ent_a` by key; `ent_new` is created as is.
    const imported = JSON.parse(
      JSON.stringify(
        await liveFrom(storeOf({ entity: [entityRow('ent_a'), entityRow('ent_new')] })),
      )
        .replaceAll('"ns_public"', '"ns_imported"')
        .replaceAll('"ent_a"', '"ent_x"'),
    ) as SchemaModel;
    const named = imported.objects.entity.ent_x;
    if (named !== undefined) imported.objects.entity.ent_x = { ...named, name: 'ent_a' };
    const h = harness(storeOf({ entity: [entityRow('ent_a')] }), {
      imported,
      importedDocs: [
        { target: { type: 'entity', id: 'ent_x' }, text: 'existing table' },
        { target: { type: 'entity', id: 'ent_new' }, text: 'new table' },
      ],
    });

    const outcome = await h.service.importSource(CTX, 'CREATE TABLE …');

    expect(h.importDocs).toHaveBeenCalledWith(CTX.subject, CTX.projectId, [
      { targetType: 'entity', targetId: 'ent_a', text: 'existing table' },
      { targetType: 'entity', targetId: 'ent_new', text: 'new table' },
    ]);
    expect(outcome.documented).toBe(2);
    const docsCall = h.importDocs.mock.invocationCallOrder[0] ?? 0;
    expect(docsCall).toBeGreaterThan(h.apply.mock.invocationCallOrder[0] ?? Infinity);
  });
});

describe('SnapshotsService.liveDiff (Phase 4 §1.1)', () => {
  it('diffs snapshot → live with both sides redacted; a hidden addition is not there (L18, L8)', async () => {
    const seed = storeOf({ entity: [entityRow('ent_a')] });
    const h = harness(seed, { context: { visibleEntityIds: new Set(['ent_a', 'ent_new']) } });
    const { id } = await h.service.create(CTX, { name: 'v1' });
    h.store.entity?.push(entityRow('ent_new'), entityRow('ent_hidden'));

    const diff = await h.service.liveDiff(CTX, id);

    expect(diff.to).toEqual({ kind: 'live' });
    expect(diff.redacted).toBe(true);
    const ids = diff.entries.map((e) => e.id);
    expect(ids).toContain('ent_new');
    expect(ids).not.toContain('ent_hidden');
    expect(JSON.stringify(diff)).not.toContain('ent_hidden');
    // Counts are post-redaction: one add, not two.
    expect(diff.counts).toEqual({ added: 1, removed: 0, changed: 0, structural: 1, governance: 0 });
    expect(diff.fullView).toBe(false);
  });

  it('counts a changed property by severity', async () => {
    const h = harness(storeOf({ entity: [entityRow('ent_a')] }));
    const { id } = await h.service.create(CTX, { name: 'v1' });
    const row = h.store.entity?.[0];
    if (row !== undefined) row.name = 'renamed';

    const diff = await h.service.liveDiff(CTX, id);
    expect(diff.counts.changed).toBe(1);
    expect(diff.counts.structural).toBe(1);
    expect(diff.fullView).toBe(true);
  });

  it('is 404 for a snapshot of another project', async () => {
    const h = harness(storeOf());
    await expect(h.service.liveDiff(CTX, 'snap_nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('SnapshotsService.migration (Phase 5 §3)', () => {
  const OPTIONS = { allowDestructive: false, transactional: true };

  it('plans snapshot → live with the engine and renders the whole script', async () => {
    const seed = storeOf({ entity: [entityRow('ent_a')] });
    const all = new Set(['ent_a', 'ent_new']);
    const h = harness(seed, {
      realEngine: true,
      context: { visibleEntityIds: all, restrictedOkEntityIds: all, totalEntityCount: 2 },
    });
    const { id } = await h.service.create(CTX, { name: 'v1' });
    h.store.entity?.push(entityRow('ent_new', { name: 'invoices' }));
    h.store.field?.push(fieldRow('fld_n', 'ent_new', { name: 'total' }));

    const view = await h.service.migration(CTX, id, null, OPTIONS);

    expect(view.steps.map((s) => s.kind)).toEqual(['CREATE TABLE']);
    expect(view.steps[0]?.covers).toContainEqual({ type: 'field', id: 'fld_n' });
    expect(view.script).toBe(
      ['BEGIN;', '', 'CREATE TABLE public.invoices (', '  total text', ');', '', 'COMMIT;'].join(
        '\n',
      ),
    );
    expect(view.fileExtension).toBe('sql');
    expect(h.writeCalls()).toEqual([]); // generating writes nothing
  });

  it('comments a DROP TABLE out, names it in the reason, and runs it only when allowed', async () => {
    const h = harness(
      storeOf({ entity: [entityRow('ent_a'), entityRow('ent_b', { name: 'legacy' })] }),
      {
        realEngine: true,
      },
    );
    const { id } = await h.service.create(CTX, { name: 'v1' });
    h.store.entity = (h.store.entity ?? []).filter((e) => e.id !== 'ent_b');

    const guarded = await h.service.migration(CTX, id, null, OPTIONS);
    expect(guarded.steps).toMatchObject([
      { text: 'DROP TABLE public.legacy', destructive: true, commentedOut: true },
    ]);
    expect(guarded.steps[0]?.reason).toContain('legacy');
    expect(guarded.script).toContain('-- DROP TABLE public.legacy;');

    const allowed = await h.service.migration(CTX, id, null, {
      ...OPTIONS,
      allowDestructive: true,
    });
    expect(allowed.steps[0]?.commentedOut).toBe(false);
  });

  it('diffs two snapshots in the direction asked', async () => {
    const h = harness(storeOf({ entity: [entityRow('ent_a')] }), { realEngine: true });
    const v1 = await h.service.create(CTX, { name: 'v1' });
    const row = h.store.entity?.[0];
    if (row !== undefined) row.name = 'accounts';
    const v2 = await h.service.create(CTX, { name: 'v2' });

    const view = await h.service.migration(CTX, v1.id, v2.id, { ...OPTIONS, transactional: false });
    expect(view.script).toBe('ALTER TABLE public.ent_a RENAME TO accounts;');
  });

  it('refuses a partial view before reading anything (R21′, Q1)', async () => {
    const h = harness(storeOf({ entity: [entityRow('ent_a'), entityRow('ent_b')] }), {
      realEngine: true,
      context: { visibleEntityIds: new Set(['ent_a']) },
    });
    const { id } = await h.service.create(CTX, { name: 'v1' });
    await expect(h.service.migration(CTX, id, null, OPTIONS)).rejects.toThrow(ForbiddenException);
  });

  it('is 404 for a snapshot of another project', async () => {
    const h = harness(storeOf(), { realEngine: true });
    await expect(h.service.migration(CTX, 'snap_nope', null, OPTIONS)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('is 422 when the engine ships no migration generator', async () => {
    const h = harness(storeOf());
    const { id } = await h.service.create(CTX, { name: 'v1' });
    await expect(h.service.migration(CTX, id, null, OPTIONS)).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('SnapshotsService.drift (Phase 6 §6)', () => {
  const OPTIONS = { allowDestructive: false, transactional: false };

  it('matches the same table by logical key and plans the database toward the design', async () => {
    const h = harness(storeOf({ entity: [entityRow('ent_a')] }), { realEngine: true });

    const { diff, migration } = await h.service.drift(
      CTX,
      'CREATE TABLE public.ent_a (); CREATE TABLE public.legacy (id integer);',
      1_000_000,
      OPTIONS,
    );

    // ent_a is on both sides, so only the database's extra table differs.
    expect(diff.entries.map((e) => [e.change, e.objectType])).toEqual([
      ['removed', 'entity'],
      ['removed', 'field'],
    ]);
    expect(migration.steps).toMatchObject([
      { text: 'DROP TABLE public.legacy', destructive: true, commentedOut: true },
    ]);
    expect(h.writeCalls()).toEqual([]);
  });

  it('refuses a partial view (R21′)', async () => {
    const h = harness(storeOf({ entity: [entityRow('ent_a')] }), {
      realEngine: true,
      context: { totalEntityCount: 2 },
    });
    await expect(h.service.drift(CTX, 'CREATE TABLE t ();', 1_000_000, OPTIONS)).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('SnapshotsService.remove', () => {
  it('deletes a manual snapshot', async () => {
    const h = harness(storeOf());
    const { id } = await h.service.create(CTX, { name: 'v1' });
    await h.service.remove(CTX, id);
    expect(h.rows).toEqual([]);
  });

  it('refuses an automatic snapshot with 409 and keeps it', async () => {
    const h = harness(storeOf());
    const { id } = await h.service.create(CTX, { name: 'v1' });
    const row = h.rows[0];
    if (row !== undefined) row.kind = 'import';
    await expect(h.service.remove(CTX, id)).rejects.toMatchObject({
      status: 409,
      response: { code: 'snapshot_not_manual' },
    });
    expect(h.rows).toHaveLength(1);
  });

  it('is 404 for an unknown id', async () => {
    const h = harness(storeOf());
    await expect(h.service.remove(CTX, 'snap_x')).rejects.toMatchObject({ status: 404 });
  });
});

describe('automatic snapshots (Phase 4 Q4)', () => {
  it('writes kind=restore inside the restore batch, holding the pre-restore model', async () => {
    const h = harness(storeOf({ entity: [entityRow('ent_a'), entityRow('ent_b')] }));
    const { id } = await h.service.create(CTX, { name: 'v1' });
    h.store.entity = (h.store.entity ?? []).filter((e) => e.id !== 'ent_a');

    await h.service.restore(CTX, id);

    const auto = h.rows.find((r) => r.kind === 'restore');
    expect(auto?.name).toBe('Before restore "v1"');
    const blob = blobToLive(JSON.parse(JSON.stringify(auto?.ir)) as unknown);
    expect(Object.keys(blob.objects.entity)).toEqual(['ent_b']);
  });

  it('writes nothing for a no-op restore', async () => {
    const h = harness(storeOf({ entity: [entityRow('ent_a')] }));
    const { id } = await h.service.create(CTX, { name: 'v1' });
    await h.service.restore(CTX, id);
    expect(h.rows.map((r) => r.kind)).toEqual(['manual']);
  });
});

describe('SnapshotsService.importSource with confirmed renames (Phase 4 Q1)', () => {
  /** The SQL renames `customer` → `customers`, columns unchanged. */
  const renamedSql = async (): Promise<SchemaModel> => {
    const imported = await liveFrom(
      storeOf({
        entity: [entityRow('ent_sql', { name: 'customers' })],
        field: [
          fieldRow('fs_id', 'ent_sql', { name: 'id', position: 0 }),
          fieldRow('fs_mail', 'ent_sql', { name: 'email_address', position: 1 }),
          fieldRow('fs_name', 'ent_sql', { name: 'name', position: 2 }),
        ],
      }),
    );
    return JSON.parse(
      JSON.stringify(imported).replaceAll('"ns_public"', '"ns_imported"'),
    ) as SchemaModel;
  };
  const project = () =>
    storeOf({
      entity: [entityRow('ent_customer', { name: 'customer', version: 3 })],
      field: [
        fieldRow('f_id', 'ent_customer', { name: 'id', position: 0 }),
        fieldRow('f_mail', 'ent_customer', { name: 'email', position: 1, version: 2 }),
        fieldRow('f_name', 'ent_customer', { name: 'name', position: 2 }),
      ],
    });

  it('previews creates, existing and candidates without writing anything', async () => {
    const h = harness(project(), { imported: await renamedSql() });

    const preview = await h.service.preview(CTX, 'CREATE TABLE customers (...)');

    expect(preview.creates).toEqual(['customers']);
    expect(preview.existing).toEqual([]);
    expect(preview.renameCandidates).toEqual([
      expect.objectContaining({ type: 'entity', fromId: 'ent_customer', toName: 'customers' }),
      expect.objectContaining({
        type: 'field',
        entityId: 'ent_customer',
        fromId: 'f_mail',
        toName: 'email_address',
      }),
    ]);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.rows).toEqual([]);
    expect(h.writeCalls()).toEqual([]);
  });

  it('reads the format the caller names, and refuses one the engine lacks (Phase 7b)', async () => {
    const h = harness(project(), { realEngine: true });
    const prisma = [
      'datasource db {',
      '  provider = "postgresql"',
      '  url      = env("DATABASE_URL")',
      '}',
      'model invoices {',
      '  id Int @id',
      '}',
    ].join('\n');

    const preview = await h.service.preview(CTX, prisma, undefined, 'prisma');
    expect(preview.creates).toEqual(['invoices']);

    await expect(h.service.preview(CTX, prisma, undefined, 'yaml')).rejects.toMatchObject({
      status: 422,
      response: { code: 'import_format_unsupported', format: 'yaml' },
    });
    expect(h.writeCalls()).toEqual([]);
  });

  it('applies the renames FIRST as update ops, keeping ids, then merges additively', async () => {
    const h = harness(project(), { imported: await renamedSql() });

    const outcome = await h.service.importSource(CTX, 'CREATE TABLE customers (...)', undefined, [
      { type: 'entity', fromId: 'ent_customer', toName: 'customers' },
      { type: 'field', fromId: 'f_mail', toName: 'email_address' },
    ]);

    const first = h.apply.mock.calls[0]?.[0];
    expect(first?.ops).toEqual(
      expect.arrayContaining([
        {
          op: 'update',
          type: 'entity',
          id: 'ent_customer',
          expectedVersion: 3,
          patch: { name: 'customers' },
        },
        {
          op: 'update',
          type: 'field',
          id: 'f_mail',
          expectedVersion: 2,
          patch: { name: 'email_address' },
        },
      ]),
    );
    // After the rename the SQL table matches by key: nothing is created, the id survives,
    // so docs, comments, grants and saved-query links (all keyed by id) follow it.
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(outcome.existing).toEqual(['customers']);
    expect(h.store.entity?.map((e) => e.id)).toEqual(['ent_customer']);
    // Q4: exactly one import snapshot, of the model BEFORE the rename.
    const autos = h.rows.filter((r) => r.kind === 'import');
    expect(autos).toHaveLength(1);
    const blob = blobToLive(JSON.parse(JSON.stringify(autos[0]?.ir)) as unknown);
    expect(blob.objects.entity.ent_customer?.name).toBe('customer');
  });

  it('without renames keeps both tables (additive) and still snapshots first', async () => {
    const h = harness(project(), { imported: await renamedSql() });
    await h.service.importSource(CTX, 'CREATE TABLE customers (...)');
    expect(h.apply.mock.calls[0]?.[0].ops.every((op) => op.op === 'create')).toBe(true);
    expect(h.rows.filter((r) => r.kind === 'import')).toHaveLength(1);
  });

  it('writes no snapshot when the import changes nothing', async () => {
    const h = harness(storeOf({ entity: [entityRow('ent_a')] }), {
      imported: JSON.parse(
        JSON.stringify(await liveFrom(storeOf({ entity: [entityRow('ent_a')] }))),
      ) as SchemaModel,
    });
    await h.service.importSource(CTX, 'CREATE TABLE ent_a ();');
    expect(h.rows).toEqual([]);
  });

  it.each([
    [{ type: 'entity', fromId: 'ent_nope', toName: 'customers' }, 'unknown_id'],
    [{ type: 'entity', fromId: 'ent_customer', toName: 'nothing_like_it' }, 'unknown_target'],
    [{ type: 'field', fromId: 'f_mail', toName: 'email_address' }, 'entity_not_matched'],
    [{ type: 'field', fromId: 'f_nope', toName: 'x' }, 'unknown_id'],
  ] as const)('refuses %o (%s) before writing anything', async (rename, reason) => {
    const h = harness(project(), { imported: await renamedSql() });
    await expect(
      h.service.importSource(CTX, 'CREATE TABLE customers (...)', undefined, [rename]),
    ).rejects.toMatchObject({ status: 422, response: { code: 'invalid_rename', reason } });
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.rows).toEqual([]);
  });

  it('refuses a duplicate rename', async () => {
    const h = harness(project(), { imported: await renamedSql() });
    const rename = { type: 'entity', fromId: 'ent_customer', toName: 'customers' } as const;
    await expect(
      h.service.importSource(CTX, 'x', undefined, [rename, rename]),
    ).rejects.toMatchObject({ response: { reason: 'duplicate' } });
  });

  it('refuses a rename across namespaces', async () => {
    const seed = project();
    seed.namespace?.push({
      ...seed.namespace[0]!,
      id: 'ns_billing',
      name: 'billing',
      isDefault: false,
    });
    const entity = seed.entity?.[0];
    if (entity !== undefined) entity.namespaceId = 'ns_billing';
    const h = harness(seed, { imported: await renamedSql() });
    await expect(
      h.service.importSource(CTX, 'x', undefined, [
        { type: 'entity', fromId: 'ent_customer', toName: 'customers' },
      ]),
    ).rejects.toMatchObject({ response: { reason: 'cross_namespace' } });
  });
});
