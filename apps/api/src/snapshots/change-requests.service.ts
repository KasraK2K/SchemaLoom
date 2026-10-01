import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  RawSchemaModel,
  diffModels,
  type RedactedModel,
  type SchemaModel,
} from '@schemaloom/schema-model';
import {
  DRAFT_REVIEW_ATOMS,
  PermissionResolver,
  VisibilityFilter,
  buildSkeleton,
  hasCompleteView,
  type ProjectPermissionMap,
  type Subject,
} from '../access';
import type { ChangeRequest, ChangeRequestReview } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SchemaWriter } from '../schema';
import { freshIds, invertIds, remapIds, type IdMap } from './change-request-ids';
import { asLive, blobToLive, loadLiveProject, snapshotBlob, type LiveIr } from './live-ir';
import { planImport } from './restore-plan';
import { withCounts, type HistoryDiff, type SnapshotContext } from './snapshots.service';

type User = Extract<Subject, { kind: 'user' }>;

export interface CreateChangeRequestInput {
  readonly title: string;
  readonly description?: string;
  readonly reviewerIds?: readonly string[];
}

export interface ChangeRequestReviewView {
  readonly id: string;
  readonly reviewer: { readonly id: string; readonly name: string } | null;
  readonly verdict: ChangeRequestReview['verdict'];
  readonly note: string;
  /** False once the draft changed after this review (§4). */
  readonly current: boolean;
  readonly createdAt: string;
}

