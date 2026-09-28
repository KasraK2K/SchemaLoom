import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type {
  EngineRegistry,
  IdentifierResolution,
  QueryValidationResult,
  QueryValidator,
} from '@schemaloom/engine-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  VisibilityFilter,
  type PermissionResolver,
  type ProjectPermissionMap,
  type ProjectSkeleton,
  type Subject,
} from '../access';
import { fakePrisma, type FakePrisma, type Row } from '../schema/fake-prisma';
import { PROJECT, baseStore, entityRow, fieldRow } from '../schema/fixture';
import { SchemaLoader } from '../schema/schema-loader.service';
import { SavedQueriesService, identifiersResolved } from './saved-queries.service';

/**
 * Doc 05 §12.1's analyst. In March she sees everything; in April she is narrowed to
 * Billing (`ent_emp`) without `field:viewRestricted`, so `ent_prod` is gone and `fld_sal`
 * is a mask stub.
 */

const ANA: Subject = { kind: 'user', userId: 'usr_ana', orgId: 'org_1' };
const BEN: Subject = { kind: 'user', userId: 'usr_ben', orgId: 'org_1' };

const world = () =>
  baseStore({
    entity: [entityRow('ent_prod'), entityRow('ent_emp')],
    field: [
      fieldRow('fld_prod_id', 'ent_prod'),
      fieldRow('fld_emp_name', 'ent_emp'),
      fieldRow('fld_sal', 'ent_emp', { position: 1, isRestricted: true }),
    ],
  });

interface View {
  visible: string[];
  restrictedOk: string[];
  manage?: boolean;
  open?: boolean;
}
const MARCH: View = { visible: ['ent_prod', 'ent_emp'], restrictedOk: ['ent_prod', 'ent_emp'] };
const APRIL: View = { visible: ['ent_emp'], restrictedOk: [] };

const skel: ProjectSkeleton = {
  generation: 1,
  areaIds: [],
  entities: [
    { id: 'ent_prod', areaId: null },
    { id: 'ent_emp', areaId: null },
  ],
  entityById: new Map([
    ['ent_prod', { id: 'ent_prod', areaId: null }],
    ['ent_emp', { id: 'ent_emp', areaId: null }],
  ]),
  entitiesWithRestrictedFields: new Set(['ent_emp']),
};

function resolverFor(views: Record<string, View>): PermissionResolver {
  const of = (map: ProjectPermissionMap): View => views[map.subjectKey] ?? MARCH;
  return {
    resolveProject: vi.fn((s: Subject) =>
      Promise.resolve({ subjectKey: s.kind === 'user' ? s.userId : 'link' } as ProjectPermissionMap),
    ),
    skeleton: vi.fn().mockResolvedValue(skel),
    canOpenProject: (m: ProjectPermissionMap) => of(m).open ?? true,
    visibleEntityIds: (m: ProjectPermissionMap) => new Set(of(m).visible),
    restrictedOkEntityIds: (m: ProjectPermissionMap) => new Set(of(m).restrictedOk),
    atomsAt: (m: ProjectPermissionMap) =>
      new Set(of(m).manage === true ? ['schema:view', 'sharing:manage'] : ['schema:view']),
  } as unknown as PermissionResolver;
}

const ident = (over: Partial<IdentifierResolution>): IdentifierResolution => ({
  text: 'x',
  range: { start: 0, end: 1 } as IdentifierResolution['range'],
  role: 'entity',
  status: 'resolved',
  targetId: null,
  entityId: null,
  messageCode: null,
  messageParams: {},
  suggestions: [],
  ...over,
});

const result = (over: Partial<QueryValidationResult> = {}): QueryValidationResult => ({
  parsed: true,
  parseErrors: [],
  identifiers: [ident({ status: 'resolved' })],
  touchedEntityIds: ['ent_prod', 'ent_emp'],
  touchedFieldIds: ['fld_prod_id', 'fld_sal'],
  hiddenReferences: [],
  statementKinds: ['SELECT'],
  ...over,
});

function harness(
  views: Record<string, View> = {},
  validator: QueryValidator | null = { validate: vi.fn().mockResolvedValue(result()) },
  seed: Row[] = [],
): { prisma: FakePrisma; service: SavedQueriesService } {
  const prisma = fakePrisma({ ...world(), savedQuery: seed });
  const resolver = resolverFor(views);
  const registry = { tryGet: () => ({ queryValidator: validator ?? undefined }) } as unknown as EngineRegistry;
  const service = new SavedQueriesService(
    prisma.client,
    new SchemaLoader(prisma.client),
    new VisibilityFilter(resolver),
    resolver,
    registry,
  );
  return { prisma, service };
}

