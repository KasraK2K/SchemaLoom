import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isSecretField,
  visibleFields,
  type ConnectionField,
  type ConnectionValues,
  type EngineRegistry,
} from '@schemaloom/engine-sdk';
import { decryptSecret, encryptSecret } from '../auth/totp';
import type { AppEnv } from '../config/env';
import { ENGINE_REGISTRY } from '../engines';
import { PrismaService } from '../prisma/prisma.service';
import { validateConnection } from './connection';

/**
 * Phase 6c (docs/phase6/SAVED-CONNECTIONS.md) — one saved connection per project, encrypted
 * whole under SECRETS_ENCRYPTION_KEY. Secret fields (`isSecretField`) never leave this
 * service except into the engine's child process.
 */

/** What a browser may see: the values that aren't secret, and which secrets are set. */
export interface SavedConnectionView {
  readonly values: Readonly<Record<string, string | number | readonly string[]>>;
  readonly secretsSet: readonly string[];
  readonly savedAt: string;
  readonly savedBy: { readonly id: string; readonly name: string } | null;
  readonly lastUsedAt: string | null;
  /** 6d — off | daily | weekly, and the last scheduled check (counts or the error only) */
  readonly driftSchedule: string;
  readonly lastCheck: {
    readonly at: string;
    readonly status: string;
    readonly summary: unknown;
  } | null;
}

/**
 * The fields that say WHERE the secrets go. A blank secret keeps the saved one only while
 * these are unchanged; otherwise whoever edits the connection could point the saved password
 * at a server of their own. Core conventions, like `host`, `sslmode` and the `ssh*` ids.
 */
const TARGET_IDS = ['host', 'port', 'user', 'ssh', 'ssh_host', 'ssh_port', 'ssh_user'] as const;

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);

const scalar = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : '';
const same = (a: unknown, b: unknown): boolean => scalar(a) === scalar(b);

/**
 * The PUT body with blank secrets filled from the saved connection, when that is safe. Pure,
 * so the rules are testable without a database.
 */
export function mergeSecrets(
  fields: readonly ConnectionField[],
  saved: ConnectionValues | null,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...input };
  if (saved === null) return merged;
  const retargeted = TARGET_IDS.some(
    (id) => !same(input[id] ?? fieldDefault(fields, id), saved[id] ?? fieldDefault(fields, id)),
  );
  for (const field of visibleFields(fields, input).filter(isSecretField)) {
    if (!isBlank(input[field.id]) || isBlank(saved[field.id])) continue;
    if (retargeted) {
      throw new UnprocessableEntityException({
        code: 'introspect.invalid_connection',
        field: field.id,
        message: `${field.label}: enter it again. The host, user or SSH server changed, so the saved one is not reused.`,
      });
    }
    merged[field.id] = saved[field.id];
  }
  return merged;
}

const fieldDefault = (fields: readonly ConnectionField[], id: string) =>
  fields.find((f) => f.id === id)?.default;

/** The browser's half: secrets removed, the ids of those that are set listed instead. */
export function publicView(
  fields: readonly ConnectionField[],
  values: ConnectionValues,
): Pick<SavedConnectionView, 'values' | 'secretsSet'> {
  const secret = new Set(fields.filter(isSecretField).map((f) => f.id));
  const out: Record<string, string | number | readonly string[]> = {};
  const secretsSet: string[] = [];
  for (const [id, value] of Object.entries(values)) {
    if (secret.has(id)) {
      if (!isBlank(value)) secretsSet.push(id);
    } else {
      out[id] = value;
    }
  }
  return { values: out, secretsSet };
}

@Injectable()
export class SavedConnectionService {
  private readonly key: string;
  private readonly allowPrivate: boolean;

  constructor(
    config: ConfigService<AppEnv, true>,
    @Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry,
    private readonly prisma: PrismaService,
  ) {
    this.key = config.get('SECRETS_ENCRYPTION_KEY', { infer: true });
    this.allowPrivate = config.get('INTROSPECT_ALLOW_PRIVATE_HOSTS', { infer: true });
  }

  async view(projectId: string): Promise<SavedConnectionView> {
    const { fields } = await this.engineOf(projectId);
    const row = await this.prisma.projectConnection.findUnique({
      where: { projectId },
      include: { savedBy: { select: { id: true, name: true } } },
    });
    if (row === null) throw notFound();
    return {
      ...publicView(fields, this.decrypt(row.encrypted)),
      savedAt: row.savedAt.toISOString(),
      savedBy: row.savedBy === null ? null : { id: row.savedBy.id, name: row.savedBy.name },
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      driftSchedule: row.driftSchedule,
      lastCheck:
        row.lastCheckAt === null || row.lastCheckStatus === null
          ? null
          : {
              at: row.lastCheckAt.toISOString(),
              status: row.lastCheckStatus,
              summary: row.lastCheckSummary,
            },
    };
  }