export interface ChangeRequestSummary {
  readonly id: string;
  readonly projectId: string;
  readonly draftProjectId: string;
  readonly title: string;
  readonly description: string;
  readonly status: ChangeRequest['status'];
  readonly author: { readonly id: string; readonly name: string } | null;
  readonly reviewerIds: readonly string[];
  readonly reviews: readonly ChangeRequestReviewView[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
}

export interface ChangeRequestDetail extends ChangeRequestSummary {
  /** The base → draft diff, in main-project ids. */
  readonly changes: HistoryDiff;
}

const ROW_INCLUDE = {
  author: { select: { id: true, name: true } },
  reviews: {
    orderBy: { createdAt: 'asc' },
    include: { reviewer: { select: { id: true, name: true } } },
  },
} as const;

type Row = ChangeRequest & {
  author: { id: string; name: string } | null;
  reviews: (ChangeRequestReview & { reviewer: { id: string; name: string } | null })[];
};

/**
 * Phase 10 (`docs/phase10/DESIGN.md`) — change requests.
 *
 * The draft is a hidden project written through `SchemaWriter` like any other, and
 * `idMap` carries its edits back. Everything here that touches an unredacted model lives
 * in `src/snapshots`, next to restore, which is the other path that plans writes from raw
 * models. Every reader passes `hasCompleteView` on the main project first (§3), so a
 * request never shows anyone more than they already see.
 */
@Injectable()
export class ChangeRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly filter: VisibilityFilter,
    private readonly writer: SchemaWriter,
  ) {}

  // ── create ─────────────────────────────────────────────────────────────────────────

  async create(
    ctx: SnapshotContext,
    input: CreateChangeRequestInput,
  ): Promise<ChangeRequestSummary> {
    const user = asUser(ctx.subject);
    const main = await this.prisma.project.findFirst({
      where: { id: ctx.projectId, deletedAt: null },
      select: {
        id: true,
        organizationId: true,
        workspaceId: true,
        name: true,
        engineId: true,
        engineVersion: true,
        enginePluginVersion: true,
        restrictedFieldMode: true,
        settings: true,
        draftOfId: true,
      },
    });
    if (main === null) throw notFound('project', ctx.projectId);
    if (main.draftOfId !== null) throw new BadRequestException({ code: 'change_request_of_draft' });
    if (!hasCompleteView(ctx.map, ctx.skel)) {
      throw new ForbiddenException({ code: 'change_request_full_view_required' });
    }

    const project = await loadLiveProject(this.prisma, ctx.projectId);
    const toDraft = freshIds(project.live, {}, randomUUID);
    const defaultNs = Object.values(project.live.objects.namespace).find((n) => n.isDefault);
    const reviewerIds = [...new Set(input.reviewerIds ?? [])].filter((id) => id !== user.userId);

    const row = await this.prisma.$transaction(async (tx) => {
      const draft = await tx.project.create({
        data: {
          organizationId: main.organizationId,
          workspaceId: main.workspaceId,
          name: `${main.name}: ${input.title}`,
          slug: `draft-${randomUUID()}`,
          engineId: main.engineId,
          // The main project's versions, not the engine's: a draft of a read-only project
          // is read-only for the same reason (EngineGate).
          engineVersion: main.engineVersion,
          enginePluginVersion: main.enginePluginVersion,
          restrictedFieldMode: main.restrictedFieldMode,
          settings: main.settings ?? {},
          createdById: user.userId,
          draftOfId: main.id,
        },
        select: { id: true },
      });
      // Every project has exactly one default namespace from birth (projects.service).
      // The copy's is created here under its mapped id, so the fork below matches it.
      if (defaultNs !== undefined) {
        await tx.namespace.create({
          data: {
            id: toDraft[defaultNs.id] ?? randomUUID(),
            projectId: draft.id,
            name: defaultNs.name,
            isDefault: true,
          },
        });
      }
      return tx.changeRequest.create({
        data: {
          projectId: main.id,
          draftProjectId: draft.id,
          authorId: user.userId,
          title: input.title,
          description: input.description ?? '',
          baseIr: snapshotBlob(project.live),
          idMap: invertIds(toDraft),
          reviewerIds,
        },
        include: ROW_INCLUDE,
      });
    });

    try {
      await this.writeDraft(user, row.draftProjectId, (live) =>
        asLive(remapIds(project.live, toDraft, live.projectId)),
      );
    } catch (error) {
      // A half-copied draft is worse than none: the author would review a partial diff.
      await this.prisma.project.delete({ where: { id: row.draftProjectId } });
      throw error;
    }
    return summary(row, await this.draftRevision(row.draftProjectId));
  }

  // ── read ───────────────────────────────────────────────────────────────────────────

  async list(ctx: SnapshotContext): Promise<ChangeRequestSummary[]> {
    if (ctx.subject.kind !== 'user' || !hasCompleteView(ctx.map, ctx.skel)) return [];
    const rows = await this.prisma.changeRequest.findMany({
      where: { projectId: ctx.projectId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: ROW_INCLUDE,
    });
    const revisions = await this.draftRevisions(rows.map((r) => r.draftProjectId));
    return rows.map((r) => summary(r, revisions.get(r.draftProjectId) ?? null));
  }

  async get(subject: Subject, id: string): Promise<ChangeRequestDetail> {
    const { row } = await this.readable(subject, id);
    const [draft, revision] = await Promise.all([
      loadLiveProject(this.prisma, row.draftProjectId),
      this.draftRevision(row.draftProjectId),
    ]);
    const base = blobToLive(row.baseIr);
    const theirs = remapIds(draft.live, row.idMap as IdMap, row.projectId);
    const restrictedFieldMode = await this.restrictedFieldMode(row.projectId);
    const diff = diffModels(
      this.reviewerView(base, subject, row.projectId, restrictedFieldMode),
      this.reviewerView(theirs, subject, row.projectId, restrictedFieldMode),
      {
        from: { kind: 'snapshot', label: 'Start of the request' },
        to: { kind: 'live', label: 'Draft' },
      },
    );
    return { ...summary(row, revision), changes: withCounts(diff) };
  }

  // ── shared ─────────────────────────────────────────────────────────────────────────

  /**
   * §3 — the gate for everything addressed by request id: the request's main project must
   * be one the caller sees completely. Anything less is the same 404 as a wrong id.
   */
  private async readable(
    subject: Subject,
    id: string,
  ): Promise<{ row: Row; map: ProjectPermissionMap }> {
    // The guard already 404s a share link on these routes; a draft is never a link's.
    if (subject.kind !== 'user') throw notFound('change_request', id);
    const row = await this.prisma.changeRequest.findFirst({
      where: { id, project: { deletedAt: null } },
      include: ROW_INCLUDE,
    });
    if (row === null) throw notFound('change_request', id);
    const [map, skel] = await Promise.all([
      this.resolver.resolveProject(subject, row.projectId),
      this.resolver.skeleton(row.projectId),
    ]);
    if (!hasCompleteView(map, skel)) throw notFound('change_request', id);
    return { row, map };
  }

  /**
   * The review diff, redacted through `VisibilityFilter` like every other schema read.
   * The caller passed `hasCompleteView`, so the map is the uniform read map, over a
   * skeleton built from THIS model: a table the draft deleted, or created, is not in the
   * main project's skeleton, and redacting with that would drop it from the review.
   */
  private reviewerView(
    model: SchemaModel,
    subject: Subject,
    projectId: string,
    restrictedFieldMode: ProjectPermissionMap['restrictedFieldMode'],
  ): RedactedModel {
    const entities = Object.values(model.objects.entity).map((e) => ({
      id: e.id,
      areaId: e.areaId,
    }));
    const restricted = new Set(
      Object.values(model.objects.field)
        .filter((f) => f.isRestricted)
        .map((f) => f.entityId),
    );
    const areaIds = Object.keys(model.objects.area);
    const skel = buildSkeleton(0, areaIds, entities, [...restricted]);
    const map: ProjectPermissionMap = {
      projectId,
      subjectKey: '',
      orgRole: null,
      projectAtoms: DRAFT_REVIEW_ATOMS,
      areaAtoms: new Map(areaIds.map((a) => [a, DRAFT_REVIEW_ATOMS])),
      entityOverrides: new Map(),
      restrictedFieldMode,
      validUntil: 0,
    };
    return this.filter.redactWith(new RawSchemaModel(model), subject, projectId, map, skel);
  }

  /**
   * Bring the draft to `target(currentDraft)` through `SchemaWriter`, as the author, in
   * the import's batches. The map and skeleton are re-read between batches: the next
   * batch's checks must see what the previous one created.
   */
  private async writeDraft(
    user: User,
    draftProjectId: string,
    target: (draft: LiveIr) => LiveIr,
    label = 'Change request: copy of the project',
  ): Promise<void> {
    const first = await loadLiveProject(this.prisma, draftProjectId);
    const batches = planImport(first.live, target(first.live), randomUUID, label);
    let current = first;
    for (const [i, batch] of batches.entries()) {
      if (i > 0) current = await loadLiveProject(this.prisma, draftProjectId);
      const [map, skel] = await Promise.all([
        this.resolver.resolveProject(user, draftProjectId),
        this.resolver.skeleton(draftProjectId),
      ]);
      await this.writer.apply(batch, {
        projectId: draftProjectId,
        actorUserId: user.userId,
        map,
        skel,
        redacted: this.filter.redactWith(current.raw, user, draftProjectId, map, skel),
      });
    }
  }

  private async restrictedFieldMode(
    projectId: string,
  ): Promise<ProjectPermissionMap['restrictedFieldMode']> {
    const row = await this.prisma.project.findFirst({
      where: { id: projectId },
      select: { restrictedFieldMode: true },
    });
    return row?.restrictedFieldMode === 'hide' ? 'hide' : 'mask';
  }

  private async draftRevision(draftProjectId: string): Promise<bigint | null> {
    return (await this.draftRevisions([draftProjectId])).get(draftProjectId) ?? null;
  }

  private async draftRevisions(ids: readonly string[]): Promise<Map<string, bigint>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.project.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, schemaRevision: true },
    });
    return new Map(rows.map((r) => [r.id, r.schemaRevision]));
  }
}

function summary(row: Row, draftRevision: bigint | null): ChangeRequestSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    draftProjectId: row.draftProjectId,
    title: row.title,
    description: row.description,
    status: row.status,
    author: row.author,
    reviewerIds: row.reviewerIds,
    reviews: row.reviews.map((r) => ({
      id: r.id,
      reviewer: r.reviewer,
      verdict: r.verdict,
      note: r.note,
      current: draftRevision !== null && r.draftRevision === draftRevision,
      createdAt: r.createdAt.toISOString(),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    mergedAt: row.mergedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

function asUser(subject: Subject): User {
  if (subject.kind !== 'user') throw new ForbiddenException({ code: 'route_not_classified' });
  return subject;
}

const notFound = (resourceType: string, id: string): NotFoundException =>
  new NotFoundException({ code: 'not_found', resourceType, id });