const mapOf = (s: Subject) => ({ subjectKey: s.kind === 'user' ? s.userId : 'link' }) as ProjectPermissionMap;

const savedRow = (over: Row = {}): Row => ({
  id: 'sq_1',
  projectId: PROJECT,
  createdById: 'usr_ana',
  name: 'salaries',
  description: null,
  queryText: 'SELECT p.name, e.salary FROM products p JOIN employees e ON true',
  language: 'sql',
  tags: ['hr'],
  identifiersResolved: true,
  touchedEntityIds: ['ent_prod', 'ent_emp'],
  touchedFieldIds: ['fld_prod_id', 'fld_sal'],
  version: 0,
  ...over,
});

describe('identifiersResolved', () => {
  it('is strict: anything unknown, ambiguous, hidden or unparsed is false', () => {
    expect(identifiersResolved(result())).toBe(true);
    expect(identifiersResolved(result({ identifiers: [ident({ status: 'alias-local', role: 'alias' })] }))).toBe(true);
    expect(identifiersResolved(result({ identifiers: [ident({ status: 'unchecked', role: 'function' })] }))).toBe(true);
    expect(identifiersResolved(result({ identifiers: [ident({ status: 'unchecked', role: 'field' })] }))).toBe(false);
    expect(identifiersResolved(result({ identifiers: [ident({ status: 'unknown' })] }))).toBe(false);
    expect(identifiersResolved(result({ identifiers: [ident({ status: 'ambiguous' })] }))).toBe(false);
    expect(identifiersResolved(result({ parsed: false }))).toBe(false);
  });
});

describe('SavedQueriesService.create', () => {
  it('writes the flag, the touched arrays and the join rows in ONE transaction', async () => {
    const { prisma, service } = harness();
    let inside: string[] = [];
    const tx = prisma.client.$transaction.bind(prisma.client) as (fn: (t: unknown) => Promise<unknown>) => Promise<unknown>;
    (prisma.client as unknown as { $transaction: typeof tx }).$transaction = async (fn) => {
      const before = prisma.calls.length;
      const out = await tx(fn);
      inside = prisma.names().slice(before);
      return out;
    };

    const view = await service.create(ANA, PROJECT, mapOf(ANA), { name: 'q', queryText: 'SELECT 1' });

    expect(inside).toEqual(['savedQuery.create', 'savedQueryEntity.createMany']);
    expect(prisma.store.savedQuery?.[0]).toMatchObject({
      identifiersResolved: true,
      touchedEntityIds: ['ent_prod', 'ent_emp'],
      touchedFieldIds: ['fld_prod_id', 'fld_sal'],
      createdById: 'usr_ana',
    });
    expect(prisma.store.savedQueryEntity?.map((r) => r.entityId)).toEqual(['ent_prod', 'ent_emp']);
    expect(view.canEdit).toBe(true);
  });

  it('validates against the CALLER’s redacted model, with no restrictedProbe', async () => {
    const validate = vi.fn().mockResolvedValue(result());
    const { service } = harness({ usr_ana: APRIL }, { validate });
    await service.create(ANA, PROJECT, mapOf(ANA), { name: 'q', queryText: 'SELECT 1' });
    const input = validate.mock.calls[0]?.[0] as { model: { objects: { entity: object } }; restrictedProbe?: unknown };
    expect(Object.keys(input.model.objects.entity)).toEqual(['ent_emp']);
    expect(input.restrictedProbe).toBeUndefined();
  });

  it('saves identifiersResolved=false with no join rows when the engine has no validator', async () => {
    const { prisma, service } = harness({}, null);
    await service.create(ANA, PROJECT, mapOf(ANA), { name: 'q', queryText: 'SELECT 1' });
    expect(prisma.store.savedQuery?.[0]).toMatchObject({ identifiersResolved: false, touchedEntityIds: [] });
    expect(prisma.store.savedQueryEntity).toEqual([]);
  });

  it('still saves an unresolved query, flagged false', async () => {
    const { prisma, service } = harness({}, {
      validate: vi.fn().mockResolvedValue(result({ identifiers: [ident({ status: 'unknown' })] })),
    });
    await service.create(ANA, PROJECT, mapOf(ANA), { name: 'q', queryText: 'SELECT * FROM nope' });
    expect(prisma.store.savedQuery?.[0]?.identifiersResolved).toBe(false);
  });
});

