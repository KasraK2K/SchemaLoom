import { describe, expect, it, vi } from 'vitest';
import {
  RawSchemaModel,
  type FieldVisibilityIndex,
  type VisibilityContext,
} from '@schemaloom/schema-model';
import type { PermissionResolver } from '../permission-resolver.service';
import type { ProjectPermissionMap, ProjectSkeleton, Subject } from '../types';
import { VisibilityFilter, type QueryRow } from './visibility-filter.service';

const USER: Subject = { kind: 'user', userId: 'us_1', orgId: 'or_1' };

function skeleton(over: Partial<ProjectSkeleton> = {}): ProjectSkeleton {
  const entities = over.entities ?? [
    { id: 'en_1', areaId: 'ar_1' },
    { id: 'en_2', areaId: null },
  ];
  return {
    generation: 1,
    areaIds: ['ar_1', 'ar_2'],
    entities,
    entityById: new Map(entities.map((e) => [e.id, e])),
    entitiesWithRestrictedFields: new Set(['en_1']),
    ...over,
  };
}

function map(over: Partial<ProjectPermissionMap> = {}): ProjectPermissionMap {
  return {
    projectId: 'pr_1',
    subjectKey: 'user:us_1',
    orgRole: 'member',
    projectAtoms: new Set(['schema:view']),
    areaAtoms: new Map(),
    entityOverrides: new Map(),
    restrictedFieldMode: 'mask',
    validUntil: Date.parse('2030-01-01T00:00:00Z'),
    ...over,
  };
}

/** Only the five methods VisibilityFilter calls. */
function resolverStub(over: Partial<Record<string, unknown>> = {}) {
  const stub = {
    resolveProject: vi.fn().mockResolvedValue(map()),
    skeleton: vi.fn().mockResolvedValue(skeleton()),
    canOpenProject: vi.fn().mockReturnValue(true),
    visibleEntityIds: vi.fn().mockReturnValue(new Set(['en_1'])),
    restrictedOkEntityIds: vi.fn().mockReturnValue(new Set<string>()),
    atomsAt: vi.fn().mockReturnValue(new Set<string>()),
    ...over,
  };
  return stub;
}

/** The service takes the nominal type; the test keeps the plain handle for assertions. */
function asResolver(stub: ReturnType<typeof resolverStub>): PermissionResolver {
  return stub as unknown as PermissionResolver;
}

describe('VisibilityFilter.contextFrom', () => {
  it('projects resolver output onto the shape redact() consumes', () => {
    const r = resolverStub();
    const ctx = new VisibilityFilter(asResolver(r)).contextFrom(USER, 'pr_1', map(), skeleton());

    expect(ctx.projectId).toBe('pr_1');
    expect(ctx.subjectKind).toBe('user');
    expect(ctx.subjectKey).toBe('user:us_1');
    expect(ctx.canOpenProject).toBe(true);
    expect([...ctx.visibleEntityIds]).toEqual(['en_1']);
    expect(ctx.restrictedFieldMode).toBe('mask');
  });

  it('R21p: totalEntityCount is the FULL count, not the visible count', () => {
    const r = resolverStub({ visibleEntityIds: vi.fn().mockReturnValue(new Set(['en_1'])) });
    const ctx = new VisibilityFilter(asResolver(r)).contextFrom(USER, 'pr_1', map(), skeleton());

    // redact() is pure and cannot count rows; if this leaked the visible count instead,
    // "N tables are hidden from you" would always read zero.
    expect(ctx.totalEntityCount).toBe(2);
    expect(ctx.visibleEntityIds.size).toBe(1);
  });

  it('areasWithAtoms uses atomsAt, not areaAtoms membership', () => {
    // An area inheriting its atoms from the project has NO entry in areaAtoms, but the
    // subject still holds atoms there. Reading areaAtoms.keys() would drop it and the
    // area would vanish from a canvas the subject can fully see.
    const atomsAt = vi
      .fn()
      .mockImplementation((_m: unknown, _s: unknown, ref: { id: string }) =>
        ref.id === 'ar_1' ? new Set(['schema:view']) : new Set<string>(),
      );
    const r = resolverStub({ atomsAt });
    const ctx = new VisibilityFilter(asResolver(r)).contextFrom(USER, 'pr_1', map(), skeleton());

    expect([...ctx.areasWithAtoms]).toEqual(['ar_1']);
    expect(map().areaAtoms.size).toBe(0);
  });

  it('a share-link subject is reported as such', () => {
    const link: Subject = { kind: 'share_link', shareLinkId: 'sl_1', projectId: 'pr_1' };
    const ctx = new VisibilityFilter(asResolver(resolverStub())).contextFrom(
      link,
      'pr_1',
      map({ orgRole: null, subjectKey: 'share_link:sl_1' }),
      skeleton(),
    );
    expect(ctx.subjectKind).toBe('share_link');
    expect(ctx.subjectKey).toBe('share_link:sl_1');
  });

  it('carries entitiesWithRestrictedFields through from the skeleton', () => {
    const ctx = new VisibilityFilter(asResolver(resolverStub())).contextFrom(
      USER,
      'pr_1',
      map(),
      skeleton(),
    );
    expect([...ctx.entitiesWithRestrictedFields]).toEqual(['en_1']);
  });
});

