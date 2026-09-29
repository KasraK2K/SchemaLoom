import 'reflect-metadata';
import { MESSAGE_METADATA } from '@nestjs/websockets/constants';
import {
  RawSchemaModel,
  assembleModel,
  type SchemaModel,
  type VisibilityContext,
} from '@schemaloom/schema-model';
import { Subject as Channel } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessScope, PermissionResolver, VisibilityFilter } from '../access';
import { SHARE_LINK_ROUTES } from '../access/share-link-allowlist';
import type { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { CommentTarget, CommentsService } from '../comments';
import type { NotificationsService } from '../notifications';
import type { AuthPrincipal } from '../auth/subject';
import type { PrismaService } from '../prisma/prisma.service';
import { SchemaCommits, type SchemaLoader, type SchemaOperationResult } from '../schema';
import { fakePrisma } from '../schema/fake-prisma';
import { PROJECT, baseStore, entityRow, fieldRow } from '../schema/fixture';
import { readProjectRows } from '../schema/row-read';
import {
  CLOSE_NOT_AVAILABLE,
  RealtimeGateway,
  SERVER_EVENTS,
  WS_EVENTS,
  type RealtimeSocket,
} from './realtime.gateway';

const ORIGIN = 'http://localhost:3000';

/** `en_open` everyone sees; `en_secret` only Ana. */
async function modelWith(
  over: { secretName?: string; openName?: string } = {},
): Promise<SchemaModel> {
  const store = baseStore({
    entity: [
      entityRow('en_open', { name: over.openName ?? 'orders' }),
      entityRow('en_secret', { name: over.secretName ?? 'salaries' }),
    ],
    field: [
      fieldRow('fd_open', 'en_open', { name: 'id' }),
      fieldRow('fd_secret', 'en_secret', { name: 'amount' }),
    ],
  });
  const rows = await readProjectRows(fakePrisma(store).client, PROJECT);
  return assembleModel({ projectId: PROJECT, engineId: 'postgresql', engineVersion: '16', rows });
}

const context = (visible: string[], over: Partial<VisibilityContext> = {}): VisibilityContext => ({
  projectId: PROJECT,
  subjectKind: 'user',
  subjectKey: 'u:x',
  canOpenProject: true,
  visibleEntityIds: new Set(visible),
  restrictedOkEntityIds: new Set(visible),
  areasWithAtoms: new Set(),
  restrictedFieldMode: 'mask',
  totalEntityCount: 2,
  entitiesWithRestrictedFields: new Set(),
  ...over,
});

const PRINCIPALS: Record<string, AuthPrincipal> = {
  ana: { kind: 'user', userId: 'ana', orgId: 'org' },
  bob: { kind: 'user', userId: 'bob', orgId: 'org' },
  link: { kind: 'share_link', shareLinkId: 'shl', projectId: PROJECT, resourceId: PROJECT },
};

function harness() {
  let model: SchemaModel | null = null;
  const contexts = new Map<string, VisibilityContext>();
  const accessChanged = new Channel<AccessScope>();
  const commits = new SchemaCommits();
  const commentsChanged = new Channel<CommentTarget>();
  const notificationCreated = new Channel<{ userId: string; id: string }>();
  const keyOf = (s: { kind: string; userId?: string; shareLinkId?: string }) =>
    s.kind === 'user' ? `u:${String(s.userId)}` : `sl:${String(s.shareLinkId)}`;

  const gateway = new RealtimeGateway(
    {
      principalFromCookies: (cookie?: string) =>
        Promise.resolve(cookie ? PRINCIPALS[cookie] : undefined),
    } as unknown as JwtAuthGuard,
    {
      computeContext: (subject: { kind: string }, projectId: string) =>
        Promise.resolve(
          projectId === PROJECT
            ? (contexts.get(keyOf(subject)) ?? context([], { canOpenProject: false }))
            : context([], { canOpenProject: false }),
        ),
    } as unknown as VisibilityFilter,
    {
      accessChanged,
      skeleton: () => Promise.resolve({ generation: 4 }),
      // The comments filter reads atoms at the entity; derive them from the same contexts.
      resolveProject: (subject: { kind: string }) =>
        Promise.resolve({ subjectKey: keyOf(subject) }),
      atomsAt: (map: { subjectKey: string }, _skel: unknown, ref: { id: string }) => {
        const ctx = contexts.get(map.subjectKey);
        const atoms = new Set<string>();
        if (ctx?.visibleEntityIds.has(ref.id) === true) atoms.add('schema:view');
        if (ctx?.restrictedOkEntityIds.has(ref.id) === true) atoms.add('field:viewRestricted');
        return atoms;
      },
    } as unknown as PermissionResolver,
    {
      load: () =>
        model === null
          ? Promise.reject(new Error('gone'))
          : Promise.resolve(new RawSchemaModel(model)),
    } as unknown as SchemaLoader,
    commits,
    {
      project: {
        findFirst: (args: { where: { id: string } }) =>
          Promise.resolve(
            args.where.id === PROJECT && model !== null ? { schemaRevision: 9n } : null,
          ),
      },
      user: { findFirst: () => Promise.resolve({ name: 'Ana' }) },
    } as unknown as PrismaService,
    { get: () => [ORIGIN] } as never,
    { changed: commentsChanged } as unknown as CommentsService,
    { created: notificationCreated } as unknown as NotificationsService,
  );
  gateway.onModuleInit();

  const connect = async (
    who: string,
    origin = ORIGIN,
  ): Promise<RealtimeSocket & { emit: ReturnType<typeof vi.fn> }> => {
    const socket = {
      id: `s_${who}`,
      handshake: { headers: { origin, cookie: who } },
      emit: vi.fn(),
      disconnect: vi.fn(),
      data: undefined,
    } as unknown as RealtimeSocket & { emit: ReturnType<typeof vi.fn> };
    await gateway.authenticate(socket);
    gateway.handleConnection(socket);
    return socket;
  };
  const events = (socket: { emit: ReturnType<typeof vi.fn> }, name: string): unknown[] =>
    (socket.emit.mock.calls as unknown[][]).filter((c) => c[0] === name).map((c) => c[1]);

  return {
    gateway,
    contexts,
    accessChanged,
    commits,
    commentsChanged,
    notificationCreated,
    connect,
    events,
    setModel: (m: SchemaModel | null) => {
      model = m;
    },
  };
}

type Harness = ReturnType<typeof harness>;
let h: Harness;

beforeEach(async () => {
  h = harness();
  h.setModel(await modelWith());
  h.contexts.set('u:ana', context(['en_open', 'en_secret']));
  h.contexts.set('u:bob', context(['en_open']));
  h.contexts.set('sl:shl', context(['en_open'], { subjectKind: 'share_link' }));
});

const result = (over: Partial<SchemaOperationResult> = {}): SchemaOperationResult => ({
  batchId: 'b1',
  projectId: PROJECT,
  actorUserId: 'ana',
  seq: 10,
  changed: {},
  removed: [],
  ...over,
});

/** Let the fire-and-forget subscription handlers finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('handshake', () => {
  it('rejects a foreign Origin and a missing cookie', async () => {
    await expect(h.connect('ana', 'https://evil.example')).rejects.toThrow('forbidden_origin');
    await expect(h.connect('')).rejects.toThrow('unauthorized');
  });
});

describe('project:subscribe', () => {
  it('replies with the current seq', async () => {
    const ana = await h.connect('ana');
    await expect(h.gateway.subscribe(ana, { projectId: PROJECT })).resolves.toEqual({
      ok: true,
      seq: 9,
    });
  });

  it('invisible is the same answer as nonexistent', async () => {
    h.contexts.set('u:bob', context([], { canOpenProject: false }));
    const bob = await h.connect('bob');
    const invisible = await h.gateway.subscribe(bob, { projectId: PROJECT });
    const missing = await h.gateway.subscribe(bob, { projectId: 'prj_nope' });
    expect(invisible).toEqual({ ok: false, code: 'not_found' });
    expect(missing).toEqual(invisible);
  });

  it('a share-link session can subscribe only to its own project', async () => {
    const link = await h.connect('link');
    await expect(h.gateway.subscribe(link, { projectId: 'prj_other' })).resolves.toEqual({
      ok: false,
      code: 'not_found',
    });
    await expect(h.gateway.subscribe(link, { projectId: PROJECT })).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe('schema:patch', () => {
  it('redacts per recipient and does not emit a null patch', async () => {
    const ana = await h.connect('ana');
    const bob = await h.connect('bob');
    await h.gateway.subscribe(ana, { projectId: PROJECT });
    await h.gateway.subscribe(bob, { projectId: PROJECT });

    h.setModel(await modelWith({ secretName: 'wages' }));
    h.commits.results.next(result());
    await settle();
    await h.gateway.publish(result()); // drains the chain; a second pass is a no-op diff

    const [frame] = h.events(ana, SERVER_EVENTS.patch) as SchemaOperationResult[];
    expect(frame?.changed.entity?.en_secret?.name).toBe('wages');
    expect(frame?.seq).toBe(10);
    expect(h.events(bob, SERVER_EVENTS.patch)).toEqual([]);
    expect(JSON.stringify(bob.emit.mock.calls)).not.toContain('wages');
  });

  it('share-link visitors get patches', async () => {
    const link = await h.connect('link');
    await h.gateway.subscribe(link, { projectId: PROJECT });
    h.setModel(await modelWith({ openName: 'purchases' }));
    await h.gateway.publish(result());
    const [frame] = h.events(link, SERVER_EVENTS.patch) as SchemaOperationResult[];
    expect(frame?.changed.entity?.en_open?.name).toBe('purchases');
  });
});

describe('access-changed / permissions:changed', () => {
  it('re-resolves, emits access-changed, and drops a socket that lost the project with 4403', async () => {
    const ana = await h.connect('ana');
    const bob = await h.connect('bob');
    await h.gateway.subscribe(ana, { projectId: PROJECT });
    await h.gateway.subscribe(bob, { projectId: PROJECT });

    h.contexts.set('u:bob', context([], { canOpenProject: false }));
    await h.gateway.accessChanged({ project: PROJECT });

    expect(h.events(ana, SERVER_EVENTS.accessChanged)).toEqual([
      { projectId: PROJECT, generation: 4 },
    ]);
    expect(h.events(bob, SERVER_EVENTS.closed)).toEqual([
      { projectId: PROJECT, code: CLOSE_NOT_AVAILABLE },
    ]);
    expect(bob.disconnect).toHaveBeenCalledWith(true);

    // Dropped from the room: the next commit reaches Ana only.
    h.setModel(await modelWith({ openName: 'purchases' }));
    await h.gateway.publish(result());
    expect(h.events(bob, SERVER_EVENTS.patch)).toEqual([]);
    expect(h.events(ana, SERVER_EVENTS.patch)).toHaveLength(1);
  });

  it('is fed by PermissionResolver.accessChanged', async () => {
    const ana = await h.connect('ana');
    await h.gateway.subscribe(ana, { projectId: PROJECT });
    h.accessChanged.next({ project: PROJECT });
    await settle();
    await settle();
    expect(h.events(ana, SERVER_EVENTS.accessChanged)).toHaveLength(1);
  });

  it('a deleted project closes every socket', async () => {
    const ana = await h.connect('ana');
    await h.gateway.subscribe(ana, { projectId: PROJECT });
    h.setModel(null);
    await h.gateway.accessChanged({ project: PROJECT });
    expect(h.events(ana, SERVER_EVENTS.closed)).toHaveLength(1);
  });
});

describe('presence (L16)', () => {
  it('strips entity ids the recipient cannot see, and never reaches share-link visitors', async () => {
    const ana = await h.connect('ana');
    const bob = await h.connect('bob');
    const link = await h.connect('link');
    for (const s of [ana, bob, link]) await h.gateway.subscribe(s, { projectId: PROJECT });

    h.gateway.presence(ana, { selection: ['en_open', 'en_secret'], cursor: { x: 1, y: 2 } });
    expect(h.events(bob, SERVER_EVENTS.presence)).toEqual([
      {
        peerId: 's_ana',
        userId: 'ana',
        name: 'Ana',
        selection: ['en_open'],
        cursor: { x: 1, y: 2 },
        left: false,
      },
    ]);
    expect(h.events(link, SERVER_EVENTS.presence)).toEqual([]);

    // …and a share-link subject cannot send it either.
    h.gateway.presence(link, { selection: ['en_open'] });
    expect(h.events(ana, SERVER_EVENTS.presence)).toEqual([]);
  });
});

describe('comments:changed (Phase 4 §3.1)', () => {
  const target = (over: Partial<CommentTarget> = {}): CommentTarget => ({
    projectId: PROJECT,
    targetType: 'entity',
    targetId: 'en_secret',
    entityId: 'en_secret',
    restricted: false,
    ...over,
  });

  it('reaches only user sockets that can see the target — never a share link', async () => {
    const ana = await h.connect('ana');
    const bob = await h.connect('bob');
    const link = await h.connect('link');
    for (const s of [ana, bob, link]) await h.gateway.subscribe(s, { projectId: PROJECT });

    h.commentsChanged.next(target());
    await settle();
    expect(h.events(ana, SERVER_EVENTS.commentsChanged)).toEqual([
      { targetType: 'entity', targetId: 'en_secret' },
    ]);
    expect(h.events(bob, SERVER_EVENTS.commentsChanged)).toEqual([]);

    await h.gateway.commentsChanged(target({ targetId: 'en_open', entityId: 'en_open' }));
    expect(h.events(bob, SERVER_EVENTS.commentsChanged)).toEqual([
      { targetType: 'entity', targetId: 'en_open' },
    ]);
    expect(h.events(link, SERVER_EVENTS.commentsChanged)).toEqual([]);
  });

  it('a restricted column needs field:viewRestricted', async () => {
    h.contexts.set('u:bob', context(['en_open'], { restrictedOkEntityIds: new Set() }));
    const ana = await h.connect('ana');
    const bob = await h.connect('bob');
    for (const s of [ana, bob]) await h.gateway.subscribe(s, { projectId: PROJECT });
    await h.gateway.commentsChanged(
      target({ targetType: 'field', targetId: 'fd_open', entityId: 'en_open', restricted: true }),
    );
    expect(h.events(ana, SERVER_EVENTS.commentsChanged)).toHaveLength(1);
    expect(h.events(bob, SERVER_EVENTS.commentsChanged)).toEqual([]);
  });
});

describe('notification:new (Phase 4 §4)', () => {
  it('goes to the recipient’s user room only, with no project subscription needed', async () => {
    const ana = await h.connect('ana');
    const bob = await h.connect('bob');
    const link = await h.connect('link');
    h.notificationCreated.next({ userId: 'ana', id: 'ntf_1' });
    expect(h.events(ana, SERVER_EVENTS.notification)).toEqual([{ id: 'ntf_1' }]);
    expect(h.events(bob, SERVER_EVENTS.notification)).toEqual([]);
    expect(h.events(link, SERVER_EVENTS.notification)).toEqual([]);

    h.gateway.handleDisconnect(ana);
    h.gateway.notificationCreated('ana', 'ntf_2');
    expect(h.events(ana, SERVER_EVENTS.notification)).toHaveLength(1);
  });
});

describe('WS route classification (doc 01 §4.1, R21)', () => {
  it('WS_EVENTS lists exactly the @SubscribeMessage handlers', () => {
    const proto = RealtimeGateway.prototype as unknown as Record<string, unknown>;
    const handled = Object.getOwnPropertyNames(proto)
      .map((name) => Reflect.getMetadata(MESSAGE_METADATA, proto[name] as object) as unknown)
      .filter((m): m is string => typeof m === 'string');
    expect(new Set(handled)).toEqual(new Set(WS_EVENTS));
  });

  it('only project:subscribe is share-link reachable, and SHARE_LINK_ROUTES says so', () => {
    const ws = [...SHARE_LINK_ROUTES]
      .filter((r) => r.startsWith('WS'))
      .map((r) => r.split(/\s+/)[1]);
    expect(ws).toEqual(['project:subscribe']);
    expect(ws.every((e) => (WS_EVENTS as readonly string[]).includes(e ?? ''))).toBe(true);
  });
});
