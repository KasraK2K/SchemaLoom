import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CommentTargetType } from '@schemaloom/contracts';
import { Subject as Channel } from 'rxjs';
import {
  PermissionResolver,
  splitPrincipalKey,
  type AtomSet,
  type ProjectPermissionMap,
  type ProjectSkeleton,
  type Subject,
} from '../access';
import type { Comment, Prisma } from '../generated/prisma/client';
import { NotificationsService, type NotificationInput } from '../notifications';
import { PrismaService } from '../prisma/prisma.service';
import {
  TOMBSTONE,
  isTombstone,
  mentionedUserIds,
  plainTextOf,
  redactRichText,
  seesTarget,
  type CommentTarget,
} from './comment-rules';

type UserSubject = Subject & { kind: 'user' };

export interface CommentAuthor {
  /** Null when the reader is a guest who cannot see this person (doc 05 §8). */
  id: string | null;
  name: string;
  avatarUrl: string | null;
}

export interface CommentView {
  id: string;
  rootId: string;
  parentId: string | null;
  author: CommentAuthor | null;
  content: unknown;
  deleted: boolean;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  /** Roots only: own thread with `comment:create`, or `docs:edit` at the target. */
  canResolve: boolean;
}

export interface MentionCandidate {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** Doc 05 §8's fallback identity for a guest reader. */
export const TEAM_MEMBER = 'A team member';

const notFound = (resourceType: string, id: string): NotFoundException =>
  new NotFoundException({ code: 'not_found', resourceType, id });

/** What one reader holds at one target. */
interface Reader {
  readonly userId: string;
  readonly map: ProjectPermissionMap;
  readonly skel: ProjectSkeleton;
  readonly target: CommentTarget;
  readonly atoms: AtomSet;
}

/**
 * Phase 4 DESIGN §3, doc 05 §7.8 / §8.
 *
 * - Invisible target → 404, everywhere: the list, the counts (skipped), the id routes.
 * - Visible but not yours → 403 (edit / delete); resolve also admits `docs:edit`.
 * - Share-link subjects never get here (R21: not in `SHARE_LINK_ROUTES`), and
 *   `requireUser` keeps that true if a guard moves.
 * - Notifications are decided per recipient at send time (L17): only users who can see
 *   the target, from ONE inverse resolve (`resolveResource`, §7.7 item 4).
 */
@Injectable()
export class CommentsService {
  /** Feeds the gateway's `comments:changed`; it re-checks visibility per socket. */
  readonly changed = new Channel<CommentTarget>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    targetType: CommentTargetType,
    targetId: string,
  ): Promise<{ comments: CommentView[] }> {
    const reader = await this.reader(subject, projectId, map, targetType, targetId);
    const rows = await this.prisma.comment.findMany({
      where: { projectId, targetType, targetId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { comments: await this.render(rows, reader) };
  }

  /** L8 — `{ [entityId]: openThreads }`, counted over targets the caller can see only. */
  async counts(
    projectId: string,
    map: ProjectPermissionMap,
  ): Promise<{ counts: Record<string, number> }> {
    const skel = await this.resolver.skeleton(projectId);
    const roots = await this.prisma.comment.findMany({
      where: { projectId, parentId: null, resolvedAt: null },
      select: { targetType: true, targetId: true },
    });
    const fieldIds = roots.filter((r) => r.targetType === 'field').map((r) => r.targetId);
    const fields =
      fieldIds.length === 0
        ? []
        : await this.prisma.field.findMany({
            where: { projectId, id: { in: fieldIds } },
            select: { id: true, entityId: true, isRestricted: true },
          });
    const fieldById = new Map(fields.map((f) => [f.id, f]));

    const counts: Record<string, number> = {};
    for (const root of roots) {
      const field = root.targetType === 'field' ? fieldById.get(root.targetId) : undefined;
      if (root.targetType === 'field' && field === undefined) continue;
      if (root.targetType !== 'field' && root.targetType !== 'entity') continue;
      const entityId = field?.entityId ?? root.targetId;
      if (!skel.entityById.has(entityId)) continue;
      const atoms = this.resolver.atomsAt(map, skel, { type: 'entity', id: entityId });
      if (!seesTarget(atoms, { restricted: field?.isRestricted ?? false })) continue;
      counts[entityId] = (counts[entityId] ?? 0) + 1;
    }
    return { counts };
  }

  async create(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    body: { targetType: CommentTargetType; targetId: string; parentId?: string; content: unknown },
  ): Promise<CommentView> {
    const reader = await this.reader(subject, projectId, map, body.targetType, body.targetId);
    if (!reader.atoms.has('comment:create')) throw forbidden();
    const text = assertNotEmpty(body.content);

    const id: string = randomUUID();
    let rootId = id;
    if (body.parentId !== undefined) {
      const parent = await this.prisma.comment.findFirst({
        where: {
          id: body.parentId,
          projectId,
          targetType: body.targetType,
          targetId: body.targetId,
        },
        select: { rootId: true },
      });
      if (parent === null) throw notFound('comment', body.parentId);
      rootId = parent.rootId;
    }

    const mentioned = mentionedUserIds(body.content);
    const row = await this.prisma.comment.create({
      data: {
        id,
        projectId,
        targetType: body.targetType,
        targetId: body.targetId,
        parentId: body.parentId ?? null,
        rootId,
        authorId: reader.userId,
        content: body.content as Prisma.InputJsonValue,
        plainText: text,
        mentionedIds: mentioned,
        resolvedAt: null,
      },
    });
    this.changed.next(reader.target);
    await this.notify(row, reader, mentioned, body.parentId !== undefined);
    const [view] = await this.render([row], reader);
    if (view === undefined) throw notFound('comment', id);
    return view;
  }

  async update(subject: Subject, id: string, content: unknown): Promise<CommentView> {
    const { row, reader } = await this.own(subject, id);
    const text = assertNotEmpty(content);
    const mentioned = mentionedUserIds(content);
    const updated = await this.prisma.comment.update({
      where: { id },
      data: {
        content: content as Prisma.InputJsonValue,
        plainText: text,
        mentionedIds: mentioned,
        version: { increment: 1 },
      },
    });
    this.changed.next(reader.target);
    // Only the people this edit newly mentions; the others heard the first time.
    const added = mentioned.filter((m) => !row.mentionedIds.includes(m));
    await this.notify(updated, reader, added, false);
    const [view] = await this.render([updated], reader);
    if (view === undefined) throw notFound('comment', id);
    return view;
  }

  /** Q2 — a comment with replies becomes a tombstone; a leaf is hard-deleted. */
  async remove(subject: Subject, id: string): Promise<void> {
    const { row, reader } = await this.own(subject, id);
    const replies = await this.prisma.comment.count({ where: { parentId: id } });
    if (replies > 0) {
      await this.prisma.comment.update({
        where: { id },
        data: { content: TOMBSTONE, plainText: null, mentionedIds: [], version: { increment: 1 } },
      });
    } else {
      await this.prisma.comment.deleteMany({ where: { id } });
      await this.pruneTombstones(row.parentId);
    }
    this.changed.next(reader.target);
  }

  /** Own thread (with `comment:create`), or `docs:edit` at the target (doc 05 §7.8). */
  async setResolved(subject: Subject, id: string, resolved: boolean): Promise<void> {
    const { row, reader } = await this.visible(subject, id);
    const root =
      row.id === row.rootId
        ? row
        : await this.prisma.comment.findFirst({ where: { id: row.rootId } });
    if (root === null) throw notFound('comment', id);
    if (!canResolve(root, reader)) throw forbidden();
    await this.prisma.comment.update({
      where: { id: root.id },
      data: resolved
        ? { resolvedAt: new Date(), resolvedById: reader.userId }
        : { resolvedAt: null, resolvedById: null },
    });
    this.changed.next(reader.target);
  }

  /** §7.7 item 4 — users who can SEE the target, the same rule for members and guests. */
  async mentionCandidates(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    targetType: CommentTargetType,
    targetId: string,
  ): Promise<{ users: MentionCandidate[] }> {
    const reader = await this.reader(subject, projectId, map, targetType, targetId);
    const viewers = await this.viewerIds(reader.target);
    viewers.delete(reader.userId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...viewers] } },
      select: { id: true, name: true, avatarUrl: true },
      orderBy: { name: 'asc' },
    });
    // Name and avatar only — never the email (doc 05 §7.7).
    return { users: users.map((u) => ({ id: u.id, name: u.name, avatarUrl: u.avatarUrl })) };
  }

  /** User ids that can see `target` right now. */
  async viewerIds(target: CommentTarget): Promise<Set<string>> {
    const byPrincipal = await this.resolver.resolveResource(target.projectId, {
      type: 'entity',
      id: target.entityId,
    });
    const out = new Set<string>();
    for (const [key, atoms] of byPrincipal) {
      const p = splitPrincipalKey(key);
      if (p.kind === 'user' && seesTarget(atoms, target)) out.add(p.id);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------

  /** The caller's view of one target, or 404 — invisible and missing are the same answer. */
  private async reader(
    subject: Subject,
    projectId: string,
    map: ProjectPermissionMap,
    targetType: CommentTargetType,
    targetId: string,
  ): Promise<Reader> {
    const userId = requireUser(subject).userId;
    const target = await this.loadTarget(projectId, targetType, targetId);
    if (target === null) throw notFound(targetType, targetId);
    const skel = await this.resolver.skeleton(projectId);
    if (!skel.entityById.has(target.entityId)) throw notFound(targetType, targetId);
    const atoms = this.resolver.atomsAt(map, skel, { type: 'entity', id: target.entityId });
    if (!seesTarget(atoms, target)) throw notFound(targetType, targetId);
    return { userId, map, skel, target, atoms };
  }

  /** An id-addressed comment: the project comes from the row. */
  private async visible(subject: Subject, id: string): Promise<{ row: Comment; reader: Reader }> {
    const user = requireUser(subject);
    const row = await this.prisma.comment.findFirst({ where: { id } });
    if (row === null || (row.targetType !== 'entity' && row.targetType !== 'field')) {
      throw notFound('comment', id);
    }
    const map = await this.resolver.resolveProject(user, row.projectId);
    if (!this.resolver.canOpenProject(map)) throw notFound('comment', id);
    const reader = await this.reader(user, row.projectId, map, row.targetType, row.targetId).catch(
      (error: unknown) => {
        throw error instanceof NotFoundException ? notFound('comment', id) : error;
      },
    );
    return { row, reader };
  }

  /** Visible (else 404), not a tombstone (404), yours with `comment:create` (else 403). */
  private async own(subject: Subject, id: string): Promise<{ row: Comment; reader: Reader }> {
    const found = await this.visible(subject, id);
    if (isTombstone(found.row.content)) throw notFound('comment', id);
    if (found.row.authorId !== found.reader.userId || !found.reader.atoms.has('comment:create')) {
      throw forbidden();
    }
    return found;
  }

  private async loadTarget(
    projectId: string,
    targetType: CommentTargetType,
    targetId: string,
  ): Promise<CommentTarget | null> {
    if (targetType === 'entity') {
      const entity = await this.prisma.entity.findFirst({
        where: { id: targetId, projectId },
        select: { id: true },
      });
      return entity && { projectId, targetType, targetId, entityId: entity.id, restricted: false };
    }
    const field = await this.prisma.field.findFirst({
      where: { id: targetId, projectId },
      select: { entityId: true, isRestricted: true },
    });
    return (
      field && {
        projectId,
        targetType,
        targetId,
        entityId: field.entityId,
        restricted: field.isRestricted,
      }
    );
  }

  /** A tombstone whose last reply just went has nothing left to hold up. */
  private async pruneTombstones(parentId: string | null): Promise<void> {
    let next = parentId;
    while (next !== null) {
      const parent = await this.prisma.comment.findFirst({ where: { id: next } });
      if (parent === null || !isTombstone(parent.content)) return;
      if ((await this.prisma.comment.count({ where: { parentId: parent.id } })) > 0) return;
      await this.prisma.comment.deleteMany({ where: { id: parent.id } });
      next = parent.parentId;
    }
  }

  /**
   * L17 — `comment.mentioned` to mentioned viewers, `comment.replied` to earlier thread
   * participants who are viewers and were not just mentioned. Never the author.
   */
  private async notify(
    row: Comment,
    reader: Reader,
    mentioned: readonly string[],
    isReply: boolean,
  ): Promise<void> {
    if (mentioned.length === 0 && !isReply) return;
    const viewers = await this.viewerIds(reader.target);
    const eligible = (id: string): boolean => id !== reader.userId && viewers.has(id);
    const mentionTo = mentioned.filter(eligible);
    let replyTo: string[] = [];
    if (isReply) {
      const thread = await this.prisma.comment.findMany({
        where: { rootId: row.rootId },
        select: { authorId: true },
      });
      const authors = new Set(thread.flatMap((c) => (c.authorId === null ? [] : [c.authorId])));
      replyTo = [...authors].filter((id) => eligible(id) && !mentionTo.includes(id));
    }
    if (mentionTo.length === 0 && replyTo.length === 0) return;

    const [actor, project, url] = await Promise.all([
      this.prisma.user.findFirst({ where: { id: reader.userId }, select: { name: true } }),
      this.prisma.project.findFirst({
        where: { id: row.projectId },
        select: { organizationId: true },
      }),
      this.notifications.projectUrl(row.projectId, {
        entity: reader.target.entityId,
        comment: row.rootId,
      }),
    ]);
    if (project === null) return;
    const name = actor?.name ?? 'Someone';
    const data = {
      commentId: row.id,
      rootId: row.rootId,
      targetType: reader.target.targetType,
      targetId: reader.target.targetId,
      entityId: reader.target.entityId,
    };
    const base = {
      actorUserId: reader.userId,
      organizationId: project.organizationId,
      projectId: row.projectId,
      url,
      data,
    };
    const items: NotificationInput[] = [
      ...mentionTo.map((userId) => ({
        ...base,
        userId,
        type: 'comment.mentioned' as const,
        title: `${name} mentioned you in a comment`,
      })),
      ...replyTo.map((userId) => ({
        ...base,
        userId,
        type: 'comment.replied' as const,
        title: `${name} replied in a thread you are part of`,
      })),
    ];
    await this.notifications.send(items);
  }

  /** Per reader: body through `redactRichText`, authors through the guest rule (§8). */
  private async render(rows: readonly Comment[], reader: Reader): Promise<CommentView[]> {
    const mentionIds = rows.flatMap((r) => r.mentionedIds);
    const people = [
      ...new Set([
        ...rows.flatMap((r) => (r.authorId === null ? [] : [r.authorId])),
        ...mentionIds,
      ]),
    ];
    const users =
      people.length === 0
        ? []
        : await this.prisma.user.findMany({
            where: { id: { in: people } },
            select: { id: true, name: true, avatarUrl: true },
          });
    const byId = new Map(users.map((u) => [u.id, u]));
    // A guest sees a person only when that person can see this target too (§7.7, L10).
    const known = reader.map.orgRole === 'guest' ? await this.viewerIds(reader.target) : null;
    const shows = (userId: string): boolean =>
      userId === reader.userId || known === null || known.has(userId);

    const rules = {
      visibleEntityIds: this.resolver.visibleEntityIds(reader.map, reader.skel),
      mode: reader.map.restrictedFieldMode,
      userLabel: (userId: string, stored: string) =>
        shows(userId) ? (byId.get(userId)?.name ?? stored) : TEAM_MEMBER,
    };

    return rows.map((row) => {
      const deleted = isTombstone(row.content);
      const person = row.authorId === null ? undefined : byId.get(row.authorId);
      const author: CommentAuthor | null =
        deleted || person === undefined
          ? null
          : shows(person.id)
            ? { id: person.id, name: person.name, avatarUrl: person.avatarUrl }
            : { id: null, name: TEAM_MEMBER, avatarUrl: null };
      const mine = row.authorId === reader.userId;
      return {
        id: row.id,
        rootId: row.rootId,
        parentId: row.parentId,
        author,
        content: deleted ? { type: 'doc', content: [] } : redactRichText(row.content, rules),
        deleted,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        canEdit: !deleted && mine && reader.atoms.has('comment:create'),
        canResolve: row.id === row.rootId && canResolve(row, reader),
      };
    });
  }
}

function canResolve(root: Pick<Comment, 'authorId'>, reader: Reader): boolean {
  if (reader.atoms.has('docs:edit')) return true;
  return root.authorId === reader.userId && reader.atoms.has('comment:create');
}

function requireUser(subject: Subject): UserSubject {
  if (subject.kind !== 'user') throw new NotFoundException({ code: 'not_found' });
  return subject;
}

const forbidden = (): ForbiddenException =>
  new ForbiddenException({ code: 'forbidden', resourceType: 'comment' });

/** An empty body (no text, no mention) is a 400, not a blank row. */
function assertNotEmpty(content: unknown): string {
  const text = plainTextOf(content);
  if (text.length === 0 && mentionedUserIds(content).length === 0) {
    throw new BadRequestException({ code: 'comment_empty' });
  }
  return text;
}
