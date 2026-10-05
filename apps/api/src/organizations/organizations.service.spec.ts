import type { PermissionAtom } from '@schemaloom/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSkeleton,
  canOpenProject,
  type PermissionResolver,
  type ProjectPermissionMap,
} from '../access';
import type { PrismaService } from '../prisma/prisma.service';
import { OrganizationsService, slugify } from './organizations.service';

/**
 * No Docker, no Redis. Everything these two routes must get right is a rule about WHICH
 * rows are returned and HOW MANY resolver calls it took, and fakes that record both test
 * exactly that.
 *
 * `canOpenProject` is the REAL implementation, not a stub: the point of the project list
 * is that the server applies the resolver's own rule, so a test that stubbed the rule
 * would pass against a service that invented its own.
 */
const ORG = 'org_acme';
const USER = 'usr_ana';

const mapOf = (
  projectId: string,
  over: Partial<ProjectPermissionMap> = {},
): ProjectPermissionMap => ({
  projectId,
  subjectKey: `u:${USER}`,
  orgRole: 'member',
  projectAtoms: new Set<PermissionAtom>(),
  areaAtoms: new Map<string, ReadonlySet<PermissionAtom>>(),
  entityOverrides: new Map<string, ReadonlySet<PermissionAtom>>(),
  restrictedFieldMode: 'mask',
  validUntil: Date.now() + 60_000,
  ...over,
});

/** Project-wide atoms, as the resolver writes them: on the project and on every area. */
const projectWide = (atoms: PermissionAtom[]): Partial<ProjectPermissionMap> => {
  const set = new Set<PermissionAtom>(atoms);
  return { projectAtoms: set, areaAtoms: new Map([['area_billing', set]]) };
};

interface Harness {
  readonly service: OrganizationsService;
  readonly orgMemberFindMany: ReturnType<typeof vi.fn>;
  readonly orgMemberFindFirst: ReturnType<typeof vi.fn>;
  readonly projectFindMany: ReturnType<typeof vi.fn>;
  readonly resolveProjects: ReturnType<typeof vi.fn>;
}

function harness(over: {
  members?: unknown[];
  membership?: unknown;
  projects?: unknown[];
  maps?: Map<string, ProjectPermissionMap>;
  openRequests?: { projectId: string; _count: { _all: number } }[];
}): Harness {
  const orgMemberFindMany = vi.fn().mockResolvedValue(over.members ?? []);
  const orgMemberFindFirst = vi.fn().mockResolvedValue(over.membership ?? null);
  const projectFindMany = vi.fn().mockResolvedValue(over.projects ?? []);
  const resolveProjects = vi.fn().mockResolvedValue(over.maps ?? new Map());

  const prisma = {
    orgMember: { findMany: orgMemberFindMany, findFirst: orgMemberFindFirst },
    project: { findMany: projectFindMany },
    changeRequest: { groupBy: vi.fn().mockResolvedValue(over.openRequests ?? []) },
  } as unknown as PrismaService;

  const resolver = {
    resolveProjects,
    canOpenProject: (map: ProjectPermissionMap) => canOpenProject(map),
    // Every project has two tables, one in the Billing area.
    skeleton: () =>
      Promise.resolve(
        buildSkeleton(
          1,
          ['area_billing'],
          [
            { id: 'ent_a', areaId: null },
            { id: 'ent_b', areaId: 'area_billing' },
          ],
          [],
        ),
      ),
  } as unknown as PermissionResolver;

  return {
    service: new OrganizationsService(prisma, resolver),
    orgMemberFindMany,
    orgMemberFindFirst,
    projectFindMany,
    resolveProjects,
  };
}

