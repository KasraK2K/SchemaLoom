import type { PermissionAtom } from '@schemaloom/contracts';
import { describe, expect, it, vi } from 'vitest';
import { canOpenProject, type PermissionResolver, type ProjectPermissionMap } from '../access';
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
}): Harness {
  const orgMemberFindMany = vi.fn().mockResolvedValue(over.members ?? []);
  const orgMemberFindFirst = vi.fn().mockResolvedValue(over.membership ?? null);
  const projectFindMany = vi.fn().mockResolvedValue(over.projects ?? []);
  const resolveProjects = vi.fn().mockResolvedValue(over.maps ?? new Map());

  const prisma = {
    orgMember: { findMany: orgMemberFindMany, findFirst: orgMemberFindFirst },
    project: { findMany: projectFindMany },
  } as unknown as PrismaService;

  const resolver = {
    resolveProjects,
    canOpenProject: (map: ProjectPermissionMap) => canOpenProject(map),
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
  const rows = [
    { id: 'prj_open', name: 'Storefront', engineId: 'postgresql', updatedAt: new Date(2) },
    { id: 'prj_closed', name: 'Payroll', engineId: 'postgresql', updatedAt: new Date(1) },
    { id: 'prj_area', name: 'Billing', engineId: 'postgresql', updatedAt: new Date(0) },
  ];

  const maps = new Map<string, ProjectPermissionMap>([
    [
      'prj_open',
      // `viewer` is {schema:view, export:run} — the whole closed set, not just the atom
      // that makes the project openable. `effectiveRole` never rounds a partial set up.
      mapOf('prj_open', { projectAtoms: new Set<PermissionAtom>(['schema:view', 'export:run']) }),
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
      updatedAt: new Date(2).toISOString(),
      role: 'viewer',
    });
    // Area-scoped access carries no project-level role label, and that is not "no access".
    expect(listed[1]?.role).toBeNull();
  });

  it('resolves every candidate in ONE batch call, never one per project', async () => {
    const h = harness({ membership: { organizationId: ORG }, projects: rows, maps });

    await h.service.listProjects(USER, 'acme');

    // Doc 05 §10.4. An org with 200 projects must cost one resolve, not 200.
    expect(h.resolveProjects).toHaveBeenCalledTimes(1);
    expect(h.resolveProjects.mock.calls[0]?.[1]).toEqual([
      'prj_open',
      'prj_closed',
      'prj_area',
    ]);
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
