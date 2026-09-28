import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BUILTIN_ROLE_IDS } from '@schemaloom/contracts';
import type { EngineDefinition, EngineRegistry } from '@schemaloom/engine-sdk';
import { PermissionResolver, type ProjectPermissionMap } from '../access';
import { ENGINE_REGISTRY } from '../engines';
import { Prisma } from '../generated/prisma/client';
import { PrincipalType, ResourceType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { toDetail, type ProjectDetail, type ProjectDetailRow } from './project-views';
import type { CreateProjectDto } from './projects.dto';
import { slugify } from './slugify';

/** PostgreSQL 23505, surfaced by Prisma as P2002 — including from a raw partial index. */
const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    @Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry,
  ) {}

  /**
   * The project shell. `PermissionGuard` has already resolved `map` for
   * `@RequireProjectAccess` and attached it, so this is ONE row read and no second
   * resolve (doc 05 §10.4).
   */
  async detail(projectId: string, map: ProjectPermissionMap): Promise<ProjectDetail> {
    const row = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        id: true,
        name: true,
        engineId: true,
        engineVersion: true,
        enginePluginVersion: true,
        restrictedFieldMode: true,
        updatedAt: true,
      },
    });
    // Unreachable behind the guard, which resolves no map for a project with no row.
    // Kept because a handler that trusts a guard opens a route the day the guard moves.
    if (!row) throw new NotFoundException({ code: 'not_found' });
    return toDetail(row, map);
  }

  async rename(projectId: string, name: string): Promise<void> {
    await this.prisma.project.update({ where: { id: projectId }, data: { name } });
  }

  /**
   * Doc 05 §9's row "project soft-deleted → `Project.permGeneration`": the bump is what
   * retires every cached permission map for it in the same commit.
   */
  async softDelete(projectId: string): Promise<void> {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: new Date(), permGeneration: { increment: 1 } },
    });
    // After the commit: drops the cached maps and tells open sockets (they get 4403).
    await this.resolver.invalidate({ project: projectId });
  }

  /**
   * Doc 05 §3.2 — `member` and above may create a project and become `manager` on it "via
   * an auto-written grant". The grant is not an afterthought: an org `member` holds NO
   * atoms from their org role (R13 gives all nine only to owner/admin), so without it the
   * creator cannot open what they just created. That is why the project row, its default
   * namespace and that grant are ONE transaction — there is no interleaving in which a
   * project exists without them.
   *
   * No cache invalidation follows. The permission-map key is built from the project's own
   * generation counters (§9.1), and `resolveProjects` never caches a map for a project
   * with no row, so a brand-new id cannot have a stale entry to evict.
   */
  async create(input: CreateProjectDto, actorUserId: string): Promise<ProjectDetail> {
    const engine = this.assertEngineAvailable(input.engineId);
    const slug = slugify(input.name);

    const project = await this.insert(input, engine, slug, actorUserId);
    const map = await this.resolver.resolveProject(
      { kind: 'user', userId: actorUserId, orgId: input.organizationId },
      project.id,
    );
    return toDetail(project, map);
  }

  /**
   * An unregistered engine id is a **422, not a 404 and not a row**. "Coming soon" is the
   * same answer by construction: the registry derives that status by set difference (doc
   * 03 §14), so an announced-but-undeployed engine has no registration and `tryGet` misses
   * it exactly like a typo does. Creating the row anyway would produce a project whose
   * `EngineGate` verdict is `read-only / engine-missing` forever — a project nobody can
   * open, created by a request that returned 201.
   */
  private assertEngineAvailable(engineId: string): EngineDefinition {
    const engine = this.registry.tryGet(engineId);
    if (engine === undefined) {
      throw new UnprocessableEntityException({ code: 'engine.unavailable', engineId });
    }
    return engine;
  }

  private async insert(
    input: CreateProjectDto,
    engine: EngineDefinition,
    slug: string,
    actorUserId: string,
  ): Promise<ProjectDetailRow> {
    try {
      return await this.prisma.$transaction((tx) =>
        this.createRows(tx, input, engine, slug, actorUserId),
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
        throw new ConflictException({ code: 'project_slug_taken', slug });
      }
      throw error;
    }
  }

  private async createRows(
    tx: Prisma.TransactionClient,
    input: CreateProjectDto,
    engine: EngineDefinition,
    slug: string,
    actorUserId: string,
  ): Promise<ProjectDetailRow> {
    // The workspace is read INSIDE the transaction and matched against the organisation
    // the marker checked. Without this pairing the org role is checked against an id the
    // client chose and the row is written into whatever workspace it named — someone
    // else's. `404`, not `403`: a workspace in an org the caller cannot see must not be
    // distinguishable from one that does not exist.
    const workspace =
      input.workspaceId === undefined
        ? await this.defaultWorkspace(tx, input.organizationId)
        : await tx.workspace.findFirst({
            where: { id: input.workspaceId, organizationId: input.organizationId },
            select: { id: true },
          });
    if (!workspace) throw new NotFoundException({ code: 'not_found' });

    const project = await tx.project.create({
      data: {
        organizationId: input.organizationId,
        workspaceId: workspace.id,
        name: input.name,
        slug,
        description: input.description,
        engineId: engine.id,
        engineVersion: input.engineVersion,
        // Doc 03 §15 — the contract version the stored props are being written under.
        // Taken from the engine, never from the request.
        enginePluginVersion: engine.version,
        createdById: actorUserId,
      },
      select: {
        id: true,
        name: true,
        engineId: true,
        engineVersion: true,
        enginePluginVersion: true,
        restrictedFieldMode: true,
        updatedAt: true,
      },
    });

    // Doc 02: "Every project has exactly one default namespace, created with the
    // project." That guarantee is what lets `entities.namespace_id` stay nullable in the
    // store while the IR resolves null to this row's id. An engine with no namespaces
    // gets one named '' that its UI never shows.
    await tx.namespace.create({
      data: {
        projectId: project.id,
        name: engine.capabilities.defaultNamespaceName ?? '',
        isDefault: true,
      },
    });

    await tx.accessGrant.create({
      data: {
        organizationId: input.organizationId,
        projectId: project.id,
        resourceType: ResourceType.project,
        // C6: for `resourceType = project` this equals `projectId` (CHECK enforced).
        resourceId: project.id,
        principalType: PrincipalType.user,
        principalId: actorUserId,
        roleId: BUILTIN_ROLE_IDS.manager,
        createdById: actorUserId,
      },
    });

    return project;
  }

  /**
   * The org's first workspace by sidebar order, or a new "General" one. Creating an org
   * does not create a workspace, so a brand-new org has none until its first project.
   *
   * ponytail: two concurrent first creates can both miss and race on
   * `(organizationId, slug)`; the loser gets `project_slug_taken`'s 409 and a retry
   * succeeds. Create the workspace with the org if that ever matters.
   */
  private async defaultWorkspace(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<{ id: string }> {
    const existing = await tx.workspace.findFirst({
      where: { organizationId },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    return (
      existing ??
      tx.workspace.create({
        data: { organizationId, name: 'General', slug: 'general' },
        select: { id: true },
      })
    );
  }
}
