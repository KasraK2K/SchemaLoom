import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
} from '@nestjs/websockets';
import {
  redact,
  redactPatch,
  type RawSchemaModel,
  type RedactedModel,
} from '@schemaloom/schema-model';
import type { Subscription } from 'rxjs';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { PermissionResolver, VisibilityFilter, type AccessScope, type Subject } from '../access';
import { CommentsService, seesTarget, type CommentTarget } from '../comments';
import { NotificationsService } from '../notifications';
import { isShareLinkRoute } from '../access/share-link-allowlist';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { toSubject, type AuthPrincipal } from '../auth/subject';
import type { AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { SchemaCommits, SchemaLoader, type SchemaOperationResult } from '../schema';

/**
 * Doc 01 §4 `RealtimeModule` — the Socket.IO gateway (Phase 4).
 *
 * Client → server events. Each is classified here the way every HTTP route carries a
 * marker (doc 01 §4.1): all of them are project-scoped, and only the ones in
 * `SHARE_LINK_ROUTES` (R21, as `WS <event>`) are reachable by a share-link subject. The
 * spec asserts this table matches the `@SubscribeMessage` handlers, so it cannot drift.
 */
export const WS_EVENTS = ['project:subscribe', 'presence:update'] as const;
export type WsEvent = (typeof WS_EVENTS)[number];

/** Server → client. */
export const SERVER_EVENTS = {
  patch: 'schema:patch',
  accessChanged: 'access-changed',
  presence: 'presence:update',
  /** Doc 05 §12.2: sent right before the socket is dropped; the client shows "not available". */
  closed: 'project:closed',
  /** `{ targetType, targetId }`, only to user sockets that can see the target; refetch it. */
  commentsChanged: 'comments:changed',
  /** `{ id }` to the recipient's `user:<id>` room. Never to share-link sockets. */
  notification: 'notification:new',
} as const;

/** §12.2 — the recipient's recomputed context can no longer open the project. */
export const CLOSE_NOT_AVAILABLE = 4403;

/** Invisible and nonexistent are the same answer (doc 05 §10.3 step 8). */
const NOT_FOUND = { ok: false, code: 'not_found' } as const;

const SubscribeSchema = z.object({ projectId: z.string().min(1).max(64) });
const PresenceSchema = z.object({
  selection: z.array(z.string().min(1).max(64)).max(200),
  cursor: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
});

type Cursor = { x: number; y: number } | null;

interface SocketState {
  readonly principal: AuthPrincipal;
  readonly subject: Subject | null;
  readonly userId: string | null;
  readonly name: string | null;
  projectId: string | null;
  /** What this recipient currently holds — the `before` of the next transition. */
  view: RedactedModel | null;
  selection: string[];
  cursor: Cursor;
}

export type RealtimeSocket = Pick<Socket, 'id' | 'emit' | 'disconnect' | 'handshake'> & {
  data: SocketState;
};

/**
 * Per-socket redaction at emit time (doc 05 L15): one frame per recipient, derived from
 * THAT recipient's freshly computed context. The context is recomputed on every commit
 * rather than cached and dropped on `permissions:changed` — two Redis hits per socket per
 * write, and there is no stale-context window to reason about at all.
 *
 * ponytail: single node. Rooms are an in-process map and frames never cross processes.
 * The Redis adapter alone does not fit: redaction needs each socket's `view`, which lives
 * on the node holding the socket. Upgrade: publish the raw commit over Redis pub/sub
 * (`REDIS_QUEUE`) and let each node run `publish` for its own sockets.
 */
@WebSocketGateway({ transports: ['websocket'] })
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly rooms = new Map<string, Set<RealtimeSocket>>();
  /** `user:<id>` → that user's sockets, joined on connect (Phase 4 §4 `notification:new`). */
  private readonly userRooms = new Map<string, Set<RealtimeSocket>>();
  /** Per-project serialisation: two commits must not interleave their `view` updates. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly subscriptions: Subscription[] = [];

  constructor(
    private readonly auth: JwtAuthGuard,
    private readonly filter: VisibilityFilter,
    private readonly resolver: PermissionResolver,
    private readonly loader: SchemaLoader,
    private readonly commits: SchemaCommits,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly comments: CommentsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.subscriptions.push(
      // Failures are logged inside `serial`; a dropped frame is healed by the seq gap.
      this.commits.results.subscribe((result) => void this.publish(result).catch(() => undefined)),
      this.resolver.accessChanged.subscribe(
        (scope) => void this.accessChanged(scope).catch(() => undefined),
      ),
      this.comments.changed.subscribe(
        (target) => void this.commentsChanged(target).catch(() => undefined),
      ),
      this.notifications.created.subscribe((n) => {
        this.notificationCreated(n.userId, n.id);
      }),
    );
  }

  onModuleDestroy(): void {
    for (const s of this.subscriptions) s.unsubscribe();
  }

  /** The handshake: Origin (the upgrade has no CSRF token), then the same cookies as HTTP. */
  afterInit(server: Server): void {
    server.use((socket, next) => {
      this.authenticate(socket as unknown as RealtimeSocket).then(
        () => {
          next();
        },
        (error: unknown) => {
          next(error instanceof Error ? error : new Error('unauthorized'));
        },
      );
    });
  }

  async authenticate(socket: RealtimeSocket): Promise<void> {
    const origin = socket.handshake.headers.origin;
    const allowed = this.config.get('CORS_ORIGINS', { infer: true });
    if (origin === undefined || !allowed.includes(origin)) throw new Error('forbidden_origin');

    const principal = await this.auth.principalFromCookies(socket.handshake.headers.cookie);
    if (principal === undefined) throw new Error('unauthorized');
    const userId = principal.kind === 'user' ? principal.userId : null;
    const user =
      userId === null
        ? null
        : await this.prisma.user.findFirst({ where: { id: userId }, select: { name: true } });
    socket.data = {
      principal,
      subject: toSubject(principal),
      userId,
      name: user?.name ?? null,
      projectId: null,
      view: null,
      selection: [],
      cursor: null,
    };
  }

  /** Share-link sockets have no user room: they get no notifications (R21). */
  handleConnection(socket: RealtimeSocket): void {
    const userId = socket.data.principal.kind === 'user' ? socket.data.userId : null;
    if (userId === null) return;
    const key = `user:${userId}`;
    const room = this.userRooms.get(key) ?? new Set<RealtimeSocket>();
    room.add(socket);
    this.userRooms.set(key, room);
  }

  handleDisconnect(socket: RealtimeSocket): void {
    this.leave(socket);
    const key = `user:${socket.data.userId ?? ''}`;
    const room = this.userRooms.get(key);
    room?.delete(socket);
    if (room?.size === 0) this.userRooms.delete(key);
  }

  // ===================================================================================
  // Client → server
  // ===================================================================================

  @SubscribeMessage('project:subscribe')
  async subscribe(
    @ConnectedSocket() socket: RealtimeSocket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true; seq: number } | typeof NOT_FOUND> {
    const state = socket.data;
    const parsed = SubscribeSchema.safeParse(body);
    if (!parsed.success || !this.reachable(state, 'project:subscribe')) return NOT_FOUND;
    const { projectId } = parsed.data;
    const subject = state.subject;
    if (subject === null) return NOT_FOUND;
    // §7.12 step 4 — a share-link session can never address a second project.
    if (subject.kind === 'share_link' && subject.projectId !== projectId) return NOT_FOUND;

    return this.serial(projectId, async () => {
      const ctx = await this.filter.computeContext(subject, projectId);
      if (!ctx.canOpenProject) return NOT_FOUND;
      const raw = await this.load(projectId);
      const project = await this.prisma.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { schemaRevision: true },
      });
      if (raw === null || project === null) return NOT_FOUND;

      this.leave(socket);
      state.projectId = projectId;
      state.view = redact(raw, ctx);
      const room = this.rooms.get(projectId) ?? new Set<RealtimeSocket>();
      room.add(socket);
      this.rooms.set(projectId, room);
      // The newcomer sees who is already here; the others hear from it on its first update.
      for (const peer of room) {
        const active = peer.data.selection.length > 0 || peer.data.cursor !== null;
        if (peer !== socket && active) this.sendPresence(peer, socket);
      }
      return { ok: true as const, seq: Number(project.schemaRevision) };
    });
  }

  @SubscribeMessage('presence:update')
  presence(@ConnectedSocket() socket: RealtimeSocket, @MessageBody() body: unknown): void {
    const state = socket.data;
    // L16 + R21: share-link subjects neither send nor receive presence.
    if (!this.reachable(state, 'presence:update') || state.projectId === null) return;
    const parsed = PresenceSchema.safeParse(body);
    if (!parsed.success) return;
    state.selection = parsed.data.selection;
    state.cursor = parsed.data.cursor;
    for (const peer of this.rooms.get(state.projectId) ?? []) {
      if (peer !== socket) this.sendPresence(socket, peer);
    }
  }

  // ===================================================================================
  // Server → client
  // ===================================================================================

  /** Doc 04 §8.7 — one committed batch, one transition frame per recipient. */
  publish(result: SchemaOperationResult): Promise<unknown> {
    const { projectId } = result;
    return this.serial(projectId, async () => {
      const room = this.rooms.get(projectId);
      if (room === undefined || room.size === 0) return;
      const raw = await this.load(projectId);
      for (const socket of [...room]) {
        const step = await this.refresh(socket, raw);
        if (step === null) continue;
        const frame = redactPatch(result, step.before, step.after);
        if (frame !== null) socket.emit(SERVER_EVENTS.patch, frame);
      }
    });
  }

  /** Doc 05 §9.3 / §12.2 — a grant, role, membership or link changed and committed. */
  async accessChanged(scope: AccessScope): Promise<void> {
    const projectIds =
      scope.project !== undefined
        ? [scope.project]
        : // ponytail: an org or user bump re-checks every open room (user bumps filter by
          // socket below). Index rooms by org if many orgs share one node.
          [...this.rooms.keys()];
    await Promise.all(
      projectIds.map((projectId) =>
        this.serial(projectId, async () => {
          const sockets = [...(this.rooms.get(projectId) ?? [])].filter(
            (s) =>
              scope.user === undefined ||
              scope.project !== undefined ||
              s.data.userId === scope.user,
          );
          if (sockets.length === 0) return;
          const raw = await this.load(projectId);
          const generation =
            raw === null ? 0 : (await this.resolver.skeleton(projectId)).generation;
          for (const socket of sockets) {
            if ((await this.refresh(socket, raw)) === null) continue;
            socket.emit(SERVER_EVENTS.accessChanged, { projectId, generation });
          }
        }),
      ),
    );
  }

  /**
   * Phase 4 §3.1 — a comment on `target` changed. Each subscribed user socket gets the
   * bare `{ targetType, targetId }` only if ITS subject can see the target right now, so
   * a restricted column's thread never pings a reader without `field:viewRestricted`.
   */
  async commentsChanged(target: CommentTarget): Promise<void> {
    const sockets = [...(this.rooms.get(target.projectId) ?? [])];
    if (sockets.length === 0) return;
    const skel = await this.resolver.skeleton(target.projectId);
    const ref = { type: 'entity' as const, id: target.entityId };
    for (const socket of sockets) {
      const { subject } = socket.data;
      if (subject?.kind !== 'user') continue;
      const map = await this.resolver.resolveProject(subject, target.projectId);
      if (!seesTarget(this.resolver.atomsAt(map, skel, ref), target)) continue;
      socket.emit(SERVER_EVENTS.commentsChanged, {
        targetType: target.targetType,
        targetId: target.targetId,
      });
    }
  }

  notificationCreated(userId: string, id: string): void {
    for (const socket of this.userRooms.get(`user:${userId}`) ?? []) {
      socket.emit(SERVER_EVENTS.notification, { id });
    }
  }

  // ===================================================================================

  /**
   * Recompute the recipient's context. When it can no longer open the project, the
   * socket is told and dropped (`4403`, §12.2); otherwise its `view` advances.
   */
  private async refresh(
    socket: RealtimeSocket,
    raw: RawSchemaModel | null,
  ): Promise<{ before: RedactedModel; after: RedactedModel } | null> {
    const { subject, projectId, view } = socket.data;
    if (subject === null || projectId === null || view === null) return null;
    const ctx = await this.filter.computeContext(subject, projectId);
    if (raw === null || !ctx.canOpenProject) {
      this.close(socket, projectId);
      return null;
    }
    const after = redact(raw, ctx);
    socket.data.view = after;
    return { before: view, after };
  }

  private close(socket: RealtimeSocket, projectId: string): void {
    this.leave(socket);
    socket.emit(SERVER_EVENTS.closed, { projectId, code: CLOSE_NOT_AVAILABLE });
    socket.disconnect(true);
  }

  private leave(socket: RealtimeSocket): void {
    const { projectId } = socket.data;
    if (projectId === null) return;
    const room = this.rooms.get(projectId);
    room?.delete(socket);
    if (room?.size === 0) this.rooms.delete(projectId);
    socket.data.projectId = null;
    socket.data.view = null;
    const gone = { id: socket.id, data: { ...socket.data, selection: [], cursor: null } };
    for (const peer of room ?? []) this.sendPresence(gone, peer, true);
  }

  /** L16 — the sender's selection, minus every entity this recipient cannot hold. */
  private sendPresence(
    from: Pick<RealtimeSocket, 'id' | 'data'>,
    to: RealtimeSocket,
    left = false,
  ): void {
    if (from.data.principal.kind !== 'user' || to.data.principal.kind !== 'user') return;
    const view = to.data.view;
    if (view === null) return;
    to.emit(SERVER_EVENTS.presence, {
      peerId: from.id,
      userId: from.data.userId,
      name: from.data.name,
      selection: from.data.selection.filter((id) => view.objects.entity[id] !== undefined),
      cursor: from.data.cursor,
      left,
    });
  }

  /** R21 — a share-link subject reaches only the allow-listed events; 404 otherwise. */
  private reachable(state: SocketState | undefined, event: WsEvent): boolean {
    if (state === undefined) return false;
    return state.principal.kind !== 'share_link' || isShareLinkRoute('WS', event);
  }

  /** Null when the project is gone (soft-deleted): every recipient then gets 4403. */
  private async load(projectId: string): Promise<RawSchemaModel | null> {
    try {
      return await this.loader.load(projectId);
    } catch (error) {
      this.logger.debug(`realtime load ${projectId}: ${String(error)}`);
      return null;
    }
  }

  private serial<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch((error: unknown) => {
      this.logger.error(`realtime ${projectId}: ${String(error)}`);
    });
    this.chains.set(projectId, tail);
    void tail.then(() => {
      if (this.chains.get(projectId) === tail) this.chains.delete(projectId);
    });
    return next;
  }
}
