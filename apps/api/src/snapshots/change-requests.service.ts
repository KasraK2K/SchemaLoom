import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { NotificationType } from '@schemaloom/contracts';
import {
  IR_OBJECT_TYPES,
  RawSchemaModel,
  diffModels,
  threeWay,
  type MergeConflict,
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
import { NotificationsService } from '../notifications';
import { PrismaService } from '../prisma/prisma.service';
import { SchemaWriter } from '../schema';
import { freshIds, invertIds, remapIds, type IdMap } from './change-request-ids';
import { writeAutoSnapshot } from './auto-snapshot';
import {
  asLive,
  blobToLive,
  loadLiveProject,
  snapshotBlob,
  type LiveIr,
  type LiveProject,
} from './live-ir';
import { planImport, planRestore } from './restore-plan';
import {
  SnapshotsService,
  withCounts,
  type HistoryDiff,
  type MigrationRequest,
  type MigrationView,
  type SnapshotContext,
} from './snapshots.service';

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

export interface ConflictView extends MergeConflict {
  readonly name: string;
}

/** Why Merge is disabled, first reason wins. `null` when the caller may merge now. */
export type MergeBlocker =
  'not_open' | 'no_changes' | 'conflicts' | 'changes_requested' | 'needs_approval' | 'forbidden';

export interface ChangeRequestDetail extends ChangeRequestSummary {
  /** The base → draft diff, in main-project ids. */
  readonly changes: HistoryDiff;
  /** Objects changed on both sides since the base (§5). */
  readonly conflicts: readonly ConflictView[];
  /** Echo it on merge, so an edit made after the review cannot ride along. */
  readonly draftRevision: string;
  readonly mergeBlockedBy: MergeBlocker | null;
  readonly canReview: boolean;
  /** Close and reopen. Update from main is the author's alone. */
  readonly canManage: boolean;
  readonly isAuthor: boolean;
}

export interface UpdateFromMainResult {
  /** Draft objects that main's version replaced, or that no longer fit and were dropped. */
  readonly reset: readonly ConflictView[];
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
  private readonly logger = new Logger(ChangeRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly filter: VisibilityFilter,
    private readonly writer: SchemaWriter,
    private readonly snapshots: SnapshotsService,
    private readonly notifications: NotificationsService,
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
    await this.notify(
      row,
      row.reviewerIds,
      user.userId,
      'change_request.review_requested',
      'You were asked to review a change request',
    );
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
    const { row, map } = await this.readable(subject, id);
    const user = asUser(subject);
    const state = await this.state(row);
    const isAuthor = row.authorId === user.userId;
    const canEditMain = map.projectAtoms.has('schema:edit');
    const diff = diffModels(
      this.reviewerView(state.base, subject, row.projectId, state.restrictedFieldMode),
      this.reviewerView(state.theirs, subject, row.projectId, state.restrictedFieldMode),
      {
        from: { kind: 'snapshot', label: 'Start of the request' },
        to: { kind: 'live', label: 'Draft' },
      },
    );
    return {
      ...summary(row, state.draft.schemaRevision),
      changes: withCounts(diff),
      conflicts: state.conflicts,
      draftRevision: state.draft.schemaRevision.toString(),
      mergeBlockedBy: blocker(row, state, canEditMain || canEditSomeArea(map)),
      canReview: row.status === 'open' && !isAuthor && canEditMain,
      canManage: row.status !== 'merged' && (isAuthor || canEditMain),
      isAuthor,
    };
  }

  /** §5 — migration SQL for the change set: main as it is → main with the draft merged. */
  async migration(subject: Subject, id: string, request: MigrationRequest): Promise<MigrationView> {
    const { row } = await this.readable(subject, id);
    const state = await this.state(row);
    const { merged } = threeWay(state.base, state.main.live, state.theirs);
    return this.snapshots.migrationBetween(
      row.projectId,
      this.reviewerView(state.main.live, subject, row.projectId, state.restrictedFieldMode),
      this.reviewerView(merged, subject, row.projectId, state.restrictedFieldMode),
      request,
    );
  }

  // ── reviews, merge, update, close ──────────────────────────────────────────────────

  /** §4 — an editor of the main project who is not the author. */
  async review(
    subject: Subject,
    id: string,
    input: { readonly verdict: ChangeRequestReview['verdict']; readonly note?: string },
  ): Promise<ChangeRequestSummary> {
    const { row, map } = await this.readable(subject, id);
    const user = asUser(subject);
    assertOpen(row);
    if (row.authorId === user.userId) {
      throw new ForbiddenException({ code: 'change_request_own_review' });
    }
    if (!map.projectAtoms.has('schema:edit')) {
      throw new ForbiddenException({ code: 'forbidden', details: { atom: 'schema:edit' } });
    }
    await this.prisma.changeRequestReview.create({
      data: {
        changeRequestId: row.id,
        reviewerId: user.userId,
        verdict: input.verdict,
        note: input.note ?? '',
        draftRevision: (await this.draftRevision(row.draftProjectId)) ?? 0n,
      },
    });
    await this.notify(
      row,
      row.authorId === null ? [] : [row.authorId],
      user.userId,
      'change_request.reviewed',
      input.verdict === 'approved'
        ? 'Your change request was approved'
        : 'Changes were requested on your change request',
    );
    return this.summaryOf(row.id);
  }

  /**
   * §5 — the merge: `threeWay` with no conflicts, then ONE batch through `SchemaWriter` as
   * the merger, so every op is checked against the merger's own map. The "Before merging"
   * snapshot and the status flip share that batch's transaction.
   */
  async merge(
    subject: Subject,
    id: string,
    expectedDraftRevision: string,
  ): Promise<ChangeRequestSummary> {
    const { row, map } = await this.readable(subject, id);
    const user = asUser(subject);
    const state = await this.state(row);
    if (state.draft.schemaRevision.toString() !== expectedDraftRevision) {
      throw new ConflictException({ code: 'change_request_changed' });
    }
    const blockedBy = blocker(row, state, true);
    if (blockedBy === 'conflicts') {
      throw new ConflictException({ code: 'change_request_conflict', conflicts: state.conflicts });
    }
    if (blockedBy !== null) {
      throw new ConflictException({ code: 'change_request_not_mergeable', reason: blockedBy });
    }

    const { merged } = threeWay(state.base, state.main.live, state.theirs);
    const batch = planMerge(state.main.live, asLive(merged), row.title);
    if (batch === null) {
      throw new ConflictException({ code: 'change_request_not_mergeable', reason: 'no_changes' });
    }

    // Advisory, like restore's: a write that landed after `state` was read is caught here
    // or, for anything an op names, by the version checks inside the write.
    await this.assertRevision(row.projectId, state.main.schemaRevision);
    const skel = await this.resolver.skeleton(row.projectId);
    const now = new Date();
    try {
      await this.writer.apply(batch, {
        projectId: row.projectId,
        actorUserId: user.userId,
        map,
        skel,
        redacted: this.filter.redactWith(state.main.raw, user, row.projectId, map, skel),
        beforeWrite: async (tx) => {
          const flipped = await tx.changeRequest.updateMany({
            where: { id: row.id, status: 'open' },
            data: { status: 'merged', mergedAt: now, mergedById: user.userId },
          });
          if (flipped.count !== 1) {
            throw new ConflictException({ code: 'change_request_changed' });
          }
          await writeAutoSnapshot(tx, {
            projectId: row.projectId,
            kind: 'auto',
            name: `Before merging "${row.title}"`,
            live: state.main.live,
            enginePluginVersion: state.main.enginePluginVersion,
            createdById: user.userId,
            now,
          });
        },
      });
    } catch (error) {
      if (error instanceof ConflictException && codeOf(error) !== 'change_request_changed') {
        // A version conflict: main moved under us. Reloading the page shows the new state.
        throw new ConflictException({ code: 'change_request_conflict', conflicts: [] });
      }
      throw error;
    }
    await this.notify(
      row,
      [
        ...(row.authorId === null ? [] : [row.authorId]),
        ...row.reviews.flatMap((r) => (r.reviewerId === null ? [] : [r.reviewerId])),
      ],
      user.userId,
      'change_request.merged',
      'A change request you are part of was merged',
    );
    return this.summaryOf(row.id);
  }

  /**
   * §5 — bring main's changes since the base into the draft. On a conflict main wins and
   * the author redoes the edit; new main objects get fresh draft ids. Author only: the
   * draft's writes are the author's.
   */
  async updateFromMain(subject: Subject, id: string): Promise<UpdateFromMainResult> {
    const { row } = await this.readable(subject, id);
    const user = asUser(subject);
    assertOpen(row);
    if (row.authorId !== user.userId) {
      throw new ForbiddenException({ code: 'change_request_author_only' });
    }
    const state = await this.state(row);
    const result = threeWay(state.base, state.theirs, state.main.live, { prefer: 'theirs' });

    // main id -> draft id for everything already in the draft. An object the author
    // created in the draft has no entry in `idMap` and the same id in both spaces.
    const idMap = row.idMap as IdMap;
    const toDraft: Record<string, string> = invertIds(idMap);
    for (const type of IR_OBJECT_TYPES) {
      for (const draftId of Object.keys(state.draft.live.objects[type])) {
        if (idMap[draftId] === undefined) toDraft[draftId] = draftId;
      }
    }
    Object.assign(toDraft, freshIds(result.merged, toDraft, randomUUID));
    const target = asLive(remapIds(result.merged, toDraft, row.draftProjectId));

    await this.writeDraft(
      user,
      row.draftProjectId,
      () => target,
      'Change request: update from main',
    );
    await this.prisma.changeRequest.update({
      where: { id: row.id },
      data: {
        baseIr: snapshotBlob(state.main.live),
        idMap: Object.fromEntries(
          Object.entries(invertIds(toDraft)).filter(([draftId, mainId]) => draftId !== mainId),
        ),
      },
    });
    return { reset: named(result.conflicts, [state.theirs, state.main.live, state.base]) };
  }

  /** The draft stays, read-only (the resolver's `draftOpen`), so reopening is a flip. */
  async setOpen(subject: Subject, id: string, open: boolean): Promise<ChangeRequestSummary> {
    const { row, map } = await this.readable(subject, id);
    const user = asUser(subject);
    if (row.authorId !== user.userId && !map.projectAtoms.has('schema:edit')) {
      throw new ForbiddenException({ code: 'forbidden', details: { atom: 'schema:edit' } });
    }
    const changed = await this.prisma.changeRequest.updateMany({
      where: { id: row.id, status: open ? 'closed' : 'open' },
      data: open ? { status: 'open', closedAt: null } : { status: 'closed', closedAt: new Date() },
    });
    if (changed.count !== 1) {
      throw new ConflictException({ code: 'change_request_not_open', status: row.status });
    }
    return this.summaryOf(row.id);
  }

  // ── shared ─────────────────────────────────────────────────────────────────────────

  /**
   * Phase 10 §7. Recipients are re-checked at send time (doc 05 L17): only someone with a
   * complete view of the main project can open the request, so no one else gets a row.
   * Titles carry no request title, which is free text that can name tables (L7). Best
   * effort: the write it reports on has already committed.
   */
  private async notify(
    row: { readonly id: string; readonly projectId: string },
    recipients: readonly string[],
    actorUserId: string,
    type: NotificationType,
    title: string,
  ): Promise<void> {
    try {
      const users = [...new Set(recipients)].filter((id) => id !== actorUserId);
      if (users.length === 0) return;
      const project = await this.prisma.project.findFirst({
        where: { id: row.projectId },
        select: { organizationId: true },
      });
      if (project === null) return;
      const skel = await this.resolver.skeleton(row.projectId);
      const maps = await Promise.all(
        users.map((userId) =>
          this.resolver.resolveProject(
            { kind: 'user', userId, orgId: project.organizationId },
            row.projectId,
          ),
        ),
      );
      const allowed = users.filter((_, i) => {
        const map = maps[i];
        return map !== undefined && hasCompleteView(map, skel);
      });
      if (allowed.length === 0) return;
      const base = await this.notifications.projectUrl(row.projectId);
      const url = base === null ? null : `${base}/changes/${row.id}`;
      await this.notifications.send(
        allowed.map((userId) => ({
          userId,
          actorUserId,
          organizationId: project.organizationId,
          projectId: row.projectId,
          type,
          title,
          url,
          data: { changeRequestId: row.id },
        })),
      );
    } catch (error) {
      this.logger.warn({ err: error, changeRequestId: row.id, type }, 'notification failed');
    }
  }

  /** The three models of §5 plus what the page needs, read once per call. */
  private async state(row: Row): Promise<MergeState> {
    const [main, draft, restrictedFieldMode] = await Promise.all([
      loadLiveProject(this.prisma, row.projectId),
      loadLiveProject(this.prisma, row.draftProjectId),
      this.restrictedFieldMode(row.projectId),
    ]);
    const base = blobToLive(row.baseIr);
    const theirs = asLive(remapIds(draft.live, row.idMap as IdMap, row.projectId));
    const merge = threeWay(base, main.live, theirs);
    return {
      base,
      main,
      draft,
      theirs,
      restrictedFieldMode,
      taken: merge.taken,
      conflicts: named(merge.conflicts, [main.live, theirs, base]),
    };
  }

  private async summaryOf(id: string): Promise<ChangeRequestSummary> {
    const row = await this.prisma.changeRequest.findUniqueOrThrow({
      where: { id },
      include: ROW_INCLUDE,
    });
    return summary(row, await this.draftRevision(row.draftProjectId));
  }

  private async assertRevision(projectId: string, expected: bigint): Promise<void> {
    const row = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { schemaRevision: true },
    });
    if (row?.schemaRevision !== expected) {
      throw new ConflictException({ code: 'change_request_conflict', conflicts: [] });
    }
  }

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
    // `{}`: the draft takes main's area moves and restriction changes as they are.
    const batches = planImport(first.live, target(first.live), randomUUID, label, {});
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