describe('OrganizationsService.listForUser', () => {
  it('returns only the orgs the user is an OrgMember of, with their org role', async () => {
    const h = harness({
      members: [
        { role: 'member', organization: { id: ORG, slug: 'acme', name: 'Acme Commerce' } },
        { role: 'owner', organization: { id: 'org_side', slug: 'side', name: 'Side Co' } },
      ],
    });

    await expect(h.service.listForUser(USER)).resolves.toEqual([
      { id: ORG, slug: 'acme', name: 'Acme Commerce', orgRole: 'member' },
      { id: 'org_side', slug: 'side', name: 'Side Co', orgRole: 'owner' },
    ]);

    // Membership is the WHERE clause, not a post-filter: an org the user does not belong
    // to is never read, so it cannot leak through a mapping bug.
    const where: unknown = h.orgMemberFindMany.mock.calls[0]?.[0];
    expect(where).toMatchObject({
      where: { userId: USER, organization: { deletedAt: null } },
    });
  });

  it('answers a user who belongs to nowhere with [], not a 404', async () => {
    const h = harness({ members: [] });
    await expect(h.service.listForUser('usr_fresh')).resolves.toEqual([]);
  });
});

describe('OrganizationsService.listProjects', () => {
  const row = (id: string, name: string, at: number) => ({
    id,
    name,
    engineId: 'postgresql',
    engineVersion: '16',
    updatedAt: new Date(at),
    requireChangeRequests: false,
    connection: { lastCheckStatus: 'drift' },
  });
  const rows = [
    row('prj_open', 'Storefront', 2),
    row('prj_closed', 'Payroll', 1),
    row('prj_area', 'Billing', 0),
  ];

  const maps = new Map<string, ProjectPermissionMap>([
    [
      'prj_open',
      // `viewer` is {schema:view, export:run} — the whole closed set, not just the atom
      // that makes the project openable. `effectiveRole` never rounds a partial set up.
      mapOf('prj_open', projectWide(['schema:view', 'export:run'])),
    ],
    // No atoms anywhere: `canOpenProject` is false, so this row must not appear.
    ['prj_closed', mapOf('prj_closed')],
    // The §7.9 freelancer: area-scoped only. Opens the project, has no project-wide role.
    [
      'prj_area',
      mapOf('prj_area', {
        areaAtoms: new Map<string, ReadonlySet<PermissionAtom>>([
          ['area_billing', new Set<PermissionAtom>(['schema:view'])],
        ]),
      }),
    ],
  ]);

  it('excludes a project the caller cannot open', async () => {
    const h = harness({ membership: { organizationId: ORG }, projects: rows, maps });

    const listed = await h.service.listProjects(USER, 'acme');

    expect(listed.map((p) => p.id)).toEqual(['prj_open', 'prj_area']);
    expect(listed[0]).toEqual({
      id: 'prj_open',
      name: 'Storefront',
      engineId: 'postgresql',
      engineVersion: '16',
      updatedAt: new Date(2).toISOString(),
      role: 'viewer',
      requireChangeRequests: false,
      tableCount: 2,
      openChangeRequests: 0,
      // A viewer is not a project-wide editor, so the drift check is not theirs to see.
      driftStatus: null,
    });
    // Area-scoped access carries no project-level role label, and that is not "no access".
    expect(listed[1]?.role).toBeNull();
  });

  it('gives counts only to a complete viewer, and drift only to an editor (redesign)', async () => {
    const editor = new Map<string, ProjectPermissionMap>([
      ['prj_open', mapOf('prj_open', projectWide(['schema:view', 'schema:edit', 'export:run']))],
      [
        'prj_area',
        mapOf('prj_area', {
          areaAtoms: new Map<string, ReadonlySet<PermissionAtom>>([
            ['area_billing', new Set<PermissionAtom>(['schema:view', 'schema:edit'])],
          ]),
        }),
      ],
    ]);
    const h = harness({
      membership: { organizationId: ORG },
      projects: rows,
      maps: editor,
      openRequests: [{ projectId: 'prj_open', _count: { _all: 3 } }],
    });
    const [open, area] = await h.service.listProjects(USER, 'acme');
    expect(open).toMatchObject({ tableCount: 2, openChangeRequests: 3, driftStatus: 'drift' });
    // Sees one of two tables: no count that would reveal the hidden one.
    expect(area).toMatchObject({ tableCount: null, openChangeRequests: null, driftStatus: null });
  });

  it('shows a guest (an accepted email invite) only the projects it was granted', async () => {
    const guest = new Map<string, ProjectPermissionMap>([
      [
        'prj_open',
        mapOf('prj_open', {
          orgRole: 'guest',
          projectAtoms: new Set<PermissionAtom>(['schema:view', 'export:run']),
        }),
      ],
      ['prj_closed', mapOf('prj_closed', { orgRole: 'guest' })],
      ['prj_area', mapOf('prj_area', { orgRole: 'guest' })],
    ]);
    const h = harness({ membership: { organizationId: ORG }, projects: rows, maps: guest });
    expect((await h.service.listProjects(USER, 'acme')).map((p) => p.id)).toEqual(['prj_open']);
  });

  it('resolves every candidate in ONE batch call, never one per project', async () => {
    const h = harness({ membership: { organizationId: ORG }, projects: rows, maps });

    await h.service.listProjects(USER, 'acme');

    // Doc 05 §10.4. An org with 200 projects must cost one resolve, not 200.
    expect(h.resolveProjects).toHaveBeenCalledTimes(1);
    expect(h.resolveProjects.mock.calls[0]?.[1]).toEqual(['prj_open', 'prj_closed', 'prj_area']);
    // Built from the membership row this method verified, not from the session's active
    // org — which is what lets a user in three orgs list all three.
    expect(h.resolveProjects.mock.calls[0]?.[0]).toEqual({
      kind: 'user',
      userId: USER,
      orgId: ORG,
    });
  });

  it('answers a non-member with [] and never reads the org’s projects', async () => {
    const h = harness({ membership: null, projects: rows, maps });

    await expect(h.service.listProjects('usr_stranger', 'acme')).resolves.toEqual([]);

    // Not a 403 and not a 404-for-real-orgs-only: either would make this route an
    // existence oracle for every organisation on the deployment.
    expect(h.projectFindMany).not.toHaveBeenCalled();
    expect(h.resolveProjects).not.toHaveBeenCalled();
  });

  it('skips the resolver entirely for an org with no projects', async () => {
    const h = harness({ membership: { organizationId: ORG }, projects: [] });
    await expect(h.service.listProjects(USER, 'acme')).resolves.toEqual([]);
    expect(h.resolveProjects).not.toHaveBeenCalled();
  });
});