  /** 6d — Off, Daily or Weekly. Turning it off keeps the last result; Forget removes both. */
  async setSchedule(
    projectId: string,
    userId: string,
    driftSchedule: 'off' | 'daily' | 'weekly',
  ): Promise<SavedConnectionView> {
    const { organizationId } = await this.engineOf(projectId);
    const updated = await this.prisma.projectConnection.updateMany({
      where: { projectId },
      data: { driftSchedule },
    });
    if (updated.count === 0) throw notFound();
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        projectId,
        actorUserId: userId,
        action: 'connection.drift_scheduled',
        resourceType: 'project',
        resourceId: projectId,
        metadata: { driftSchedule },
      },
    });
    return this.view(projectId);
  }

  async save(projectId: string, userId: string, input: unknown): Promise<SavedConnectionView> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new UnprocessableEntityException({
        code: 'introspect.invalid_connection',
        field: 'connection',
        message: 'Connection details are required.',
      });
    }
    const { engineId, organizationId, fields } = await this.engineOf(projectId);
    const existing = await this.prisma.projectConnection.findUnique({ where: { projectId } });
    const saved = existing?.engineId === engineId ? this.decrypt(existing.encrypted) : null;
    const values = validateConnection(
      fields,
      mergeSecrets(fields, saved, input as Record<string, unknown>),
      this.allowPrivate,
    );
    const encrypted = encryptSecret(Buffer.from(JSON.stringify(values), 'utf8'), this.key);
    const data = { engineId, encrypted, savedById: userId, savedAt: new Date(), lastUsedAt: null };
    await this.prisma.projectConnection.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });
    await this.audit(organizationId, projectId, userId, 'connection.saved', values);
    return this.view(projectId);
  }

  async forget(projectId: string, userId: string): Promise<void> {
    const { organizationId } = await this.engineOf(projectId);
    const row = await this.prisma.projectConnection.findUnique({ where: { projectId } });
    if (row === null) throw notFound();
    await this.prisma.projectConnection.delete({ where: { projectId } });
    await this.audit(organizationId, projectId, userId, 'connection.forgotten', null);
  }

  /** The saved values for a read, or 404 when there are none. Validated again by the
   *  caller against the engine's current fields. */
  async load(projectId: string, engineId: string): Promise<ConnectionValues> {
    const row = await this.prisma.projectConnection.findUnique({ where: { projectId } });
    if (row?.engineId !== engineId) throw notFound();
    return this.decrypt(row.encrypted);
  }

  async touch(projectId: string): Promise<void> {
    await this.prisma.projectConnection.updateMany({
      where: { projectId },
      data: { lastUsedAt: new Date() },
    });
  }

  private decrypt(encrypted: string): ConnectionValues {
    try {
      return JSON.parse(decryptSecret(encrypted, this.key).toString('utf8')) as ConnectionValues;
    } catch {
      // SECRETS_ENCRYPTION_KEY changed since it was saved (docs/deploy.md: re-save).
      throw new ConflictException({
        code: 'connection.undecryptable',
        message:
          'The saved connection can’t be read with this server’s key. Enter its passwords and keys again.',
      });
    }
  }

  private async engineOf(projectId: string) {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { engineId: true, organizationId: true },
    });
    const engine = this.registry.tryGet(project.engineId);
    if (engine?.introspector === undefined) {
      throw new UnprocessableEntityException({ code: 'engine.introspection_unavailable' });
    }
    // Phase 13 §5: a file engine (SQLite) has nothing to reconnect to, so nothing to save or
    // schedule. Every save, schedule and load comes through here.
    if (engine.capabilities.introspection === 'file') {
      throw new BadRequestException({ code: 'connection.not_supported' });
    }
    return {
      engineId: project.engineId,
      organizationId: project.organizationId,
      fields: engine.capabilities.connectionFields,
    };
  }

  private async audit(
    organizationId: string,
    projectId: string,
    userId: string,
    action: string,
    values: ConnectionValues | null,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        projectId,
        actorUserId: userId,
        action,
        resourceType: 'project',
        resourceId: projectId,
        // Host and database only (Phase 6 §3.1): never the user, password or keys.
        metadata:
          values === null
            ? {}
            : {
                host: typeof values.host === 'string' ? values.host : '',
                database: typeof values.database === 'string' ? values.database : '',
              },
      },
    });
  }
}

const notFound = () =>
  new NotFoundException({ code: 'not_found', resourceType: 'project_connection' });
