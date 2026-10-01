import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IntrospectError,
  type ConnectionValues,
  type EngineRegistry,
  type IntrospectResult,
  type Introspector,
} from '@schemaloom/engine-sdk';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { AppEnv } from '../config/env';
import { ENGINE_REGISTRY } from '../engines';
import { JobsService } from '../jobs';
import { QUEUED_IMPORT_MAX_BYTES, importObjectKey } from '../jobs/import.processor';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CACHE, REDIS_RATELIMIT } from '../redis/redis.tokens';
import {
  SnapshotsService,
  type ConfirmedRename,
  type HistoryDiff,
  type ImportPreview,
  type MigrationRequest,
  type MigrationView,
  type SnapshotContext,
} from '../snapshots';
import { StorageService } from '../storage';
import { assertIntrospectionEnabled, resolveCheckedAddress } from './address-guard';
import { validateConnection } from './connection';
import { SavedConnectionService } from './saved-connection.service';
import { openTunnel, type Tunnel, type TunnelOptions } from './ssh-tunnel';

/** Phase 6 §3.6 — fixed windows, failing closed like the AI limiter. */
export const INTROSPECT_RATE_LIMITS = {
  user: { limit: 10, windowSec: 3_600 },
  org: { limit: 100, windowSec: 3_600 },
  /** 6d — scheduled checks have no user; this stops a runaway sweep. */
  scheduledOrg: { limit: 200, windowSec: 86_400 },
} as const;

/** Phase 6 §4 — preview → apply. The dump waits in S3; this Redis row says whose it is. */
const SOURCE_TTL_SEC = 3_600;
const sourceKey = (id: string) => `introspect:source:${id}`;

interface StoredSource {
  readonly projectId: string;
  readonly userId: string;
  readonly storageKey: string;
}

const STATUS: Record<IntrospectError['code'], HttpStatus> = {
  not_available: HttpStatus.SERVICE_UNAVAILABLE,
  too_large: HttpStatus.PAYLOAD_TOO_LARGE,
  timeout: HttpStatus.GATEWAY_TIMEOUT,
  unreachable: HttpStatus.UNPROCESSABLE_ENTITY,
  auth_failed: HttpStatus.UNPROCESSABLE_ENTITY,
  tls_failed: HttpStatus.UNPROCESSABLE_ENTITY,
  server_too_new: HttpStatus.UNPROCESSABLE_ENTITY,
  failed: HttpStatus.UNPROCESSABLE_ENTITY,
};

/** What a read connects with: details typed now, or the project's saved connection (6c).
 *  Saved means as saved, with no overrides: a changed host would carry the saved password
 *  to a server of the caller's choosing. */
export type ConnectionSource = { readonly connection: unknown } | { readonly saved: true };

/** §10.3 — the bastion's key as seen on this read, so the form can offer to pin it. */
interface SshSeen {
  readonly sshHostKey?: string;
}

export interface IntrospectPreview extends SshSeen {
  readonly preview: ImportPreview;
  readonly sourceId: string;
  readonly serverVersion: string;
}

export interface DriftView extends SshSeen {
  readonly diff: HistoryDiff;
  readonly migration: MigrationView;
  readonly serverVersion: string;
}

/**
 * Phase 6 — reading a live database. Everything after the engine's `introspect` is the
 * existing import pipeline (`SnapshotsService.preview`, the import job) or the existing
 * diff + migration code (`SnapshotsService.drift`), so there is no second write path.
 *
 * Credentials live in the request and in the engine's child process, nowhere else: not the
 * job payload, not Redis, not S3, not the audit row (§3.1).
 */
@Injectable()
export class IntrospectService {
  private readonly enabled: boolean;
  private readonly allowPrivate: boolean;

  constructor(
    config: ConfigService<AppEnv, true>,
    @Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry,
    private readonly prisma: PrismaService,
    private readonly snapshots: SnapshotsService,
    private readonly jobs: JobsService,
    private readonly storage: StorageService,
    @Inject(REDIS_RATELIMIT) private readonly rateLimit: Redis,
    @Inject(REDIS_CACHE) private readonly cache: Redis,
    private readonly savedConnections: SavedConnectionService,
  ) {
    this.enabled = config.get('INTROSPECTION_ENABLED', { infer: true });
    this.allowPrivate = config.get('INTROSPECT_ALLOW_PRIVATE_HOSTS', { infer: true });
  }

  async preview(ctx: SnapshotContext, connection: ConnectionSource): Promise<IntrospectPreview> {
    const userId = requireUser(ctx);
    const { source, serverVersion, sshHostKey } = await this.read(ctx, userId, connection);
    const preview = await this.snapshots.preview(ctx, source, QUEUED_IMPORT_MAX_BYTES);

    const sourceId = randomUUID();
    const storageKey = importObjectKey(ctx.projectId, sourceId);
    await this.storage.put(storageKey, Buffer.from(source, 'utf8'), 'text/plain; charset=utf-8');
    const stored: StoredSource = { projectId: ctx.projectId, userId, storageKey };
    await this.cache.set(sourceKey(sourceId), JSON.stringify(stored), 'EX', SOURCE_TTL_SEC);
    return { preview, sourceId, serverVersion, ...seen(sshHostKey) };
  }