describe('OrganizationsService.create', () => {
  it('slugifies the name, falling back when nothing survives', () => {
    expect(slugify('  Acme Corp!  ')).toBe('acme-corp');
    expect(slugify('Café Ünïcode')).toBe('cafe-unicode');
    expect(slugify('شرکت')).toBe('');
  });

  it('makes the caller owner, and retries with a suffix on a slug clash', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }))
      .mockImplementation(({ data }: { data: { slug: string; name: string } }) =>
        Promise.resolve({ id: 'org_new', slug: data.slug, name: data.name }),
      );
    const service = new OrganizationsService(
      { organization: { create } } as unknown as PrismaService,
      {} as PermissionResolver,
    );

    const org = await service.create(USER, 'Acme');

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      data: { slug: 'acme', members: { create: { userId: USER, role: 'owner' } } },
    });
    expect(org.slug).toMatch(/^acme-[0-9a-f]{6}$/);
    expect(org.orgRole).toBe('owner');
  });
});

describe('OrganizationsService workspaces', () => {
  const service = (role: string | null) => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'ws_0', name: 'General', slug: 'general' }]);
    const create = vi.fn(({ data }: { data: { name: string; position: number } }) =>
      Promise.resolve({ id: 'ws_1', name: data.name, slug: 'x', position: data.position }),
    );
    const prisma = {
      orgMember: {
        findFirst: vi.fn().mockResolvedValue(role === null ? null : { organizationId: ORG, role }),
      },
      groupMember: { findMany: vi.fn().mockResolvedValue([{ groupId: 'grp_1' }]) },
      workspace: {
        findMany,
        findFirst: vi.fn().mockResolvedValue({ position: 0 }),
        create,
      },
    } as unknown as PrismaService;
    return { svc: new OrganizationsService(prisma, {} as PermissionResolver), create, findMany };
  };

  it('lists for members, and answers [] to non-members', async () => {
    expect(await service('member').svc.listWorkspaces(USER, 'acme')).toHaveLength(1);
    expect(await service(null).svc.listWorkspaces(USER, 'acme')).toEqual([]);
  });

  it('shows a guest only the workspaces they or their groups hold a grant on (roadmap 19)', async () => {
    const guest = service('guest');
    await guest.svc.listWorkspaces(USER, 'acme');
    const where = (guest.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    expect(JSON.stringify(where.grants)).toContain(`"principalId":"${USER}"`);
    expect(JSON.stringify(where.grants)).toContain('"in":["grp_1"]');
    const member = service('member');
    await member.svc.listWorkspaces(USER, 'acme');
    expect((member.findMany.mock.calls[0]?.[0] as { where: object }).where).not.toHaveProperty(
      'grants',
    );
  });

  it('lets only owners and admins create, appended after the last workspace', async () => {
    const admin = service('admin');
    await admin.svc.createWorkspace(USER, 'acme', 'Data');
    expect(admin.create.mock.calls[0]?.[0].data.position).toBe(1);
    await expect(service('member').svc.createWorkspace(USER, 'acme', 'Data')).rejects.toThrow();
    await expect(service(null).svc.createWorkspace(USER, 'acme', 'Data')).rejects.toThrow();
  });
});