interface MergeState {
  readonly base: LiveIr;
  readonly main: LiveProject;
  readonly draft: LiveProject;
  /** The draft in main ids. */
  readonly theirs: LiveIr;
  readonly restrictedFieldMode: ProjectPermissionMap['restrictedFieldMode'];
  /** Objects the merge takes from the draft. */
  readonly taken: number;
  readonly conflicts: readonly ConflictView[];
}

/** §3/§4 — first reason wins, in the order the page explains them. */
function blocker(row: Row, state: MergeState, mayWrite: boolean): MergeBlocker | null {
  if (row.status !== 'open') return 'not_open';
  if (state.taken === 0) return 'no_changes';
  if (state.conflicts.length > 0) return 'conflicts';
  const latest = new Map<string, Row['reviews'][number]>();
  for (const r of row.reviews) if (r.reviewerId !== null) latest.set(r.reviewerId, r);
  // §4: a review counts only while the draft is unchanged since it was given.
  const current = [...latest.values()].filter(
    (r) => r.draftRevision === state.draft.schemaRevision,
  );
  if (current.some((r) => r.verdict === 'changes_requested')) return 'changes_requested';
  if (!current.some((r) => r.verdict === 'approved' && r.reviewerId !== row.authorId)) {
    return 'needs_approval';
  }
  return mayWrite ? null : 'forbidden';
}

