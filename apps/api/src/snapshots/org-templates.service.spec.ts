import type { EngineRegistry } from '@schemaloom/engine-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectPermissionMap, ProjectSkeleton } from '../access';
import type { DocsService } from '../docs';
import type { OrgTemplate } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChangeRequestsService } from './change-requests.service';
import type * as liveIr from './live-ir';
import { blobToLive, loadLiveProject, type LiveIr } from './live-ir';
import { ORG_TEMPLATE_LIMIT, OrgTemplatesService } from './org-templates.service';
import type { SnapshotContext } from './snapshots.service';

/**
 * Roadmap 12c — the rules around the fork. The real save → use round trip (fresh ids,
 * docs, areas, no comments or grants) runs against the api in e2e workflow 14.
 */

vi.mock('./live-ir', async (actual) => ({
  ...(await actual<typeof liveIr>()),
  loadLiveProject: vi.fn(),
}));

const USER = { kind: 'user', userId: 'usr_ana', orgId: 'org_1' } as const;
const ENGINE = { id: 'postgresql', version: '2.3.0' };

const skel = (entities: string[], restricted: string[] = []) =>
  ({
    entities: entities.map((id) => ({ id, areaId: null })),
    entitiesWithRestrictedFields: new Set(restricted),
  }) as unknown as ProjectSkeleton;

const ctx = (map: Partial<ProjectPermissionMap>, s: ProjectSkeleton): SnapshotContext => ({
  projectId: 'prj_1',
  subject: USER,
  actorUserId: USER.userId,
  map: {
    projectAtoms: new Set(['sharing:manage', 'schema:view', 'field:viewRestricted']),
    areaAtoms: new Map(),
    entityOverrides: new Map(),
    ...map,
  } as unknown as ProjectPermissionMap,
  skel: s,
});

const MODEL = {
  irVersion: 1,
  projectId: 'prj_src',
  engineId: 'postgresql',
  engineVersion: '16',
  redacted: false,
  objects: {
    area: {
      are_1: {
        id: 'are_1',
        name: 'Sales',
        color: 'blue',
        ordinal: 0,
        doc: null,
        version: 1,
        engineProps: {},
      },
    },
    namespace: {
      nsp_1: { id: 'nsp_1', name: 'public', isDefault: true, version: 1, engineProps: {} },
    },
    customType: {},
    entity: {
      ent_1: {
        id: 'ent_1',
        name: 'orders',
        namespaceId: 'nsp_1',
        kind: 'table',
        areaId: 'are_1',
        position: { x: 40, y: 80 },
        width: 220,
        color: null,
        doc: null,
        version: 1,
        engineProps: {},
      },
    },
    field: {},
    constraint: {},
    index: {},
    link: {},
  },
};

beforeEach(() => {
  vi.mocked(loadLiveProject).mockResolvedValue({ live: blobToLive(MODEL) } as never);
});

