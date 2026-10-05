import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { OrgRole } from '@schemaloom/contracts';
import { majorOf, type EngineRegistry } from '@schemaloom/engine-sdk';
import type { SchemaModel } from '@schemaloom/schema-model';
import { hasCompleteView, type Subject } from '../access';
import { DocsService } from '../docs';
import { ENGINE_REGISTRY } from '../engines';
import type { OrgTemplate, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { freshIds, remapIds } from './change-request-ids';
import { ChangeRequestsService } from './change-requests.service';
import { asLive, blobToLive, loadLiveProject, snapshotBlob } from './live-ir';
import type { SnapshotContext } from './snapshots.service';

type User = Extract<Subject, { kind: 'user' }>;

/** §5 Q4 — so the new-project screen stays a list, not a search. */
export const ORG_TEMPLATE_LIMIT = 50;

const DOC_TARGETS = ['area', 'entity', 'field'] as const;
type DocTarget = (typeof DOC_TARGETS)[number];

interface TemplateDoc {
  readonly targetType: DocTarget;
  readonly targetId: string;
  readonly content: unknown;
  readonly structured: unknown;
}

export interface SaveOrgTemplateInput {
  readonly name: string;
  readonly summary?: string;
  readonly includeDocs: boolean;
  readonly includeLayout: boolean;
  /** "Replace": a template saved earlier from this same project. */
  readonly replaceId?: string;
}

export interface OrgTemplateView {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly engineId: string;
  readonly engineVersion: string;
  readonly tableCount: number;
  readonly savedBy: { readonly id: string; readonly name: string } | null;
  readonly sourceProjectId: string | null;
  /** False when it was saved on another engine major (§2.3): it must be saved again. */
  readonly usable: boolean;
  /** Rename and delete: the saver, owners and admins. */
  readonly canManage: boolean;
  readonly updatedAt: string;
}

const VIEW_SELECT = {
  id: true,
  name: true,
  summary: true,
  engineId: true,
  engineMajor: true,
  engineVersion: true,
  tableCount: true,
  sourceProjectId: true,
  createdById: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

type ViewRow = Prisma.OrgTemplateGetPayload<{ select: typeof VIEW_SELECT }>;

/**
 * Roadmap 12c (`docs/phase12/ORG-TEMPLATES.md` §2) — "Save as template".
 *
 * Here, beside change requests, because saving reads the live model and using one forks
 * it into a project the way a change request forks its draft: `freshIds`, then
 * `writeDraft`'s `planImport` batches through `SchemaWriter`. No second write path.
 */
@Injectable()
export class OrgTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requests: ChangeRequestsService,
    private readonly docs: DocsService,
    @Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry,
  ) {}

  /** D3: `sharing:manage` (the route) and a complete view, as the change-request fork. */
  async save(ctx: SnapshotContext, input: SaveOrgTemplateInput): Promise<OrgTemplateView> {
    const user = asUser(ctx.subject);
    const project = await this.prisma.project.findFirst({
      where: { id: ctx.projectId, deletedAt: null },
      select: {
        organizationId: true,
        engineId: true,
        engineVersion: true,
        enginePluginVersion: true,
        draftOfId: true,
      },
    });
    if (project?.draftOfId !== null) throw notFound(ctx.projectId);
    if (!hasCompleteView(ctx.map, ctx.skel)) {
      throw new ForbiddenException({ code: 'org_template_full_view_required' });
    }

    const { live } = await loadLiveProject(this.prisma, ctx.projectId);
    const model = input.includeLayout ? live : withoutLayout(live);
    const docs = input.includeDocs ? await this.readDocs(ctx.projectId, model) : [];
    const data = {
      name: input.name,
      summary: input.summary ?? '',
      engineId: project.engineId,
      engineMajor: majorOf(project.enginePluginVersion),
      engineVersion: project.engineVersion,
      model: snapshotBlob(asLive(model)),
      docs: docs as unknown as Prisma.InputJsonValue,
      tableCount: Object.keys(model.objects.entity).length,
    };

    if (input.replaceId !== undefined) {
      const existing = await this.prisma.orgTemplate.findFirst({
        where: {
          id: input.replaceId,
          organizationId: project.organizationId,
          sourceProjectId: ctx.projectId,
        },
        select: { createdById: true },
      });
      if (existing === null) throw notFound(input.replaceId);
      const role = await this.orgRole(user.userId, project.organizationId);
      if (!mayManage(existing.createdById, user.userId, role)) {
        throw new ForbiddenException({ code: 'org_template_manage_forbidden' });
      }
      const row = await this.prisma.orgTemplate.update({
        where: { id: input.replaceId },
        data,
        select: VIEW_SELECT,
      });
      return this.view(row, user.userId, role);
    }

    const count = await this.prisma.orgTemplate.count({
      where: { organizationId: project.organizationId },
    });
    if (count >= ORG_TEMPLATE_LIMIT) {
      throw new ConflictException({ code: 'org_template_limit', max: ORG_TEMPLATE_LIMIT });
    }
    const row = await this.prisma.orgTemplate.create({
      data: {
        ...data,
        organizationId: project.organizationId,
        sourceProjectId: ctx.projectId,
        createdById: user.userId,
      },
      select: VIEW_SELECT,
    });
    return this.view(row, user.userId, await this.orgRole(user.userId, project.organizationId));
  }

  /** D4: anyone who may create projects. `[]` for a guest or a non-member, like the
   *  project list, so the route is not an existence oracle. No model. */
  async list(userId: string, orgSlug: string): Promise<OrgTemplateView[]> {
    const member = await this.membership(userId, orgSlug);
    if (member === null || member.role === 'guest') return [];
    const rows = await this.prisma.orgTemplate.findMany({
      where: { organizationId: member.organizationId },
      orderBy: { updatedAt: 'desc' },
      select: VIEW_SELECT,
    });
    return rows.map((row) => this.view(row, userId, member.role));
  }

  async update(
    userId: string,
    orgSlug: string,
    id: string,
    patch: { name?: string; summary?: string },
  ): Promise<OrgTemplateView> {
    const { role } = await this.managed(userId, orgSlug, id);
    const row = await this.prisma.orgTemplate.update({
      where: { id },
      data: patch,
      select: VIEW_SELECT,
    });
    return this.view(row, userId, role);
  }

  async remove(userId: string, orgSlug: string, id: string): Promise<void> {
    await this.managed(userId, orgSlug, id);
    await this.prisma.orgTemplate.delete({ where: { id } });
  }

  /**
   * `POST /projects` with `orgTemplateId`, before the project exists: the template must
   * be this org's (else 404) and on the running engine's major (Q3: refused, never
   * converted). The marker already admitted only roles that may create projects.
   */
  async forCreate(organizationId: string, id: string): Promise<OrgTemplate> {
    const row = await this.prisma.orgTemplate.findFirst({ where: { id, organizationId } });
    if (row === null) throw notFound(id);
    if (!this.usable(row)) {
      throw new UnprocessableEntityException({ code: 'org_template_engine_outdated' });
    }
    return row;
  }

  /**
   * D5 — fill a brand-new project from the template, as its creator: fresh ids, the
   * fork's batches, then the docs. On failure the half-made project is deleted, as a
   * failed fork deletes its draft. A project made from a template doesn't remember it.
   */
  async fill(user: User, projectId: string, template: OrgTemplate): Promise<void> {
    try {
      const model = blobToLive(template.model);
      // The new project's default namespace already exists (projects.service): the
      // template's maps onto it rather than becoming a second default.
      const ns = await this.prisma.namespace.findFirstOrThrow({
        where: { projectId, isDefault: true },
        select: { id: true },
      });
      const from = Object.values(model.objects.namespace).find((n) => n.isDefault);
      const known: Record<string, string> = from === undefined ? {} : { [from.id]: ns.id };
      const ids = { ...known, ...freshIds(model, known, randomUUID) };
      await this.requests.writeDraft(
        user,
        projectId,
        (live) =>
          asLive({
            ...remapIds(model, ids, live.projectId),
            engineVersion: live.engineVersion,
          }),
        `Template: ${template.name}`,
        'import',
      );
      const docs = (template.docs as unknown as TemplateDoc[]).flatMap((d) => {
        const targetId = ids[d.targetId];
        return targetId === undefined ? [] : [{ ...d, targetId }];
      });
      await this.docs.importDocs(user, projectId, docs);
    } catch (error) {
      await this.prisma.project.delete({ where: { id: projectId } });
      throw error;
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────

  /** Docs of the model's areas, tables and columns (never project-level, never comments). */
  private async readDocs(projectId: string, model: SchemaModel): Promise<TemplateDoc[]> {
    const rows = await this.prisma.doc.findMany({
      where: { projectId, targetType: { in: [...DOC_TARGETS] } },
      select: { targetType: true, targetId: true, content: true, structured: true },
    });
    return rows.flatMap((row) => {
      const type = row.targetType as DocTarget;
      return model.objects[type][row.targetId] === undefined
        ? []
        : [
            {
              targetType: type,
              targetId: row.targetId,
              content: row.content,
              structured: row.structured,
            },
          ];
    });
  }

  private usable(row: { engineId: string; engineMajor: number }): boolean {
    const engine = this.registry.tryGet(row.engineId);
    return engine !== undefined && majorOf(engine.version) === row.engineMajor;
  }

  private view(row: ViewRow, userId: string, role: OrgRole | null): OrgTemplateView {
    return {
      id: row.id,
      name: row.name,
      summary: row.summary,
      engineId: row.engineId,
      engineVersion: row.engineVersion,
      tableCount: row.tableCount,
      savedBy: row.createdBy,
      sourceProjectId: row.sourceProjectId,
      usable: this.usable(row),
      canManage: mayManage(row.createdById, userId, role),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Invisible is 404: a non-member, a guest, or another org's template. */
  private async managed(userId: string, orgSlug: string, id: string): Promise<{ role: OrgRole }> {
    const member = await this.membership(userId, orgSlug);
    if (member === null || member.role === 'guest') throw notFound(id);
    const row = await this.prisma.orgTemplate.findFirst({
      where: { id, organizationId: member.organizationId },
      select: { createdById: true },
    });
    if (row === null) throw notFound(id);
    if (!mayManage(row.createdById, userId, member.role)) {
      throw new ForbiddenException({ code: 'org_template_manage_forbidden' });
    }
    return { role: member.role };
  }

  private membership(userId: string, orgSlug: string) {
    return this.prisma.orgMember.findFirst({
      where: { userId, organization: { slug: orgSlug, deletedAt: null } },
      select: { organizationId: true, role: true },
    });
  }

  private async orgRole(userId: string, organizationId: string): Promise<OrgRole | null> {
    const row = await this.prisma.orgMember.findFirst({
      where: { userId, organizationId },
      select: { role: true },
    });
    return row?.role ?? null;
  }
}

const mayManage = (createdById: string | null, userId: string, role: OrgRole | null): boolean =>
  createdById === userId || role === 'owner' || role === 'admin';

/** "Include layout" off: every table at the origin, which the canvas lays out on open. */
function withoutLayout(model: SchemaModel): SchemaModel {
  const entity = Object.fromEntries(
    Object.entries(model.objects.entity).map(([id, e]) => {
      const { width: _w, height: _h, ...rest } = e;
      return [id, { ...rest, position: { x: 0, y: 0 } }];
    }),
  );
  return { ...model, objects: { ...model.objects, entity } };
}

function asUser(subject: Subject): User {
  if (subject.kind !== 'user') throw new ForbiddenException({ code: 'route_not_classified' });
  return subject;
}

const notFound = (id: string): NotFoundException =>
  new NotFoundException({ code: 'not_found', resourceType: 'org_template', id });
