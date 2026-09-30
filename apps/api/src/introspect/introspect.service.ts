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
  type EngineRegistry,
  type IntrospectResult,
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

/** Phase 6 §3.6 — fixed windows, failing closed like the AI limiter. */
export const INTROSPECT_RATE_LIMITS = {
  user: { limit: 10, windowSec: 3_600 },
  org: { limit: 100, windowSec: 3_600 },
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

export interface IntrospectPreview {
  readonly preview: ImportPreview;
  readonly sourceId: string;
  readonly serverVersion: string;
}

export interface DriftView {
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
  ) {
    this.enabled = config.get('INTROSPECTION_ENABLED', { infer: true });
    this.allowPrivate = config.get('INTROSPECT_ALLOW_PRIVATE_HOSTS', { infer: true });
  }

  async preview(ctx: SnapshotContext, connection: unknown): Promise<IntrospectPreview> {
    const userId = requireUser(ctx);
    const { source, serverVersion } = await this.read(ctx, userId, connection);
    const preview = await this.snapshots.preview(ctx, source, QUEUED_IMPORT_MAX_BYTES);

    const sourceId = randomUUID();
    const storageKey = importObjectKey(ctx.projectId, sourceId);
    await this.storage.put(storageKey, Buffer.from(source, 'utf8'), 'text/plain; charset=utf-8');
    const stored: StoredSource = { projectId: ctx.projectId, userId, storageKey };
    await this.cache.set(sourceKey(sourceId), JSON.stringify(stored), 'EX', SOURCE_TTL_SEC);
    return { preview, sourceId, serverVersion };
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
    connection: unknown,
    request: MigrationRequest,
  ): Promise<DriftView> {
    const userId = requireUser(ctx);
    const { source, serverVersion } = await this.read(ctx, userId, connection);
    const result = await this.snapshots.drift(ctx, source, QUEUED_IMPORT_MAX_BYTES, request);
    return { ...result, serverVersion };
  }

  /** Every check runs before the api opens a connection anywhere. */
  private async read(
    ctx: SnapshotContext,
    userId: string,
    connection: unknown,
  ): Promise<IntrospectResult> {
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
    const values = validateConnection(
      engine.capabilities.connectionFields,
      connection,
      this.allowPrivate,
    );
    await this.throttle(userId, project.organizationId);
    const resolvedAddress = await resolveCheckedAddress(values.host, this.allowPrivate);

    const audit = (metadata: Record<string, string | number | boolean>) =>
      this.prisma.auditLog.create({
        data: {
          organizationId: project.organizationId,
          projectId: ctx.projectId,
          actorUserId: userId,
          action: 'import.introspected',
          resourceType: 'project',
          resourceId: ctx.projectId,
          // Host and database name only: never the user, password or connection string.
          metadata: {
            engineId: engine.id,
            host: values.host,
            address: resolvedAddress,
            database: typeof values.database === 'string' ? values.database : '',
            ...metadata,
          },
        },
      });

    let result: IntrospectResult;
    try {
      result = await introspector.introspect({
        connection: values,
        resolvedAddress,
        signal: AbortSignal.timeout(130_000),
        maxBytes: QUEUED_IMPORT_MAX_BYTES,
      });
    } catch (error) {
      if (!(error instanceof IntrospectError)) throw error;
      await audit({ ok: false, error: error.code });
      throw new HttpException(
        { code: `introspect.${error.code}`, message: error.message },
        STATUS[error.code],
      );
    }
    await audit({
      ok: true,
      serverVersion: result.serverVersion,
      bytes: Buffer.byteLength(result.source, 'utf8'),
    });
    return result;
  }

  private async throttle(userId: string, organizationId: string): Promise<void> {
    const windows = [
      { key: `introspect:user:${userId}`, rule: INTROSPECT_RATE_LIMITS.user },
      { key: `introspect:org:${organizationId}`, rule: INTROSPECT_RATE_LIMITS.org },
    ];
    for (const { key, rule } of windows) {
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
}

/** A share-link subject is 404'd by the guard first; narrowing gives the job an owner. */
function requireUser(ctx: SnapshotContext): string {
  if (ctx.subject.kind !== 'user') throw new ForbiddenException({ code: 'route_not_classified' });
  return ctx.subject.userId;
}