function template(over: Partial<OrgTemplate> = {}): OrgTemplate {
  return {
    id: 'tpl_1',
    organizationId: 'org_1',
    name: 'Core',
    summary: '',
    engineId: 'postgresql',
    engineMajor: 2,
    engineVersion: '16',
    model: MODEL,
    docs: [
      { targetType: 'area', targetId: 'are_1', content: { type: 'doc' }, structured: null },
      { targetType: 'entity', targetId: 'ent_gone', content: { type: 'doc' }, structured: null },
    ],
    tableCount: 0,
    sourceProjectId: 'prj_src',
    createdById: 'usr_ana',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function harness(opts: { count?: number; role?: string; row?: OrgTemplate | null } = {}) {
  const prisma = {
    project: {
      findFirst: vi.fn(() =>
        Promise.resolve({
          organizationId: 'org_1',
          engineId: 'postgresql',
          engineVersion: '16',
          enginePluginVersion: '2.1.0',
          draftOfId: null,
        }),
      ),
      delete: vi.fn(() => Promise.resolve({})),
    },
    orgTemplate: {
      count: vi.fn(() => Promise.resolve(opts.count ?? 0)),
      create: vi.fn(() => Promise.resolve({ ...template(), createdBy: null })),
      findFirst: vi.fn(() => Promise.resolve(opts.row === undefined ? template() : opts.row)),
      findMany: vi.fn(() =>
        Promise.resolve([{ ...template({ engineMajor: 1 }), createdBy: null }]),
      ),
    },
    orgMember: {
      findFirst: vi.fn(() =>
        Promise.resolve(
          opts.role === undefined ? null : { organizationId: 'org_1', role: opts.role },
        ),
      ),
    },
    namespace: { findFirstOrThrow: vi.fn(() => Promise.resolve({ id: 'nsp_new' })) },
    doc: { findMany: vi.fn(() => Promise.resolve([])) },
  };
  const requests = { writeDraft: vi.fn(() => Promise.resolve()) };
  const docs = { importDocs: vi.fn(() => Promise.resolve(0)) };
  const registry = { tryGet: (id: string) => (id === ENGINE.id ? ENGINE : undefined) };
  const service = new OrgTemplatesService(
    prisma as unknown as PrismaService,
    requests as unknown as ChangeRequestsService,
    docs as unknown as DocsService,
    registry as unknown as EngineRegistry,
  );
  return { service, prisma, requests, docs };
}

const INPUT = { name: 'Core', includeDocs: true, includeLayout: true };

describe('OrgTemplatesService (roadmap 12c)', () => {
  it('refuses a saver who cannot see the whole project, and stores nothing', async () => {
    const { service, prisma } = harness();
    // Two tables, one hidden from this manager.
    const partial = ctx(
      { entityOverrides: new Map([['ent_b', new Set()]]) },
      skel(['ent_a', 'ent_b']),
    );
    await expect(service.save(partial, INPUT)).rejects.toMatchObject({
      status: 403,
      response: { code: 'org_template_full_view_required' },
    });
    // A restricted column the saver may not read is a partial view too.
    const masked = ctx(
      { projectAtoms: new Set(['sharing:manage', 'schema:view']) },
      skel(['ent_a'], ['ent_a']),
    );
    await expect(service.save(masked, INPUT)).rejects.toMatchObject({ status: 403 });
    expect(prisma.orgTemplate.create).not.toHaveBeenCalled();
    expect(prisma.orgTemplate.count).not.toHaveBeenCalled();
  });

  it(`refuses the ${String(ORG_TEMPLATE_LIMIT + 1)}th template in an org`, async () => {
    const { service, prisma } = harness({ count: ORG_TEMPLATE_LIMIT });
    await expect(service.save(ctx({}, skel(['ent_1'])), INPUT)).rejects.toMatchObject({
      status: 409,
      response: { code: 'org_template_limit' },
    });
    expect(prisma.orgTemplate.create).not.toHaveBeenCalled();
  });

  it('stores the model without layout or docs when they are left out', async () => {
    const { service, prisma } = harness({ role: 'member' });
    await service.save(ctx({}, skel(['ent_1'])), {
      name: 'Core',
      includeDocs: false,
      includeLayout: false,
    });
    expect(prisma.doc.findMany).not.toHaveBeenCalled();
    const [{ data }] = prisma.orgTemplate.create.mock.calls[0] as unknown as [
      { data: { model: typeof MODEL; docs: unknown; engineMajor: number; tableCount: number } },
    ];
    expect(data.model.objects.entity.ent_1).toMatchObject({ position: { x: 0, y: 0 } });
    expect(data.model.objects.entity.ent_1).not.toHaveProperty('width');
    expect(data).toMatchObject({ docs: [], engineMajor: 2, tableCount: 1 });
  });

  it('lists nothing to a guest or a stranger, and flags an old engine major', async () => {
    expect(await harness({ role: 'guest' }).service.list('usr_ana', 'acme')).toEqual([]);
    expect(await harness().service.list('usr_ana', 'acme')).toEqual([]);
    const [listed] = await harness({ role: 'member' }).service.list('usr_ana', 'acme');
    expect(listed).toMatchObject({ id: 'tpl_1', usable: false, canManage: true });
    expect(listed).not.toHaveProperty('model');
  });

  it('refuses to use a template from an older engine major, before any project exists', async () => {
    const old = harness({ row: template({ engineMajor: 1 }) });
    await expect(old.service.forCreate('org_1', 'tpl_1')).rejects.toMatchObject({
      status: 422,
      response: { code: 'org_template_engine_outdated' },
    });
    const missing = harness({ row: null });
    await expect(missing.service.forCreate('org_1', 'tpl_x')).rejects.toMatchObject({
      status: 404,
    });
    await expect(harness().service.forCreate('org_1', 'tpl_1')).resolves.toMatchObject({
      id: 'tpl_1',
    });
  });

  it('only the saver, owners and admins rename or delete', async () => {
    const other = harness({ role: 'member', row: template({ createdById: 'usr_bob' }) });
    await expect(other.service.remove('usr_ana', 'acme', 'tpl_1')).rejects.toMatchObject({
      status: 403,
    });
    const guest = harness({ role: 'guest' });
    await expect(guest.service.remove('usr_ana', 'acme', 'tpl_1')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('fills with fresh ids on the new default namespace, then copies only its docs', async () => {
    const { service, requests, docs } = harness();
    await service.fill(USER, 'prj_new', template());

    const [user, projectId, target, label, origin] = requests.writeDraft.mock
      .calls[0] as unknown as [unknown, string, (live: LiveIr) => LiveIr, string, string];
    expect([user, projectId, label, origin]).toEqual([USER, 'prj_new', 'Template: Core', 'import']);
    const out = target(blobToLive({ ...MODEL, projectId: 'prj_new', engineVersion: '17' }));
    expect(out.projectId).toBe('prj_new');
    expect(out.engineVersion).toBe('17');
    expect(Object.keys(out.objects.namespace)).toEqual(['nsp_new']);
    const [areaId] = Object.keys(out.objects.area);
    expect(areaId).not.toBe('are_1');

    // The doc of a table that is not in the model is dropped, never written blind.
    expect(docs.importDocs).toHaveBeenCalledWith(USER, 'prj_new', [
      { targetType: 'area', targetId: areaId, content: { type: 'doc' }, structured: null },
    ]);
  });

  it('deletes the half-made project when filling fails', async () => {
    const { service, requests, prisma } = harness();
    requests.writeDraft.mockRejectedValueOnce(new Error('boom'));
    await expect(service.fill(USER, 'prj_new', template())).rejects.toThrow('boom');
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: 'prj_new' } });
  });
});
