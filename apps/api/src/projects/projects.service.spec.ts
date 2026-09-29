import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BUILTIN_ROLE_IDS, PERMISSION_ATOMS, type PermissionAtom } from '@schemaloom/contracts';
import type { EngineDefinition, EngineRegistry } from '@schemaloom/engine-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionResolver, ProjectPermissionMap } from '../access';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AccessWriter } from '../sharing/access-write';
import { ProjectsService } from './projects.service';

const ORG = 'org_acme';
const WORKSPACE = 'wsp_commerce';
const ACTOR = 'usr_ana';
const PROJECT = 'prj_new';

const ENGINE = {
  id: 'postgresql',
  version: '2.1.0',
  capabilities: { defaultNamespaceName: 'public' },
} as unknown as EngineDefinition;

const ROW = {
  id: PROJECT,
  name: 'Storefront',
  engineId: 'postgresql',
  engineVersion: '16',
  enginePluginVersion: '2.1.0',
  restrictedFieldMode: 'mask' as const,
  updatedAt: new Date(0),
};

const INPUT = {
  organizationId: ORG,
  workspaceId: WORKSPACE,
  name: 'Storefront',
  engineId: 'postgresql',
  engineVersion: '16',
};

const managerMap = (): ProjectPermissionMap => ({
  projectId: PROJECT,
  subjectKey: `u:${ACTOR}`,
  orgRole: 'member',
  projectAtoms: new Set<PermissionAtom>(PERMISSION_ATOMS),
  areaAtoms: new Map<string, ReadonlySet<PermissionAtom>>(),
  entityOverrides: new Map<string, ReadonlySet<PermissionAtom>>(),
  restrictedFieldMode: 'mask',
  validUntil: Date.now() + 60_000,
});

interface Tx {
  readonly workspace: { findFirst: ReturnType<typeof vi.fn> };
  readonly project: { create: ReturnType<typeof vi.fn> };
  readonly namespace: { create: ReturnType<typeof vi.fn> };
  readonly accessGrant: { create: ReturnType<typeof vi.fn> };
}

interface Harness {
  readonly service: ProjectsService;
  readonly tx: Tx;
  readonly transaction: ReturnType<typeof vi.fn>;
  readonly projectFindFirst: ReturnType<typeof vi.fn>;
  readonly tryGet: ReturnType<typeof vi.fn>;
}

function harness(
  over: { engine?: EngineDefinition | undefined; workspace?: unknown; fail?: Error } = {},
): Harness {
  const tx: Tx = {
    workspace: {
      findFirst: vi
        .fn()
        .mockResolvedValue('workspace' in over ? over.workspace : { id: WORKSPACE }),
    },
    project: { create: vi.fn().mockResolvedValue(ROW) },
    namespace: { create: vi.fn().mockResolvedValue({}) },
    accessGrant: { create: vi.fn().mockResolvedValue({}) },
  };

  const transaction = vi.fn(async (run: (client: Tx) => Promise<unknown>): Promise<unknown> => {
    if (over.fail) throw over.fail;
    return run(tx);
  });

  const projectFindFirst = vi.fn().mockResolvedValue(ROW);

  // The root client deliberately exposes ONLY `$transaction` and `project.findFirst`. A
  // service that wrote the namespace or the grant outside the transaction would reach for
  // `this.prisma.namespace` and blow up here — the structure IS the assertion.
  const prisma = {
    $transaction: transaction,
    project: { findFirst: projectFindFirst },
  } as unknown as PrismaService;

  const tryGet = vi.fn().mockReturnValue('engine' in over ? over.engine : ENGINE);
  const registry = { tryGet } as unknown as EngineRegistry;

  const resolver = {
    resolveProject: vi.fn().mockResolvedValue(managerMap()),
  } as unknown as PermissionResolver;

  return {
    service: new ProjectsService(prisma, resolver, registry, {} as AccessWriter),
    tx,
    transaction,
    projectFindFirst,
    tryGet,
  };
}