  /** Single use: the row is taken with GETDEL, so a replayed apply finds nothing. Another
   *  user's or project's id reads as absent (invisible is 404). */
  async apply(
    ctx: SnapshotContext,
    sourceId: string,
    renames: readonly ConfirmedRename[],
  ): Promise<{ readonly id: string }> {
    assertIntrospectionEnabled(this.enabled);
    const userId = requireUser(ctx);
    const raw = await this.cache.getdel(sourceKey(sourceId));
    const stored = raw === null ? null : (JSON.parse(raw) as StoredSource);
    if (stored?.projectId !== ctx.projectId || stored.userId !== userId) {
      throw new NotFoundException({ code: 'not_found', resourceType: 'introspect_source' });
    }
    return {
      id: await this.jobs.enqueueImport({
        projectId: ctx.projectId,
        subject: ctx.subject,
        storageKey: stored.storageKey,
        renames,
      }),
    };
  }

  async drift(
    ctx: SnapshotContext,
    connection: ConnectionSource,
    request: MigrationRequest,
  ): Promise<DriftView> {
    const userId = requireUser(ctx);
    const { source, serverVersion, sshHostKey } = await this.read(ctx, userId, connection);
    const result = await this.snapshots.drift(ctx, source, QUEUED_IMPORT_MAX_BYTES, request);
    return { ...result, serverVersion, ...seen(sshHostKey) };
  }

