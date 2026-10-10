import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { encryptSecret } from '../auth/totp';
import type { AppEnv } from '../config/env';
import type { Prisma } from '../generated/prisma/client';
import { NotificationsService } from '../notifications';
import { orgMembership } from '../organizations/members.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  STREAM_SELECT,
  deliverStream,
  dueStreams,
  envelope,
  postBatch,
  requestHeaders,
  type AuditStreamFormat,
  type Notice,
  type PostResult,
  type StreamRow,
} from './audit-stream.core';

/** Settings → Audit log → Stream to a SIEM. No secret ever leaves the api after the first save. */
export interface AuditStreamView {
  readonly url: string;
  readonly format: string;
  readonly authHeaderName: string | null;
  readonly hasAuthHeader: boolean;
  readonly paused: boolean;
  readonly status: string;
  readonly lastError: string | null;
  readonly lastDeliveredAt: Date | null;
  readonly failingSince: Date | null;
  readonly nextAttemptAt: Date | null;
  readonly createdAt: Date;
}

export interface AuditStreamInput {
  readonly url: string;
  readonly format: AuditStreamFormat;
  /** empty or absent: no auth header */
  readonly authHeaderName?: string | undefined;
  /** absent on an edit: keep the stored value */
  readonly authHeaderValue?: string | undefined;
  readonly paused: boolean;
}

const VIEW = {
  url: true,
  format: true,
  authHeaderName: true,
  authHeaderEnc: true,
  paused: true,
  status: true,
  lastError: true,
  lastDeliveredAt: true,
  failingSince: true,
  nextAttemptAt: true,
  createdAt: true,
} satisfies Prisma.AuditStreamSelect;

function toView({
  authHeaderEnc,
  ...row
}: Prisma.AuditStreamGetPayload<{ select: typeof VIEW }>): AuditStreamView {
  return { ...row, hasAuthHeader: authHeaderEnc !== null };
}

/**
 * Roadmap 14d (`docs/phase14/AUDIT-STREAMING.md`). Owners only (D4, Q4): the stream carries
 * every org row, including projects an admin can't open, so anyone else gets the 404 of a
 * missing org rather than a 403 that says the stream is there.
 */
@Injectable()
export class AuditStreamService {
  private readonly logger = new Logger(AuditStreamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly notifications: NotificationsService,
  ) {}

  private get key(): string {
    return this.config.get('SECRETS_ENCRYPTION_KEY', { infer: true });
  }

  private get allowPrivate(): boolean {
    return this.config.get('AUDIT_STREAM_ALLOW_PRIVATE_HOSTS', { infer: true });
  }

  private async ownedOrg(userId: string, orgSlug: string): Promise<string> {
    const member = await orgMembership(this.prisma, userId, orgSlug);
    if (member?.role !== 'owner') throw new NotFoundException({ code: 'not_found' });
    return member.organizationId;
  }

  async get(userId: string, orgSlug: string): Promise<{ stream: AuditStreamView | null }> {
    const organizationId = await this.ownedOrg(userId, orgSlug);
    const row = await this.prisma.auditStream.findUnique({
      where: { organizationId },
      select: VIEW,
    });
    return { stream: row === null ? null : toView(row) };
  }

