import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionResolver, ProjectPermissionMap, ProjectSkeleton, Subject } from '../access';
import type { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications';
import { fakePrisma, type FakePrisma } from '../schema/fake-prisma';
import { PROJECT, baseStore, entityRow, fieldRow, projectRow } from '../schema/fixture';
import { TOMBSTONE, mentionedUserIds, plainTextOf, redactRichText } from './comment-rules';
import { CommentsService, TEAM_MEMBER } from './comments.service';

/**
 * `ent_open` everyone sees; `ent_secret` only Ana and Olivia. `fld_sal` is a restricted
 * column of `ent_open`: only holders of `field:viewRestricted` there (Ana) see its thread.
 * Gus is a GUEST who sees `ent_open` without `comment:create`'s sibling `docs:edit`.
 */
type Atoms = Record<string, string[]>;
interface Person {
  orgRole: 'owner' | 'member' | 'guest';
  atoms: Atoms;
}

const FULL = ['schema:view', 'comment:create', 'docs:edit', 'field:viewRestricted'];
const COMMENTER = ['schema:view', 'comment:create'];

const PEOPLE: Record<string, Person> = {
  ana: { orgRole: 'member', atoms: { ent_open: FULL, ent_secret: FULL } },
  bob: { orgRole: 'member', atoms: { ent_open: COMMENTER } },
  gus: { orgRole: 'guest', atoms: { ent_open: COMMENTER } },
  vic: { orgRole: 'member', atoms: { ent_open: ['schema:view'] } },
  eve: { orgRole: 'member', atoms: { ent_open: ['schema:view', 'docs:edit'] } },
};

const user = (id: string): Subject => ({ kind: 'user', userId: id, orgId: 'org_1' });

const skel: ProjectSkeleton = {
  generation: 1,
  areaIds: [],
  entities: [
    { id: 'ent_open', areaId: null },
    { id: 'ent_secret', areaId: null },
  ],
  entityById: new Map([
    ['ent_open', { id: 'ent_open', areaId: null }],
    ['ent_secret', { id: 'ent_secret', areaId: null }],
  ]),
  entitiesWithRestrictedFields: new Set(['ent_open']),
};

const mapOf = (id: string): ProjectPermissionMap =>
  ({ subjectKey: id, orgRole: PEOPLE[id]?.orgRole ?? null, restrictedFieldMode: 'mask' }) as unknown as ProjectPermissionMap;

function resolver(): PermissionResolver {
  const atoms = (userId: string, entityId: string) => new Set(PEOPLE[userId]?.atoms[entityId] ?? []);
  return {
    skeleton: vi.fn().mockResolvedValue(skel),
    resolveProject: (s: Subject) => Promise.resolve(mapOf(s.kind === 'user' ? s.userId : 'link')),
    canOpenProject: (m: ProjectPermissionMap) => PEOPLE[m.subjectKey] !== undefined,
    atomsAt: (m: ProjectPermissionMap, _s: unknown, ref: { id: string }) => atoms(m.subjectKey, ref.id),
    visibleEntityIds: (m: ProjectPermissionMap) =>
      new Set(Object.keys(PEOPLE[m.subjectKey]?.atoms ?? {})),
    resolveResource: (_p: string, ref: { id: string }) =>
      Promise.resolve(
        new Map(
          Object.keys(PEOPLE)
            .filter((id) => atoms(id, ref.id).size > 0)
            .map((id) => [`user:${id}`, atoms(id, ref.id)]),
        ),
      ),
  } as unknown as PermissionResolver;
}

const doc = (text: string, ...mentions: string[]) => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text },
        ...mentions.map((id) => ({ type: 'mention', attrs: { id, label: id } })),
      ],
    },
  ],
});

function harness(prefs: Record<string, unknown> = {}): {
  prisma: FakePrisma;
  service: CommentsService;
  mail: { sendNotificationEmail: ReturnType<typeof vi.fn> };
} {
  const prisma = fakePrisma({
    ...baseStore({
      project: [projectRow({ organizationId: 'org_1', organization: { slug: 'acme' } })],
      entity: [entityRow('ent_open'), entityRow('ent_secret')],
      field: [fieldRow('fld_id', 'ent_open'), fieldRow('fld_sal', 'ent_open', { isRestricted: true })],
    }),
    user: Object.keys(PEOPLE).map((id) => ({
      id,
      name: id.toUpperCase(),
      email: `${id}@acme.test`,
      avatarUrl: null,
      notificationPrefs: prefs[id] ?? {},
    })),
  });
  const mail = { sendNotificationEmail: vi.fn().mockResolvedValue(undefined) };
  const notifications = new NotificationsService(prisma.client, mail as unknown as MailService);
  return { prisma, service: new CommentsService(prisma.client, resolver(), notifications), mail };
}

