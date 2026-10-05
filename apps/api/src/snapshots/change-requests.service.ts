import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { NotificationType } from '@schemaloom/contracts';
import {
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
import { Prisma, type ChangeRequest, type ChangeRequestReview } from '../generated/prisma/client';
import { NotificationsService } from '../notifications';
import { PrismaService } from '../prisma/prisma.service';
import { GeometryWriter, SchemaWriter } from '../schema';
import { MAX_OPS_PER_BATCH } from '../schema/ops';
import type { SchemaDb } from '../schema/row-read';
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
  type ImportPreview,
  type MigrationRequest,
  type MigrationView,
  type SnapshotContext,
} from './snapshots.service';

type User = Extract<Subject, { kind: 'user' }>;

/** Roadmap 21b §9.3 — so a looping agent can't flood the review queue. */
export const AGENT_OPEN_PROPOSALS = 5;

export interface AgentProposal {
  readonly changeRequestId: string;
  /** The request's page, relative to the web origin. */
  readonly path: string;
  /** Tables the proposal adds. */
  readonly created: readonly string[];
  /** Tables it names that already exist: left as they are ("already exists"). */
  readonly skipped: readonly string[];
  /** Statements the importer read with loss, or not at all (none `failed`). */
  readonly notApplied: ImportPreview['notApplied'];
}

export interface CreateChangeRequestInput {
  /** Phase 10c: without a title the request is an unsubmitted draft (`submit` names it). */
  readonly title?: string;
  readonly description?: string;
  readonly reviewerIds?: readonly string[];
  /** Roadmap 21b — proposed by an AI agent through this API token. */
  readonly viaTokenId?: string;
}

export interface SubmitChangeRequestInput {
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
  /** Roadmap 21b — set when an AI agent proposed it through this token (the Agent badge). */
  readonly viaToken: { readonly name: string } | null;
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
  | 'not_submitted'
  | 'not_open'
  | 'no_changes'
  | 'conflicts'
  | 'changes_requested'
  | 'needs_approval'
  | 'forbidden';

export interface ChangeRequestDetail extends ChangeRequestSummary {
  /** The base → draft diff, in main-project ids. */
  readonly changes: HistoryDiff;
  /** Objects changed on both sides since the base (§5). */
  readonly conflicts: readonly ConflictView[];
  /** Echo it on merge, so an edit made after the review cannot ride along. */
  readonly draftRevision: string;
  readonly mergeBlockedBy: MergeBlocker | null;
  readonly canReview: boolean;
  /** Tables the draft moved; a merge moves them in the project too (Phase 10c §4). */
  readonly moved: number;
  /** Close and reopen. Update from main is the author's alone. */
  readonly canManage: boolean;
  /** `canManage`, and nobody has reviewed it yet: delete removes the request and its draft. */
  readonly canDelete: boolean;
  readonly isAuthor: boolean;
}

export interface UpdateFromMainResult {
  /** Draft objects that main's version replaced, or that no longer fit and were dropped. */
  readonly reset: readonly ConflictView[];
}

const ROW_INCLUDE = {
  author: { select: { id: true, name: true } },
  viaToken: { select: { name: true } },
  reviews: {
    orderBy: { createdAt: 'asc' },
    include: { reviewer: { select: { id: true, name: true } } },
  },
} as const;

type Row = ChangeRequest & {
  author: { id: string; name: string } | null;
  viaToken: { name: string } | null;
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
    private readonly geometry: GeometryWriter,
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

    // Phase 10c §2: proposing again opens the unsubmitted draft the caller already has.
    const title = input.title?.trim() ?? '';
    if (title === '') {
      const existing = await this.unsubmitted(main.id, user.userId);
      if (existing !== null) return existing;
    }

    const project = await loadLiveProject(this.prisma, ctx.projectId);
    const toDraft = freshIds(project.live, {}, randomUUID);
    const defaultNs = Object.values(project.live.objects.namespace).find((n) => n.isDefault);
    const reviewerIds = [...new Set(input.reviewerIds ?? [])].filter((id) => id !== user.userId);

    const fork = this.prisma.$transaction(async (tx) => {
      const draft = await tx.project.create({
        data: {
          organizationId: main.organizationId,
          workspaceId: main.workspaceId,
          name: draftName(main.name, title),
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
          title,
          description: input.description ?? '',
          status: title === '' ? 'draft' : 'open',
          baseIr: snapshotBlob(project.live),
          idMap: invertIds(toDraft),
          reviewerIds,
          viaTokenId: input.viaTokenId ?? null,
        },
        include: ROW_INCLUDE,
      });
    });
    let row: Row;
    try {
      row = await fork;
    } catch (error) {
      // Two clicks raced: `change_requests_one_draft_uq` kept one draft, so open that one.
      const existing =
        title === '' && isUniqueViolation(error)
          ? await this.unsubmitted(main.id, user.userId)
          : null;
      if (existing !== null) return existing;
      throw error;
    }

    try {
      await this.writeDraft(user, row.draftProjectId, (live) =>
        asLive(remapIds(project.live, toDraft, live.projectId)),
      );
    } catch (error) {
      // A half-copied draft is worse than none: the author would review a partial diff.
      await this.prisma.project.delete({ where: { id: row.draftProjectId } });
      throw error;
    }
    if (row.status === 'open') await this.notifyReviewers(row, row.reviewerIds, user.userId);
    return summary(row, await this.draftRevision(row.draftProjectId));
  }