describe('ProjectsService.create', () => {
  it('writes the project, its default namespace and the creator’s manager grant in ONE transaction', async () => {
    const h = harness();

    await h.service.create(INPUT, ACTOR);

    expect(h.transaction).toHaveBeenCalledTimes(1);

    // Doc 02: every project has exactly one default namespace, created WITH the project.
    // The name comes from the engine's capabilities, never from the request.
    expect(h.tx.namespace.create).toHaveBeenCalledWith({
      data: { projectId: PROJECT, name: 'public', isDefault: true },
    });

    // Doc 05 §3.2: the creator "becomes manager on it via an auto-written grant". An org
    // `member` holds no atoms from their org role (R13), so without this row the creator
    // cannot open what they just created.
    expect(h.tx.accessGrant.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG,
        projectId: PROJECT,
        resourceType: 'project',
        resourceId: PROJECT,
        principalType: 'user',
        principalId: ACTOR,
        roleId: BUILTIN_ROLE_IDS.manager,
        createdById: ACTOR,
      },
    });
  });

  it('derives the slug and takes enginePluginVersion from the engine, not the request', async () => {
    const h = harness();

    await h.service.create({ ...INPUT, name: 'Café Storefront!' }, ACTOR);

    const data: unknown = h.tx.project.create.mock.calls[0]?.[0];
    expect(data).toMatchObject({
      data: { slug: 'cafe-storefront', enginePluginVersion: '2.1.0', createdById: ACTOR },
    });
  });

  it('matches the workspace against the organisation the marker checked', async () => {
    const h = harness({ workspace: null });

    // 404, not 403: a workspace in an org the caller cannot see must not be
    // distinguishable from one that does not exist. Without this pairing the org role is
    // checked against one id and the row written into a workspace belonging to another.
    await expect(h.service.create(INPUT, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.project.create).not.toHaveBeenCalled();
    expect(h.tx.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: WORKSPACE, organizationId: ORG },
      select: { id: true },
    });
  });

  it('refuses an engine that is announced but not implemented, with 422 and no row', async () => {
    // `tryGet` misses a "coming soon" engine for exactly the same reason it misses a
    // typo: the registry derives that status by set difference, so an announced engine
    // with no registration is simply absent. Creating the row anyway would produce a
    // project whose EngineGate verdict is `engine-missing` forever.
    const h = harness({ engine: undefined });

    await expect(h.service.create({ ...INPUT, engineId: 'mysql' }, ACTOR)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('turns a duplicate slug into 409, not a 500', async () => {
    const h = harness({
      fail: new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: '6.16.0',
      }),
    });

    await expect(h.service.create(INPUT, ACTOR)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ProjectsService.detail', () => {
  it('projects the guard’s map onto the row without resolving a second time', async () => {
    const h = harness();

    const detail = await h.service.detail(PROJECT, managerMap());

    expect(detail).toMatchObject({
      id: PROJECT,
      name: 'Storefront',
      engineId: 'postgresql',
      engineVersion: '16',
      enginePluginVersion: '2.1.0',
      restrictedFieldMode: 'mask',
      role: 'manager',
      orgRole: 'member',
    });
    expect(detail.atoms).toEqual([...PERMISSION_ATOMS].sort((a, b) => (a < b ? -1 : 1)));
    expect(h.projectFindFirst).toHaveBeenCalledTimes(1);
  });

  it('404s a soft-deleted project rather than returning a shell', async () => {
    const h = harness();
    h.projectFindFirst.mockResolvedValue(null);
    await expect(h.service.detail(PROJECT, managerMap())).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ProjectsService settings writes', () => {
  function settingsHarness(atoms: readonly PermissionAtom[] = PERMISSION_ATOMS) {
    const tx = {
      project: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          organizationId: ORG,
          restrictedFieldMode: 'mask',
          settings: { ai: { enabled: true, includeDocsInContext: false } },
        }),
        update: vi.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ restrictedFieldMode: 'mask', settings: {}, ...data }),
        ),
      },
    };
    const map = { ...managerMap(), projectAtoms: new Set<PermissionAtom>(atoms) };
    const audit = vi.fn().mockResolvedValue({});
    const write = vi.fn(
      (_s: unknown, _p: string, fn: (scope: unknown) => Promise<unknown>, _o?: { bump: boolean }) =>
        fn({ tx, map, skel: {} }),
    );
    const writer = { write, audit } as unknown as AccessWriter;
    const service = new ProjectsService({} as PrismaService, {} as PermissionResolver, {} as EngineRegistry, writer);
    return { service, tx, write, audit };
  }
  const subject = { kind: 'user' as const, userId: ACTOR, orgId: ORG };

  it('restricted-field mode goes through AccessWriter with the bump, and is audited', async () => {
    const h = settingsHarness();
    const view = await h.service.setRestrictedFieldMode(subject, PROJECT, 'hide');
    expect(view.restrictedFieldMode).toBe('hide');
    expect(h.write.mock.calls[0]?.[3]).toBeUndefined(); // default { bump: true }
    expect(h.audit.mock.calls[0]?.[4]).toMatchObject({
      action: 'project.restricted_field_mode_changed',
      metadata: { before: 'mask', after: 'hide' },
    });
  });

  it('the AI patch merges into the stored settings and does not bump', async () => {
    const h = settingsHarness();
    const view = await h.service.updateSettings(subject, PROJECT, { ai: { enabled: false } });
    expect(view.ai).toEqual({ enabled: false, includeDocsInContext: false });
    expect(h.write.mock.calls[0]?.[3]).toEqual({ bump: false });
  });

  it('re-checks sharing:manage on the map resolved inside the lock (R26)', async () => {
    const h = settingsHarness(['schema:view', 'schema:edit']);
    await expect(h.service.setRestrictedFieldMode(subject, PROJECT, 'hide')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.tx.project.update).not.toHaveBeenCalled();
  });
});
