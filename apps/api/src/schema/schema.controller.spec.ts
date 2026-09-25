import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  VisibilityFilter,
  type PermissionResolver,
  type ProjectPermissionMap,
  type ProjectSkeleton,
} from '../access';
import { fakePrisma, type Store } from './fake-prisma';
import { PROJECT, baseStore, entityRow, fieldRow } from './fixture';
import type { GeometryWriter } from './geometry.service';
import { SchemaController } from './schema.controller';
import { SchemaLoader } from './schema-loader.service';
import type { SchemaWriter, WriteContext } from './schema-writer.service';

/**
 * Steps 13-14's two load-bearing route properties:
 *
 *  1. nothing leaves unredacted — asserted against the SERIALISED response, because that
 *     is what actually reaches the browser and the only form in which a leak is real;
 *  2. a 300-entity project costs ONE resolve (doc 05 §10.4). The resolver's unit of work
 *     is a PROJECT; if this test ever counts 300, the N+1 is back.
 */

const ENTITIES = 300;

function world(): Partial<Store> {
  const entity = Array.from({ length: ENTITIES }, (_, i) => entityRow(`ent_${String(i)}`));
  const field = [
    fieldRow('fld_total', 'ent_0'),
    fieldRow('fld_x9', 'ent_0', { position: 1, name: 'salary', isRestricted: true }),
  ];
  return baseStore({ entity, field });
}

function harness(store: Partial<Store>) {
  const entityIds = (store.entity ?? []).map((e) => String(e.id));
  const skel: ProjectSkeleton = {
    generation: 1,
    areaIds: [],
    entities: entityIds.map((id) => ({ id, areaId: null })),
    entityById: new Map(entityIds.map((id) => [id, { id, areaId: null }])),
    entitiesWithRestrictedFields: new Set(['ent_0']),
  };
  const map: ProjectPermissionMap = {
    projectId: PROJECT,
    subjectKey: 'u:ana',
    orgRole: 'member',
    projectAtoms: new Set(['schema:view']),
    areaAtoms: new Map(),
    entityOverrides: new Map(),
    restrictedFieldMode: 'mask',
    validUntil: Number.MAX_SAFE_INTEGER,
  };

  const resolver = {
    skeleton: vi.fn().mockResolvedValue(skel),
    resolveProject: vi.fn().mockResolvedValue(map),
    atomsAt: vi.fn().mockReturnValue(new Set(['schema:view'])),
    canOpenProject: vi.fn().mockReturnValue(true),
    // `ana` can see every table but holds no `field:viewRestricted` anywhere.
    visibleEntityIds: vi.fn().mockReturnValue(new Set(entityIds)),
    restrictedOkEntityIds: vi.fn().mockReturnValue(new Set<string>()),
    assertAll: vi.fn(),
  };

  const prisma = fakePrisma(store);
  const writer = { apply: vi.fn().mockResolvedValue({ seq: 1 }) };
  const geometry = { apply: vi.fn().mockResolvedValue({ seq: 1 }) };
  const controller = new SchemaController(
    new SchemaLoader(prisma.client),
    new VisibilityFilter(resolver as unknown as PermissionResolver),
    resolver as unknown as PermissionResolver,
    writer as unknown as SchemaWriter,
    geometry as unknown as GeometryWriter,
  );

  const req = {
    // What `PermissionGuard` attaches on a `@RequireProjectAccess` route: the map it
    // already paid for, and NO skeleton (§7.9 — the sidebar must not pay for one per
    // project, so this route fetches the single one it needs).
    access: { projectId: PROJECT, map, skel: null },
    auth: { kind: 'user', userId: 'usr_ana', orgId: 'org_acme' },
  } as unknown as Request;

  return { controller, resolver, req, writer, geometry };
}

describe('SchemaController — GET /projects/:projectId/ir', () => {
  it('serialises a redacted model: a restricted field’s name never reaches the wire', async () => {
    const { controller, req } = harness(world());
    const model = await controller.ir(req, PROJECT);

    expect(model.redacted).toBe(true);
    expect(model.objects.field.fld_x9).toMatchObject({ name: '', restricted: true });
    // The assertion that matters is on the BYTES. A masked field whose name survived a
    // `toJSON`, an interceptor or a spread would fail here and only here.
    expect(JSON.stringify(model)).not.toContain('salary');
    expect(JSON.stringify(model)).toContain('fld_total');
  });

  it('resolves permissions ONCE for a 300-entity project', async () => {
    const { controller, resolver, req } = harness(world());
    await controller.ir(req, PROJECT);

    // Zero, because the guard already resolved it and the handler reuses that map
    // through `redactWith` rather than `redactModel`.
    expect(resolver.resolveProject).toHaveBeenCalledTimes(0);
    // One skeleton, shared across every user of the project and cached under the project
    // generation alone.
    expect(resolver.skeleton).toHaveBeenCalledTimes(1);
    // Per-entity decisions are set lookups inside `redact`, not resolver calls.
    expect(resolver.visibleEntityIds).toHaveBeenCalledTimes(1);
    expect(resolver.restrictedOkEntityIds).toHaveBeenCalledTimes(1);
  });

  it('serves the canvas view through the same single path', async () => {
    const { controller, req } = harness(world());
    const canvas = await controller.canvas(req, PROJECT);

    expect(canvas.redacted).toBe(true);
    expect(canvas.entities).toHaveLength(ENTITIES);
    expect(JSON.stringify(canvas)).not.toContain('salary');
  });

  it('refuses when the guard attached no access context', async () => {
    const { controller } = harness(world());
    const bare = { auth: { kind: 'user', userId: 'u', orgId: 'o' } } as unknown as Request;
    await expect(controller.ir(bare, PROJECT)).rejects.toThrow();
  });
});

describe('SchemaController — writes', () => {
  it('hands the writer the redacted model, the guard’s map, and one skeleton', async () => {
    const { controller, req, writer, resolver } = harness(world());
    const body = { batchId: 'btc_1', projectId: PROJECT, ops: [] };

    await controller.ops(req, PROJECT, body);

    const context = writer.apply.mock.calls[0]?.[1] as WriteContext;
    expect(context.projectId).toBe(PROJECT);
    expect(context.actorUserId).toBe('usr_ana');
    expect(context.redacted.redacted).toBe(true);
    expect(context.redacted.objects.field.fld_x9?.name).toBe('');
    expect(resolver.resolveProject).toHaveBeenCalledTimes(0);
    expect(resolver.skeleton).toHaveBeenCalledTimes(1);
  });

  it('loads no model at all for a geometry write', async () => {
    const { controller, req, geometry } = harness(world());
    await controller.geometryWrite(req, PROJECT, { batchId: 'b', entities: [] });

    const context = geometry.apply.mock.calls[0]?.[1] as Omit<WriteContext, 'redacted'>;
    expect(context).not.toHaveProperty('redacted');
    expect(context.actorUserId).toBe('usr_ana');
  });
});