describe('SavedQueriesService reads (L25)', () => {
  it('April narrowing: her March query is absent from the list and 404s by id', async () => {
    const { service } = harness({ usr_ana: APRIL }, null, [savedRow()]);
    expect(await service.list(ANA, PROJECT, mapOf(ANA))).toEqual([]);
    await expect(service.get(ANA, 'sq_1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the same row is served to a complete view', async () => {
    const { service } = harness({}, null, [savedRow()]);
    const list = await service.list(ANA, PROJECT, mapOf(ANA));
    expect(list.map((q) => q.id)).toEqual(['sq_1']);
    expect((await service.get(ANA, 'sq_1')).touchedEntityIds).toEqual(['ent_prod', 'ent_emp']);
  });

  it('an unresolved row is served only to a complete view', async () => {
    const seed = [savedRow({ identifiersResolved: false, touchedEntityIds: [], touchedFieldIds: [] })];
    expect(await harness({ usr_ana: APRIL }, null, seed).service.list(ANA, PROJECT, mapOf(ANA))).toEqual([]);
    expect(await harness({}, null, seed).service.list(ANA, PROJECT, mapOf(ANA))).toHaveLength(1);
  });

  it('filters by tag and orders newest updated first', async () => {
    const seed = [
      savedRow({ id: 'sq_old', updatedAt: '2026-01-01', tags: ['hr'] }),
      savedRow({ id: 'sq_new', updatedAt: '2026-06-01', tags: ['hr'] }),
      savedRow({ id: 'sq_other', updatedAt: '2026-07-01', tags: ['ops'] }),
    ];
    const { service } = harness({}, null, seed);
    const list = await service.list(ANA, PROJECT, mapOf(ANA), 'hr');
    expect(list.map((q) => q.id)).toEqual(['sq_new', 'sq_old']);
  });
});

describe('SavedQueriesService update/delete authorisation', () => {
  it('the creator may edit and delete', async () => {
    const { prisma, service } = harness({}, null, [savedRow()]);
    await service.update(ANA, 'sq_1', { name: 'renamed' });
    expect(prisma.store.savedQuery?.[0]).toMatchObject({ name: 'renamed', version: 1 });
    await service.remove(ANA, 'sq_1');
    expect(prisma.store.savedQuery).toEqual([]);
  });

  it('a project sharing:manage holder may edit someone else’s query', async () => {
    const { service } = harness({ usr_ben: { ...MARCH, manage: true } }, null, [savedRow()]);
    await expect(service.remove(BEN, 'sq_1')).resolves.toBeUndefined();
  });

  it('anyone else who can see it gets 403', async () => {
    const { service } = harness({}, null, [savedRow()]);
    await expect(service.update(BEN, 'sq_1', { name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.remove(BEN, 'sq_1')).rejects.toBeInstanceOf(ForbiddenException);
    expect((await service.get(BEN, 'sq_1')).canEdit).toBe(false);
  });

  it('a caller who cannot see it gets 404, manager or not, and so does a missing id', async () => {
    const { service } = harness({ usr_ben: { ...APRIL, manage: true } }, null, [savedRow()]);
    await expect(service.remove(BEN, 'sq_1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update(BEN, 'sq_nope', {})).rejects.toBeInstanceOf(NotFoundException);
    const locked = harness({ usr_ben: { ...MARCH, open: false } }, null, [savedRow()]);
    await expect(locked.service.get(BEN, 'sq_1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an update re-validates and rewrites the join rows (restoring a reset flag)', async () => {
    const validate = vi.fn().mockResolvedValue(result({ touchedEntityIds: ['ent_emp'], touchedFieldIds: [] }));
    const again = harness({}, { validate }, [savedRow({ identifiersResolved: false })]);
    await again.service.update(ANA, 'sq_1', { queryText: 'SELECT name FROM employees' });
    expect(again.prisma.store.savedQuery?.[0]).toMatchObject({ identifiersResolved: true, touchedEntityIds: ['ent_emp'] });
    expect(again.prisma.store.savedQueryEntity?.map((r) => r.entityId)).toEqual(['ent_emp']);
  });
});

describe('SavedQueriesService.validate', () => {
  it('400s engine.feature-unsupported when the engine has no validator', async () => {
    const { service } = harness({}, null);
    await expect(service.validate(ANA, PROJECT, mapOf(ANA), 'SELECT 1')).rejects.toMatchObject({
      status: 400,
      response: { code: 'engine.feature-unsupported' },
    });
  });

  it('returns the validator result', async () => {
    const { service } = harness();
    expect((await service.validate(ANA, PROJECT, mapOf(ANA), 'SELECT 1')).statementKinds).toEqual(['SELECT']);
  });
});