/**
 * The merge batch. `{}`, `{}` instead of restore's R28 defaults: a reviewed request
 * carries its area moves and restriction changes, and `SchemaWriter` checks each one
 * against the merger (`requirements.ts`). One batch, so the merge is atomic (§10 Q8).
 */
function planMerge(main: LiveIr, merged: LiveIr, title: string) {
  try {
    return planRestore(
      main,
      merged,
      { kind: 'live', label: title },
      randomUUID(),
      `Merge "${title}"`,
      {},
      {},
    );
  } catch (error) {
    if (error instanceof BadRequestException && codeOf(error) === 'restore_too_large') {
      throw new BadRequestException({ code: 'change_request_too_large' });
    }
    throw error;
  }
}

/** Whether the map can write anywhere; the per-op check is `SchemaWriter`'s, at merge. */
const canEditSomeArea = (map: ProjectPermissionMap): boolean =>
  [...map.areaAtoms.values()].some((a) => a.has('schema:edit'));

function named(
  conflicts: readonly MergeConflict[],
  models: readonly SchemaModel[],
): ConflictView[] {
  return conflicts.map((c) => {
    const object = models
      .map((m) => (m.objects[c.type] as Record<string, { name: string } | undefined>)[c.id])
      .find((o) => o !== undefined);
    return { ...c, name: object?.name ?? '' };
  });
}

function assertOpen(row: Row): void {
  if (row.status !== 'open') {
    throw new ConflictException({ code: 'change_request_not_open', status: row.status });
  }
}

const codeOf = (error: { getResponse(): unknown }): string | undefined => {
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && 'code' in body
    ? String(body.code)
    : undefined;
};

function asUser(subject: Subject): User {
  if (subject.kind !== 'user') throw new ForbiddenException({ code: 'route_not_classified' });
  return subject;
}

const notFound = (resourceType: string, id: string): NotFoundException =>
  new NotFoundException({ code: 'not_found', resourceType, id });