describe('VisibilityFilter.computeContext', () => {
  it('resolves the map and the skeleton concurrently, once each', async () => {
    const r = resolverStub();
    await new VisibilityFilter(asResolver(r)).computeContext(USER, 'pr_1');

    expect(r.resolveProject).toHaveBeenCalledTimes(1);
    expect(r.skeleton).toHaveBeenCalledTimes(1);
    expect(r.resolveProject).toHaveBeenCalledWith(USER, 'pr_1');
  });
});

describe('the single-path rule (doc 05 §8.6)', () => {
  it('redactModel only accepts a RawSchemaModel, and returns a branded RedactedModel', async () => {
    const r = resolverStub();
    const filter = new VisibilityFilter(asResolver(r));
    const raw = new RawSchemaModel({
      irVersion: 1,
      projectId: 'pr_1',
      engineId: 'postgresql',
      engineVersion: '16',
      redacted: false,
      objects: {
        namespace: {},
        area: {},
        entity: {},
        field: {},
        link: {},
        index: {},
        constraint: {},
        customType: {},
      },
    });

    const out = await filter.redactModel(raw, USER, 'pr_1');
    expect(out.redacted).toBe(true);
    // The redacted model serialises; the raw one refuses to.
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(() => JSON.stringify(raw)).toThrow('raw_ir_escaped');
  });
});

describe('VisibilityFilter.filterQueryRows (doc 05 L25)', () => {
  const filter = new VisibilityFilter(asResolver(resolverStub()));
  const ctx = (over: Partial<VisibilityContext> = {}): VisibilityContext => ({
    projectId: 'pr_1',
    subjectKind: 'user',
    subjectKey: 'user:us_1',
    canOpenProject: true,
    visibleEntityIds: new Set(['en_1', 'en_2']),
    restrictedOkEntityIds: new Set(['en_1', 'en_2']),
    areasWithAtoms: new Set(),
    restrictedFieldMode: 'mask',
    totalEntityCount: 2,
    entitiesWithRestrictedFields: new Set(['en_2']),
    ...over,
  });
  const fieldVis: FieldVisibilityIndex = new Map([
    ['fd_open', 'full'],
    ['fd_salary', 'masked'],
  ]);
  const row = (over: Partial<QueryRow> = {}): QueryRow => ({
    identifiersResolved: true,
    touchedEntityIds: ['en_1'],
    touchedFieldIds: ['fd_open'],
    ...over,
  });

  it('keeps a resolved row whose every touched id is fully visible', () => {
    expect(filter.filterQueryRows([row()], ctx(), fieldVis)).toHaveLength(1);
  });

  it('omits a resolved row touching a hidden entity', () => {
    const narrowed = ctx({ visibleEntityIds: new Set(['en_2']) });
    expect(filter.filterQueryRows([row()], narrowed, fieldVis)).toEqual([]);
  });

  it('omits a resolved row touching a masked field, and one touching a field absent from the index', () => {
    expect(
      filter.filterQueryRows([row({ touchedFieldIds: ['fd_salary'] })], ctx(), fieldVis),
    ).toEqual([]);
    expect(
      filter.filterQueryRows([row({ touchedFieldIds: ['fd_gone'] })], ctx(), fieldVis),
    ).toEqual([]);
  });

  it('keeps an unresolved row only for a complete view (R21′)', () => {
    const unresolved = row({
      identifiersResolved: false,
      touchedEntityIds: [],
      touchedFieldIds: [],
    });
    expect(filter.filterQueryRows([unresolved], ctx(), fieldVis)).toHaveLength(1);
    expect(
      filter.filterQueryRows([unresolved], ctx({ visibleEntityIds: new Set(['en_1']) }), fieldVis),
    ).toEqual([]);
    expect(
      filter.filterQueryRows(
        [unresolved],
        ctx({ restrictedOkEntityIds: new Set(['en_1']) }),
        fieldVis,
      ),
      'every entity visible but a restricted field still masked is not complete',
    ).toEqual([]);
  });
});