  /** Every check runs before the api opens a connection anywhere. */
  private async read(
    ctx: SnapshotContext,
    userId: string,
    connection: ConnectionSource,
  ): Promise<IntrospectResult & { readonly sshHostKey: string | null }> {
    assertIntrospectionEnabled(this.enabled);
    this.snapshots.assertFullView(ctx);

    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: ctx.projectId },
      select: { engineId: true, organizationId: true },
    });
    const engine = this.registry.tryGet(project.engineId);
    const introspector = engine?.introspector;
    if (engine === undefined || introspector === undefined) {
      throw new UnprocessableEntityException({ code: 'engine.introspection_unavailable' });
    }
    const saved = 'saved' in connection;
    const values = validateConnection(
      engine.capabilities.connectionFields,
      // Saved values are validated again: the engine's fields may have changed since.
      saved
        ? await this.savedConnections.load(ctx.projectId, project.engineId)
        : connection.connection,
      this.allowPrivate,
    );
    await this.throttle(userId, project.organizationId);
    return this.readWith({
      projectId: ctx.projectId,
      organizationId: project.organizationId,
      engineId: engine.id,
      introspector,
      values,
      actorUserId: userId,
      saved,
    });
  }

  /**
   * Phase 6d — the scheduled check's read: the saved connection with every guard a typed read
   * has (re-validation, SSRF guard, tunnel and pin), no user (the audit row's actor is null)
   * and a per-org daily budget in place of the per-user limit.
   */
  async readScheduled(projectId: string): Promise<IntrospectResult> {
    assertIntrospectionEnabled(this.enabled);
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { engineId: true, organizationId: true },
    });
    const engine = this.registry.tryGet(project.engineId);
    const introspector = engine?.introspector;
    if (engine === undefined || introspector === undefined) {
      throw new UnprocessableEntityException({ code: 'engine.introspection_unavailable' });
    }
    const values = validateConnection(
      engine.capabilities.connectionFields,
      await this.savedConnections.load(projectId, project.engineId),
      this.allowPrivate,
    );
    await this.throttleWindow(
      `introspect:scheduled:org:${project.organizationId}`,
      INTROSPECT_RATE_LIMITS.scheduledOrg,
    );
    return this.readWith({
      projectId,
      organizationId: project.organizationId,
      engineId: engine.id,
      introspector,
      values,
      actorUserId: null,
      saved: true,
    });
  }

  /** The guarded read both paths share. Every check above ran before this connects. */
  private async readWith({
    projectId,
    organizationId,
    engineId,
    introspector,
    values,
    actorUserId,
    saved,
  }: {
    readonly projectId: string;
    readonly organizationId: string;
    readonly engineId: string;
    readonly introspector: Introspector;
    readonly values: ConnectionValues & { readonly host: string };
    readonly actorUserId: string | null;
    readonly saved: boolean;
  }): Promise<IntrospectResult & { readonly sshHostKey: string | null }> {
    // §10.3.1 — through a tunnel the api connects to the bastion, so that's what the guard
    // checks; the database host is the bastion's to resolve.
    const ssh = sshOptions(values);
    const resolvedAddress = await resolveCheckedAddress(
      ssh?.host ?? values.host,
      this.allowPrivate,
    );

    const audit = (metadata: Record<string, string | number | boolean>) =>
      this.prisma.auditLog.create({
        data: {
          organizationId,
          projectId,
          actorUserId,
          action: 'import.introspected',
          resourceType: 'project',
          resourceId: projectId,
          // Host and database name only: never the user, password or connection string.
          metadata: {
            engineId,
            host: values.host,
            address: resolvedAddress,
            database: typeof values.database === 'string' ? values.database : '',
            ...(ssh === null ? {} : { sshHost: ssh.host }),
            ...metadata,
          },
        },
      });

    let tunnel: Tunnel | null = null;
    let result: IntrospectResult;
    try {
      if (ssh !== null) tunnel = await openTunnel({ ...ssh.tunnel, address: resolvedAddress });
      result = await introspector.introspect({
        // Through a tunnel the engine reaches the database at the tunnel's local end; `host`
        // stays as typed so TLS still verifies the database's name.
        connection: tunnel === null ? values : { ...values, port: tunnel.port },
        resolvedAddress: tunnel === null ? resolvedAddress : '127.0.0.1',
        signal: AbortSignal.timeout(130_000),
        maxBytes: QUEUED_IMPORT_MAX_BYTES,
      });
    } catch (error) {
      if (error instanceof HttpException) {
        // openTunnel's `introspect.ssh_*`, already shaped for the response.
        const { code } = error.getResponse() as { code: string };
        await audit({
          ok: false,
          error: code.replace(/^introspect\./, ''),
          ...(actorUserId === null ? { scheduled: true } : {}),
        });
        throw error;
      }
      if (!(error instanceof IntrospectError)) throw error;
      await audit({
        ok: false,
        error: error.code,
        ...seen(tunnel?.hostKey),
        ...(actorUserId === null ? { scheduled: true } : {}),
      });
      throw new HttpException(
        { code: `introspect.${error.code}`, message: error.message, ...seen(tunnel?.hostKey) },
        STATUS[error.code],
      );
    } finally {
      tunnel?.close();
    }
    const sshHostKey = tunnel?.hostKey ?? null;
    await audit({
      ok: true,
      serverVersion: result.serverVersion,
      bytes: Buffer.byteLength(result.source, 'utf8'),
      ...seen(sshHostKey),
      ...(saved ? { saved: true } : {}),
      ...(actorUserId === null ? { scheduled: true } : {}),
    });
    // "Last used" means by a person; a nightly check would make it meaningless.
    if (saved && actorUserId !== null) await this.savedConnections.touch(projectId);
    return { ...result, sshHostKey };
  }

  private async throttle(userId: string, organizationId: string): Promise<void> {
    await this.throttleWindow(`introspect:user:${userId}`, INTROSPECT_RATE_LIMITS.user);
    await this.throttleWindow(`introspect:org:${organizationId}`, INTROSPECT_RATE_LIMITS.org);
  }

  /** One fixed window, failing closed like the AI limiter. */
  private async throttleWindow(
    key: string,
    rule: { readonly limit: number; readonly windowSec: number },
  ): Promise<void> {
    const count = await this.rateLimit.incr(key);
    if (count === 1) await this.rateLimit.expire(key, rule.windowSec);
    if (count > rule.limit) {
      const ttl = await this.rateLimit.ttl(key);
      throw new HttpException(
        { code: 'introspect.rate_limited', retryAfter: ttl > 0 ? ttl : rule.windowSec },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

const seen = (sshHostKey: string | null | undefined): SshSeen => (sshHostKey ? { sshHostKey } : {});

const str = (values: ConnectionValues, id: string): string | undefined => {
  const value = values[id];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/**
 * §10.3 — the `SSH_TUNNEL_FIELDS` ids (already validated, so present when required) as tunnel
 * options. The far end is the engine's conventional `host` and `port`.
 */
function sshOptions(
  values: ConnectionValues & { readonly host: string },
): { readonly host: string; readonly tunnel: Omit<TunnelOptions, 'address'> } | null {
  if (values.ssh !== 'ssh') return null;
  const host = str(values, 'ssh_host')?.trim();
  if (host === undefined || typeof values.port !== 'number') {
    throw new UnprocessableEntityException({
      code: 'introspect.invalid_connection',
      field: 'ssh_host',
      message: 'An SSH tunnel needs the SSH host and the database port.',
    });
  }
  return {
    host,
    tunnel: {
      port: typeof values.ssh_port === 'number' ? values.ssh_port : 22,
      username: str(values, 'ssh_user') ?? '',
      privateKey: str(values, 'ssh_private_key'),
      passphrase: str(values, 'ssh_passphrase'),
      password: str(values, 'ssh_password'),
      pinnedHostKey: str(values, 'ssh_host_key'),
      dstHost: values.host,
      dstPort: values.port,
    },
  };
}

/** A share-link subject is 404'd by the guard first; narrowing gives the job an owner. */
function requireUser(ctx: SnapshotContext): string {
  if (ctx.subject.kind !== 'user') throw new ForbiddenException({ code: 'route_not_classified' });
  return ctx.subject.userId;
}