  /**
   * Phase 10c §2 — name an unsubmitted draft and open it for review. Conditional on the
   * status, so a double click submits once; reviewers are notified as create did.
   */
  async submit(
    subject: Subject,
    id: string,
    input: SubmitChangeRequestInput,
  ): Promise<ChangeRequestSummary> {
    const { row } = await this.readable(subject, id);
    const user = asUser(subject);
    if (row.authorId !== user.userId) {
      throw new ForbiddenException({ code: 'change_request_author_only' });
    }
    const title = input.title.trim();
    if (title === '') throw new BadRequestException({ code: 'change_request_title_required' });
    const reviewerIds = [...new Set(input.reviewerIds ?? [])].filter((r) => r !== user.userId);
    await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.changeRequest.updateMany({
        where: { id: row.id, status: 'draft' },
        data: { status: 'open', title, description: input.description ?? '', reviewerIds },
      });
      if (flipped.count !== 1) {
        throw new ConflictException({ code: 'change_request_not_draft', status: row.status });
      }
      const main = await tx.project.findUniqueOrThrow({
        where: { id: row.projectId },
        select: { name: true },
      });
      await tx.project.update({
        where: { id: row.draftProjectId },
        data: { name: draftName(main.name, title) },
      });
    });
    await this.notifyReviewers(row, reviewerIds, user.userId);
    return this.summaryOf(row.id);
  }

  /**
   * Roadmap 21b §9.3 steps 2–7 — an AI agent's proposal, as a change request a person
   * reviews. The caller (`AiService.agentPropose`) checked `ai:use` and the AI switch.
   * Bad SQL is refused on the preview, before anything is forked; a failure after the fork
   * deletes the draft (and the request with it), so a failed proposal leaves nothing.
   */
  async proposeFromAgent(
    ctx: SnapshotContext,
    input: { tokenId: string; title: string; description?: string; sql: string },
  ): Promise<AgentProposal> {
    const user = asUser(ctx.subject);
    // Row 10 §3, as the canvas's Propose a change: the whole project, and the right to comment.
    if (!hasCompleteView(ctx.map, ctx.skel) || !ctx.map.projectAtoms.has('comment:create')) {
      throw new ForbiddenException({ code: 'forbidden', atom: 'comment:create' });
    }
    const open = await this.prisma.changeRequest.count({
      where: { viaTokenId: input.tokenId, status: { in: ['draft', 'open'] } },
    });
    if (open >= AGENT_OPEN_PROPOSALS) {
      throw new ConflictException({ code: 'too_many_proposals', max: AGENT_OPEN_PROPOSALS });
    }
    const preview = await this.snapshots.preview(ctx, input.sql);
    const failed = preview.notApplied.filter((s) => s.status === 'failed');
    if (failed.length > 0) {
      throw new UnprocessableEntityException({
        code: 'proposal_statements_failed',
        statements: failed,
      });
    }

    const request = await this.create(ctx, {
      title: input.title,
      ...(input.description === undefined ? {} : { description: input.description }),
      viaTokenId: input.tokenId,
    });
    try {
      const before = await this.draftRevision(request.draftProjectId);
      const [map, skel] = await Promise.all([
        this.resolver.resolveProject(user, request.draftProjectId),
        this.resolver.skeleton(request.draftProjectId),
      ]);
      await this.snapshots.importSource(
        { projectId: request.draftProjectId, subject: user, actorUserId: user.userId, map, skel },
        input.sql,
      );
      if ((await this.draftRevision(request.draftProjectId)) === before) {
        throw new UnprocessableEntityException({ code: 'nothing_to_propose' });
      }
    } catch (error) {
      await this.prisma.project.delete({ where: { id: request.draftProjectId } });
      throw error;
    }
    const org = await this.prisma.project.findUniqueOrThrow({
      where: { id: ctx.projectId },
      select: { organization: { select: { slug: true } } },
    });
    return {
      changeRequestId: request.id,
      path: `/${encodeURIComponent(org.organization.slug)}/p/${encodeURIComponent(ctx.projectId)}/changes/${encodeURIComponent(request.id)}`,
      created: preview.creates,
      skipped: preview.existing,
      notApplied: preview.notApplied,
    };
  }

  // ── read ───────────────────────────────────────────────────────────────────────────

  async list(ctx: SnapshotContext): Promise<ChangeRequestSummary[]> {
    if (ctx.subject.kind !== 'user' || !hasCompleteView(ctx.map, ctx.skel)) return [];
    const rows = await this.prisma.changeRequest.findMany({
      // Someone else's unsubmitted draft is theirs alone (Phase 10c §2).
      where: {
        projectId: ctx.projectId,
        OR: [{ status: { not: 'draft' } }, { authorId: ctx.subject.userId }],
      },
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
      moved: state.moves.length,
      canReview: row.status === 'open' && (!isAuthor || row.viaTokenId !== null) && canEditMain,
      canManage: (row.status === 'open' || row.status === 'closed') && (isAuthor || canEditMain),
      canDelete: row.status !== 'merged' && (isAuthor || canEditMain) && row.reviews.length === 0,
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

  /** §4 — an editor of the main project who is not the author. Roadmap 21b Q11: on an agent's
   *  request the author may review too; it still takes `schema:edit`. */
  async review(
    subject: Subject,
    id: string,
    input: { readonly verdict: ChangeRequestReview['verdict']; readonly note?: string },
  ): Promise<ChangeRequestSummary> {
    const { row, map } = await this.readable(subject, id);
    const user = asUser(subject);
    assertOpen(row);
    if (row.authorId === user.userId && row.viaTokenId === null) {
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
    const batch = state.taken === 0 ? null : planMerge(state.main.live, asLive(merged), row.title);
    if (batch === null && state.moves.length === 0) {
      throw new ConflictException({ code: 'change_request_not_mergeable', reason: 'no_changes' });
    }

    // Advisory, like restore's: a write that landed after `state` was read is caught here
    // or, for anything an op names, by the version checks inside the write.
    await this.assertRevision(row.projectId, state.main.schemaRevision);
    const skel = await this.resolver.skeleton(row.projectId);
    const now = new Date();
    const markMerged = async (tx: SchemaDb): Promise<void> => {
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
    };
    try {
      if (batch === null) {
        // Phase 10c §4: a request that only moves tables has no schema batch to ride on.
        await this.prisma.$transaction(markMerged);
      } else {
        await this.writer.apply(batch, {
          projectId: row.projectId,
          origin: 'merge',
          actorUserId: user.userId,
          map,
          skel,
          redacted: this.filter.redactWith(state.main.raw, user, row.projectId, map, skel),
          beforeWrite: markMerged,
        });
      }
    } catch (error) {
      if (error instanceof ConflictException && codeOf(error) !== 'change_request_changed') {
        // A version conflict: main moved under us. Reloading the page shows the new state.
        throw new ConflictException({ code: 'change_request_conflict', conflicts: [] });
      }
      throw error;
    }
    // Phase 10c §4: the draft's moves, through the geometry path so open canvases see them.
    // After the schema write, not inside it: layout is last-write-wins and never conflicts.
    for (let i = 0; i < state.moves.length; i += MAX_OPS_PER_BATCH) {
      await this.geometry.apply(
        { batchId: randomUUID(), entities: state.moves.slice(i, i + MAX_OPS_PER_BATCH) },
        { projectId: row.projectId, origin: 'merge', actorUserId: user.userId, map, skel },
      );
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
    // An unsubmitted draft can be brought up to date too (Phase 10c §2).
    if (row.status !== 'draft') assertOpen(row);
    if (row.authorId !== user.userId) {
      throw new ForbiddenException({ code: 'change_request_author_only' });
    }
    const state = await this.state(row);
    const result = threeWay(state.base, state.theirs, state.main.live, { prefer: 'theirs' });

    // main id -> draft id for everything already in the draft, including what the author
    // created there (under `state`'s fresh main ids), so those keep their draft ids.
    const toDraft: Record<string, string> = invertIds(state.toMain);
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
        // Created-in-the-draft objects stay out of `idMap`: their main ids are minted per read.
        idMap: Object.fromEntries(
          Object.entries(invertIds(toDraft)).filter(([draftId]) => !state.created.has(draftId)),
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

  /**
   * Removes the request and its draft for good: the draft project row goes, and the request
   * cascades with it, as when a fork fails. Only while unmerged (a merged request is part of
   * the project's history) and unreviewed (a review is someone else's work; close instead).
   */
  async remove(subject: Subject, id: string): Promise<void> {
    const { row, map } = await this.readable(subject, id);
    const user = asUser(subject);
    if (row.authorId !== user.userId && !map.projectAtoms.has('schema:edit')) {
      throw new ForbiddenException({ code: 'forbidden', details: { atom: 'schema:edit' } });
    }
    const organizationId = await this.prisma.$transaction(async (tx) => {
      // Re-checked inside the transaction: a merge or a review may have landed meanwhile.
      const gone = await tx.changeRequest.deleteMany({
        where: { id: row.id, status: { not: 'merged' }, reviews: { none: {} } },
      });
      if (gone.count !== 1) {
        const now = await tx.changeRequest.findUnique({
          where: { id: row.id },
          select: { status: true },
        });
        throw new ConflictException({
          code: now?.status === 'merged' ? 'change_request_merged' : 'change_request_reviewed',
        });
      }
      await tx.project.delete({ where: { id: row.draftProjectId } });
      const project = await tx.project.findUniqueOrThrow({
        where: { id: row.projectId },
        select: { organizationId: true },
      });
      return project.organizationId;
    });
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        projectId: row.projectId,
        actorUserId: user.userId,
        action: 'change_request.deleted',
        resourceType: 'change_request',
        resourceId: row.id,
        metadata: { draftProjectId: row.draftProjectId },
      },
    });
  }

  // ── shared ─────────────────────────────────────────────────────────────────────────

  private notifyReviewers(
    row: { readonly id: string; readonly projectId: string },
    reviewerIds: readonly string[],
    actorUserId: string,
  ): Promise<void> {
    return this.notify(
      row,
      reviewerIds,
      actorUserId,
      'change_request.review_requested',
      'You were asked to review a change request',
    );
  }

  /** The caller's unsubmitted request on this project, if any (at most one, by index). */
  private async unsubmitted(
    projectId: string,
    authorId: string,
  ): Promise<ChangeRequestSummary | null> {
    const row = await this.prisma.changeRequest.findFirst({
      where: { projectId, authorId, status: 'draft' },
      include: ROW_INCLUDE,
    });
    return row === null ? null : summary(row, await this.draftRevision(row.draftProjectId));
  }

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
    // Objects created in the draft have no `idMap` entry. §2 said they keep their id at
    // merge, but ids are global keys and the draft's own row still holds it, so a merge
    // that added a table failed on the primary key (found by roadmap 21b's e2e). They get
    // fresh main ids instead, stable for this one read: a merge plans and writes from it.
    const known = row.idMap as IdMap;
    const fresh = freshIds(draft.live, known, randomUUID);
    const toMain = { ...known, ...fresh };
    const theirs = asLive(remapIds(draft.live, toMain, row.projectId));
    const merge = threeWay(base, main.live, theirs);
    return {
      base,
      main,
      draft,
      theirs,
      toMain,
      created: new Set(Object.keys(fresh)),
      restrictedFieldMode,
      taken: merge.taken,
      moves: layoutMoves(base, main.live, theirs),
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
    // Phase 10c §2: an unsubmitted draft is its author's alone.
    if (row.status === 'draft' && row.authorId !== subject.userId) {
      throw notFound('change_request', id);
    }
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
   * batch's checks must see what the previous one created. Roadmap 12c fills a project
   * from an org template through this same loop (`origin: 'import'`).
   */
  async writeDraft(
    user: User,
    draftProjectId: string,
    target: (draft: LiveIr) => LiveIr,
    label = 'Change request: copy of the project',
    origin: 'draft' | 'import' = 'draft',
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
        origin,
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
    viaToken: row.viaToken,
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
  /** Draft id → main id for every draft object: `idMap`, plus fresh ids for created ones. */
  readonly toMain: IdMap;
  /** Draft ids of objects created in the draft (no `idMap` entry). */
  readonly created: ReadonlySet<string>;
  readonly restrictedFieldMode: ProjectPermissionMap['restrictedFieldMode'];
  /** Objects the merge takes from the draft. */
  readonly taken: number;
  /** Existing tables the draft moved and main didn't (Phase 10c §4). */
  readonly moves: readonly TableMove[];
  readonly conflicts: readonly ConflictView[];
}

/** §3/§4 — first reason wins, in the order the page explains them. */
function blocker(row: Row, state: MergeState, mayWrite: boolean): MergeBlocker | null {
  if (row.status === 'draft') return 'not_submitted';
  if (row.status !== 'open') return 'not_open';
  if (state.taken === 0 && state.moves.length === 0) return 'no_changes';
  if (state.conflicts.length > 0) return 'conflicts';
  const latest = new Map<string, Row['reviews'][number]>();
  for (const r of row.reviews) if (r.reviewerId !== null) latest.set(r.reviewerId, r);
  // §4: a review counts only while the draft is unchanged since it was given.
  const current = [...latest.values()].filter(
    (r) => r.draftRevision === state.draft.schemaRevision,
  );
  if (current.some((r) => r.verdict === 'changes_requested')) return 'changes_requested';
  // Roadmap 21b Q11: the author's approval counts on an agent's request, and only there.
  const counts = (r: Row['reviews'][number]) =>
    r.reviewerId !== row.authorId || row.viaTokenId !== null;
  if (!current.some((r) => r.verdict === 'approved' && counts(r))) {
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

const draftName = (projectName: string, title: string): string =>
  `${projectName}: ${title === '' ? 'draft' : title}`;

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

interface TableMove {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly width?: number;
  readonly height?: number;
}

/**
 * Phase 10c §4 — the draft's layout, carried by the merge: every table both sides still
 * have whose geometry the draft changed since the base. Where main moved it too (only an
 * unprotected project can), main's stays: layout is never a conflict. A table the draft
 * created brings its position along already, through the create.
 */
export function layoutMoves(
  base: SchemaModel,
  main: SchemaModel,
  theirs: SchemaModel,
): TableMove[] {
  const geometry = (e: SchemaModel['objects']['entity'][string] | undefined) =>
    e === undefined
      ? undefined
      : JSON.stringify([e.position.x, e.position.y, e.width ?? null, e.height ?? null]);
  const moves: TableMove[] = [];
  for (const [id, draft] of Object.entries(theirs.objects.entity)) {
    const was = geometry(base.objects.entity[id]);
    const now = main.objects.entity[id];
    if (was === undefined || now === undefined) continue;
    if (geometry(draft) === was || geometry(now) !== was) continue;
    moves.push({
      id,
      position: { x: draft.position.x, y: draft.position.y },
      ...(draft.width === undefined ? {} : { width: draft.width }),
      ...(draft.height === undefined ? {} : { height: draft.height }),
    });
  }
  return moves;
}