describe('OrganizationsService settings (docs/phase17/ORG-DEFAULT.md §2)', () => {
  const GRAPHITE = { theme: 'blueprint', variant: 'graphite', mode: 'system' };

  function settingsHarness(role: string | null, stored: unknown) {
    const update = vi.fn(() => Promise.resolve({}));
    const audit = vi.fn(() => Promise.resolve({}));
    const tx = {
      organization: {
        findUniqueOrThrow: vi.fn(() => Promise.resolve({ settings: stored })),
        update,
      },
      auditLog: { create: audit },
    };
    const prisma = {
      ...tx,
      orgMember: {
        findFirst: vi.fn(() =>
          Promise.resolve(role === null ? null : { organizationId: ORG, role }),
        ),
      },
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService;
    return { service: new OrganizationsService(prisma, {} as PermissionResolver), update, audit };
  }

  it.each(['owner', 'admin'])(
    '%s sets the default; other keys survive; it is audited',
    async (role) => {
      const h = settingsHarness(role, { allowGuestInvites: false, somethingElse: 1 });
      const out = await h.service.updateSettings(USER, 'acme', {
        defaultAppearance: GRAPHITE,
      } as never);
      expect(out).toEqual({ allowGuestInvites: false, defaultAppearance: GRAPHITE });
      expect(h.update).toHaveBeenCalledWith({
        where: { id: ORG },
        data: {
          settings: { allowGuestInvites: false, somethingElse: 1, defaultAppearance: GRAPHITE },
        },
      });
      expect(h.audit).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'org.settings_changed',
          organizationId: ORG,
          metadata: { defaultAppearance: GRAPHITE },
        }),
      });
    },
  );

  it('refuses a variant of another theme and writes nothing', async () => {
    const h = settingsHarness('owner', {});
    await expect(
      h.service.updateSettings(USER, 'acme', {
        defaultAppearance: { theme: 'blueprint', variant: 'jade', mode: 'dark' },
      } as never),
    ).rejects.toThrow();
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each(['member', 'guest', null])('a %s gets 404 on read and write', async (role) => {
    const h = settingsHarness(role, {});
    await expect(h.service.getSettings(USER, 'acme')).rejects.toMatchObject({ status: 404 });
    await expect(h.service.updateSettings(USER, 'acme', {})).rejects.toMatchObject({ status: 404 });
    expect(h.update).not.toHaveBeenCalled();
  });
});