  /** Create or update. The first save returns the signing secret, once. */
  async put(
    userId: string,
    orgSlug: string,
    input: AuditStreamInput,
  ): Promise<{ stream: AuditStreamView; signingSecret?: string }> {
    const organizationId = await this.ownedOrg(userId, orgSlug);
    const headerName = input.authHeaderName?.trim() ?? '';
    const header =
      headerName === ''
        ? { authHeaderName: null, authHeaderEnc: null }
        : {
            authHeaderName: headerName,
            ...(input.authHeaderValue === undefined
              ? {}
              : { authHeaderEnc: encryptSecret(Buffer.from(input.authHeaderValue), this.key) }),
          };
    const settings = { url: input.url, format: input.format, paused: input.paused, ...header };

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.auditStream.findUnique({
        where: { organizationId },
        select: { id: true, url: true, format: true, paused: true, authHeaderName: true },
      });
      if (existing === null) {
        const signingSecret = randomBytes(32).toString('base64url');
        const row = await tx.auditStream.create({
          data: {
            organizationId,
            ...settings,
            signingSecretEnc: encryptSecret(Buffer.from(signingSecret), this.key),
            // Q2: no backfill; the CSV covers the past.
            cursorAt: new Date(),
          },
          select: { id: true, ...VIEW },
        });
        await audit(tx, organizationId, userId, 'audit_stream.created', row.id, {
          url: input.url,
          format: input.format,
        });
        const { id: _id, ...view } = row;
        return { stream: toView(view), signingSecret };
      }

      const moved = existing.url !== input.url || existing.format !== input.format;
      const row = await tx.auditStream.update({
        where: { organizationId },
        // A new URL or format starts over: a failure on the old endpoint says nothing.
        data: {
          ...settings,
          ...(moved
            ? {
                status: 'ok',
                failures: 0,
                failingSince: null,
                lastError: null,
                nextAttemptAt: null,
              }
            : {}),
        },
        select: VIEW,
      });
      if (
        moved ||
        existing.authHeaderName !== settings.authHeaderName ||
        input.authHeaderValue !== undefined
      )
        await audit(tx, organizationId, userId, 'audit_stream.updated', existing.id, {
          url: input.url,
          format: input.format,
        });
      if (existing.paused !== input.paused)
        await audit(
          tx,
          organizationId,
          userId,
          input.paused ? 'audit_stream.paused' : 'audit_stream.resumed',
          existing.id,
          {},
        );
      return { stream: toView(row) };
    });
  }

  /** One synthetic event to the saved endpoint; the cursor doesn't move. */
  async test(userId: string, orgSlug: string): Promise<PostResult> {
    const organizationId = await this.ownedOrg(userId, orgSlug);
    const stream = await this.prisma.auditStream.findUnique({
      where: { organizationId },
      select: { ...STREAM_SELECT, organization: { select: { name: true } } },
    });
    if (stream === null) throw new NotFoundException({ code: 'not_found' });
    const now = new Date();
    const body = envelope(stream.format as AuditStreamFormat, [
      {
        id: `test-${randomUUID()}`,
        time: now.toISOString(),
        action: 'audit_stream.test',
        actor: { id: userId, email: null },
        organization: { id: organizationId, name: stream.organization.name },
        projectId: null,
        resource: { type: 'audit_stream', id: stream.id },
        ip: null,
        userAgent: null,
        metadata: { test: true },
      },
    ]);
    return postBatch({
      url: stream.url,
      body,
      headers: requestHeaders(stream, this.key, body, now),
      allowPrivate: this.allowPrivate,
    });
  }

  /** Delete forgets the cursor too. */
  async remove(userId: string, orgSlug: string): Promise<void> {
    const organizationId = await this.ownedOrg(userId, orgSlug);
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.auditStream.findUnique({
        where: { organizationId },
        select: { id: true, url: true },
      });
      if (existing === null) throw new NotFoundException({ code: 'not_found' });
      await tx.auditStream.delete({ where: { organizationId } });
      await audit(tx, organizationId, userId, 'audit_stream.deleted', existing.id, {
        url: existing.url,
      });
    });
  }

  /** The 30-second run: every due stream, one after another. */
  async sweep(now: Date = new Date()): Promise<void> {
    const streams = await dueStreams(this.prisma, now);
    for (const stream of streams) {
      try {
        const notice = await deliverStream(
          this.prisma,
          stream,
          { key: this.key, allowPrivate: this.allowPrivate },
          now,
        );
        if (notice !== null) await this.notify(stream, notice);
      } catch (error) {
        // One stream (a database hiccup, a key rotated under it) must not stop the others.
        this.logger.error({ err: error, streamId: stream.id }, 'audit stream run failed');
      }
    }
  }

  private async notify(stream: StreamRow, type: Notice): Promise<void> {
    const [owners, org, row] = await Promise.all([
      this.prisma.orgMember.findMany({
        where: { organizationId: stream.organizationId, role: 'owner' },
        select: { userId: true },
      }),
      this.prisma.organization.findUniqueOrThrow({
        where: { id: stream.organizationId },
        select: { slug: true },
      }),
      this.prisma.auditStream.findUnique({
        where: { id: stream.id },
        select: { lastError: true },
      }),
    ]);
    const host = new URL(stream.url).host;
    const error = row?.lastError ?? '';
    const title =
      type === 'audit_stream.failing'
        ? `Streaming the audit log to ${host} is failing (${error})`
        : `Streaming the audit log to ${host} works again`;
    await this.notifications.send(
      owners.map(({ userId }) => ({
        userId,
        actorUserId: null,
        organizationId: stream.organizationId,
        projectId: null,
        type,
        title,
        url: `/${org.slug}/settings/audit-log`,
        data: type === 'audit_stream.failing' ? { error } : {},
      })),
    );
  }
}

function audit(
  tx: Prisma.TransactionClient,
  organizationId: string,
  actorUserId: string,
  action: string,
  streamId: string,
  metadata: Prisma.InputJsonValue,
): Promise<unknown> {
  return tx.auditLog.create({
    data: {
      organizationId,
      actorUserId,
      action,
      resourceType: 'audit_stream',
      resourceId: streamId,
      metadata,
    },
  });
}