const post = (h: ReturnType<typeof harness>, who: string, body: Record<string, unknown>) =>
  h.service.create(user(who), PROJECT, mapOf(who), {
    targetType: 'entity',
    targetId: 'ent_open',
    content: doc('hello'),
    ...body,
  });

const notificationsOf = (h: ReturnType<typeof harness>) =>
  h.prisma.store.notification?.map((n) => `${String(n.type)}→${String(n.userId)}`) ?? [];

describe('visibility', () => {
  it('an invisible target is a 404, the same as a missing one', async () => {
    const h = harness();
    await post(h, 'ana', { targetId: 'ent_secret' });
    const secret = h.service.list(user('bob'), PROJECT, mapOf('bob'), 'entity', 'ent_secret');
    const missing = h.service.list(user('bob'), PROJECT, mapOf('bob'), 'entity', 'ent_nope');
    await expect(secret).rejects.toBeInstanceOf(NotFoundException);
    await expect(missing).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a restricted column’s thread is hidden without field:viewRestricted', async () => {
    const h = harness();
    await post(h, 'ana', { targetType: 'field', targetId: 'fld_sal' });
    const mine = await h.service.list(user('ana'), PROJECT, mapOf('ana'), 'field', 'fld_sal');
    expect(mine.comments).toHaveLength(1);
    await expect(h.service.list(user('bob'), PROJECT, mapOf('bob'), 'field', 'fld_sal')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // …and so is every id-addressed route on it.
    const [id] = (h.prisma.store.comment ?? []).map((c) => String(c.id));
    await expect(h.service.setResolved(user('bob'), id ?? '', true)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a guest sees "A team member" for an author who cannot see the target, a member sees names', async () => {
    const h = harness();
    await post(h, 'bob', {});
    // Olivia (not in PEOPLE's grants for this target) wrote one too, e.g. before she lost access.
    (h.prisma.store.user ?? []).push({ id: 'oli', name: 'OLI', email: 'o@x', avatarUrl: null, notificationPrefs: {} });
    const olis = { ...(h.prisma.store.comment?.[0] ?? {}), id: 'c_oli', rootId: 'c_oli', authorId: 'oli', createdAt: new Date(Date.now() + 1000) };
    h.prisma.store.comment?.push(olis);

    const guest = await h.service.list(user('gus'), PROJECT, mapOf('gus'), 'entity', 'ent_open');
    expect(guest.comments.map((c) => c.author?.name)).toEqual(['BOB', TEAM_MEMBER]);
    expect(guest.comments[1]?.author?.id).toBeNull();
    const member = await h.service.list(user('vic'), PROJECT, mapOf('vic'), 'entity', 'ent_open');
    expect(member.comments.map((c) => c.author?.name)).toEqual(['BOB', 'OLI']);
  });

  it('counts open threads per table over visible targets only (L8)', async () => {
    const h = harness();
    await post(h, 'ana', {});
    await post(h, 'ana', { targetType: 'field', targetId: 'fld_sal' });
    await post(h, 'ana', { targetId: 'ent_secret' });
    const reply = await post(h, 'ana', {});
    await post(h, 'bob', { parentId: reply.id }); // a reply is not a thread
    await h.service.setResolved(user('ana'), reply.id, true); // a resolved thread is not open

    expect((await h.service.counts(PROJECT, mapOf('ana'))).counts).toEqual({ ent_open: 2, ent_secret: 1 });
    expect((await h.service.counts(PROJECT, mapOf('bob'))).counts).toEqual({ ent_open: 1 });
  });
});

describe('authority (doc 05 §7.8)', () => {
  it('needs comment:create at the target to post', async () => {
    const h = harness();
    await expect(post(h, 'vic', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('edit and delete are own-only: 403 when visible, 404 when not', async () => {
    const h = harness();
    const c = await post(h, 'bob', {});
    await expect(h.service.update(user('ana'), c.id, doc('mine now'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.remove(user('ana'), c.id)).rejects.toBeInstanceOf(ForbiddenException);
    const secret = await post(h, 'ana', { targetId: 'ent_secret' });
    await expect(h.service.update(user('bob'), secret.id, doc('x'))).rejects.toBeInstanceOf(NotFoundException);

    const edited = await h.service.update(user('bob'), c.id, doc('fixed'));
    expect(edited.canEdit).toBe(true);
    expect(h.prisma.store.comment?.find((r) => r.id === c.id)?.plainText).toBe('fixed');
  });

  it('resolve: own thread, or docs:edit at the target; reopen likewise', async () => {
    const h = harness();
    const c = await post(h, 'bob', {});
    await expect(h.service.setResolved(user('gus'), c.id, true)).rejects.toBeInstanceOf(ForbiddenException);
    await h.service.setResolved(user('eve'), c.id, true);
    expect(h.prisma.store.comment?.[0]?.resolvedAt).toBeInstanceOf(Date);
    await h.service.setResolved(user('bob'), c.id, false);
    expect(h.prisma.store.comment?.[0]?.resolvedAt).toBeNull();
  });
});

describe('delete (Q2)', () => {
  it('tombstones a comment with replies and hard-deletes a leaf, then the orphaned tombstone', async () => {
    const h = harness();
    const root = await post(h, 'bob', {});
    const reply = await post(h, 'ana', { parentId: root.id });

    await h.service.remove(user('bob'), root.id);
    expect(h.prisma.store.comment?.find((r) => r.id === root.id)?.content).toEqual(TOMBSTONE);
    const listed = await h.service.list(user('ana'), PROJECT, mapOf('ana'), 'entity', 'ent_open');
    expect(listed.comments[0]).toMatchObject({ deleted: true, author: null, canEdit: false });
    await expect(h.service.update(user('bob'), root.id, doc('back'))).rejects.toBeInstanceOf(NotFoundException);

    await h.service.remove(user('ana'), reply.id);
    expect(h.prisma.store.comment).toEqual([]);
  });
});

describe('mention candidates (doc 05 §7.7 item 4)', () => {
  it('are the users who can see the target, minus the caller', async () => {
    const h = harness();
    const open = await h.service.mentionCandidates(user('ana'), PROJECT, mapOf('ana'), 'entity', 'ent_open');
    expect(open.users.map((u) => u.id).sort()).toEqual(['bob', 'eve', 'gus', 'vic']);
    const sal = await h.service.mentionCandidates(user('ana'), PROJECT, mapOf('ana'), 'field', 'fld_sal');
    expect(sal.users).toEqual([]);
    expect(Object.keys(open.users[0] ?? {}).sort()).toEqual(['avatarUrl', 'id', 'name']);
  });
});

describe('notification fan-out (L17)', () => {
  it('notifies mentioned viewers only — no row, no email for someone who cannot see the target', async () => {
    const h = harness();
    await post(h, 'ana', { targetId: 'ent_secret', content: doc('see ', 'bob') });
    await post(h, 'ana', { content: doc('see ', 'bob', 'ana') });
    expect(notificationsOf(h)).toEqual(['comment.mentioned→bob']);
    expect(h.mail.sendNotificationEmail).toHaveBeenCalledTimes(1);
    const [row] = h.prisma.store.notification ?? [];
    expect(row?.url).toBe(`/acme/p/${PROJECT}?entity=ent_open&comment=${String(h.prisma.store.comment?.[1]?.id)}`);
    expect(String(row?.title)).toBe('ANA mentioned you in a comment');
  });

  it('a reply notifies earlier participants, not the author, and not twice when also mentioned', async () => {
    const h = harness();
    const root = await post(h, 'bob', {});
    await post(h, 'gus', { parentId: root.id });
    await post(h, 'ana', { parentId: root.id, content: doc('cc ', 'gus') });
    expect(notificationsOf(h)).toEqual([
      'comment.replied→bob', // gus replied
      'comment.mentioned→gus', // ana mentioned gus…
      'comment.replied→bob', // …and bob hears about the reply
    ]);
  });

  it('emails only when the recipient’s pref is on', async () => {
    const h = harness({ bob: { emailMentions: false } });
    await post(h, 'ana', { content: doc('hi ', 'bob', 'gus') });
    expect(notificationsOf(h)).toEqual(['comment.mentioned→bob', 'comment.mentioned→gus']);
    expect(h.mail.sendNotificationEmail.mock.calls.map((c: unknown[]) => c[0] as string)).toEqual(['gus@acme.test']);
  });
});

describe('rich text', () => {
  it('extracts user mentions and plain text; redacts object mentions per reader', () => {
    const body = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'ask ' },
            { type: 'mention', attrs: { id: 'bob', label: 'bob' } },
            { type: 'mention', attrs: { targetType: 'entity', targetId: 'ent_secret', label: 'salaries' } },
          ],
        },
      ],
    };
    expect(mentionedUserIds(body)).toEqual(['bob']);
    expect(plainTextOf(body)).toBe('ask @bob');
    const rules = { visibleEntityIds: new Set(['ent_open']), userLabel: () => TEAM_MEMBER };
    const masked = JSON.stringify(redactRichText(body, { ...rules, mode: 'mask' }));
    expect(masked).not.toContain('salaries');
    expect(masked).toContain('"restricted":true');
    expect(masked).toContain(TEAM_MEMBER);
    expect(JSON.stringify(redactRichText(body, { ...rules, mode: 'hide' }))).toContain('"text":"restricted"');
  });
});
