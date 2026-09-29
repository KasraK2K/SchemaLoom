import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  notificationPrefsStoredSchema,
  type NotificationPrefs,
  type NotificationPrefsPatch,
  type NotificationType,
} from '@schemaloom/contracts';
import { Subject as Channel } from 'rxjs';
import type { Prisma } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

type Db = Prisma.TransactionClient;

/**
 * One row to write. `title` is templated from ids and the actor's name only (doc 05 L7):
 * it is stored, so it must never carry a schema name the recipient might later lose.
 */
export interface NotificationInput {
  readonly userId: string;
  readonly actorUserId: string | null;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly type: NotificationType;
  readonly title: string;
  readonly body?: string | null;
  readonly url?: string | null;
  readonly data: Prisma.InputJsonValue;
}

export interface CreatedNotification {
  readonly id: string;
  readonly userId: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
}

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  url: string | null;
  data: unknown;
  readAt: string | null;
  createdAt: string;
}

/** Q3 — which pref switches the email for each type. A type not listed never emails. */
const EMAIL_PREF: Partial<Record<NotificationType, keyof NotificationPrefs>> = {
  'comment.mentioned': 'emailMentions',
  'comment.replied': 'emailCommentReplies',
  'access.requested': 'emailAccessRequests',
  'access.decided': 'emailAccessRequests',
  'resource.shared': 'emailInvites',
};

const PAGE_SIZE = 20;

const SELECT_CREATED = { id: true, userId: true, type: true, title: true, url: true } as const;

/**
 * Phase 4 DESIGN §4. Writers decide WHO (doc 05 L17: the recipient's view at send time,
 * an invisible target means no row at all); this service writes, pushes and emails.
 *
 * Writes can join the caller's transaction (`create`); delivery (`deliver`) runs after
 * the commit, so a rolled-back write never pages anyone.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /** Feeds the realtime gateway's `notification:new` (the `user:<id>` room). */
  readonly created = new Channel<{ readonly userId: string; readonly id: string }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async create(db: Db, items: readonly NotificationInput[]): Promise<CreatedNotification[]> {
    const rows: CreatedNotification[] = [];
    for (const item of items) {
      rows.push(await db.notification.create({ data: { ...item }, select: SELECT_CREATED }));
    }
    return rows;
  }

  /** Push, then email where the pref is on. Never throws: the write already committed. */
  async deliver(rows: readonly CreatedNotification[]): Promise<void> {
    if (rows.length === 0) return;
    for (const r of rows) this.created.next({ userId: r.userId, id: r.id });
    try {
      const users = await this.prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
        select: { id: true, email: true, name: true, notificationPrefs: true },
      });
      const byId = new Map(users.map((u) => [u.id, u]));
      for (const row of rows) {
        const user = byId.get(row.userId);
        const pref = EMAIL_PREF[row.type as NotificationType];
        if (user === undefined || pref === undefined) continue;
        if (readPrefs(user.notificationPrefs)[pref] !== true) continue;
        await this.mail.sendNotificationEmail(user.email, user.name, row.title, row.url);
      }
    } catch (error) {
      this.logger.error({ err: error }, 'notification delivery failed');
    }
  }

  async send(items: readonly NotificationInput[]): Promise<void> {
    await this.deliver(await this.create(this.prisma, items));
  }

  /** The in-app link for a project: `/<orgSlug>/p/<projectId>`, plus an optional query. */
  async projectUrl(projectId: string, query?: Record<string, string>): Promise<string | null> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId },
      select: { organization: { select: { slug: true } } },
    });
    if (project === null) return null;
    const search = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
    return `/${project.organization.slug}/p/${projectId}${search}`;
  }

  // ----------------------------------------------------------------------- the bell

  /** Newest first. `cursor` is the last id of the previous page. */
  async list(
    userId: string,
    cursor: string | undefined,
  ): Promise<{
    notifications: NotificationView[];
    unreadCount: number;
    nextCursor: string | null;
  }> {
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE + 1,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    const page = rows.slice(0, PAGE_SIZE);
    return {
      notifications: page.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        url: n.url,
        data: n.data,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      unreadCount,
      nextCursor: rows.length > PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Someone else's notification and a missing one are the same 404. */
  async markRead(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { readAt: new Date() },
    });
    if (count === 0)
      throw new NotFoundException({ code: 'not_found', resourceType: 'notification', id });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async prefs(userId: string): Promise<NotificationPrefs> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { notificationPrefs: true },
    });
    return readPrefs(user?.notificationPrefs);
  }

  async updatePrefs(userId: string, patch: NotificationPrefsPatch): Promise<NotificationPrefs> {
    const next = { ...(await this.prefs(userId)), ...patch };
    await this.prisma.user.update({ where: { id: userId }, data: { notificationPrefs: next } });
    return next;
  }
}

/** The `Stored` schema strips unknown keys and fills defaults; a garbage row reads as `{}`. */
function readPrefs(raw: unknown): NotificationPrefs {
  const parsed = notificationPrefsStoredSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : notificationPrefsStoredSchema.parse({});
}
