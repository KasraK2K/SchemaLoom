import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { EngineRegistry } from '@schemaloom/engine-sdk';
import { PermissionResolver, canOpenProject, type Subject } from '../access';
import { ENGINE_REGISTRY } from '../engines';
import type { ExportJob } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PRESIGN_PUT_TTL_SEC, StorageService } from '../storage';
import { EXPORT_ARTIFACT_TTL_MS } from './export.processor';
import {
  CORE_EXPORT_FORMATS,
  IMAGE_EXPORT_FORMATS,
  exportAtomsOf,
  exportObjectKey,
} from './export-render';
import { JobsService } from './jobs.service';
import type { ExportDdlOptions } from './queues';

/** Phase 8 §1 — the name each ORM's own tooling gives the file; everything else is `schema`. */
const DOWNLOAD_BASENAME: Readonly<Record<string, string>> = {
  typeorm: 'entities',
  django: 'models',
};

/** L11 — the download link lives ten minutes. */
export const EXPORT_DOWNLOAD_TTL_SEC = 600;

/** A client-rendered PNG/SVG of a large canvas. The URL signs the declared length. */
export const IMAGE_EXPORT_MAX_BYTES = 20 * 1024 * 1024;

type ImageFormat = keyof typeof IMAGE_EXPORT_FORMATS;

const isImageFormat = (format: string): format is ImageFormat =>
  Object.hasOwn(IMAGE_EXPORT_FORMATS, format);

type User = Extract<Subject, { kind: 'user' }>;

export interface CreateExportInput {
  readonly format: string;
  readonly options?: ExportDdlOptions;
  /** Required for `png`/`svg`: the byte length the browser will upload. */
  readonly sizeBytes?: number;
}

export interface ExportJobView {
  readonly id: string;
  readonly format: string;
  readonly status: ExportJob['status'];
  readonly error: string | null;
  /** `png`/`svg` only, on create: where the browser PUTs the rendered image. */
  readonly uploadUrl?: string;
  /** Once `done`: a fresh signed GET, `EXPORT_DOWNLOAD_TTL_SEC` long. */
  readonly downloadUrl?: string;
}

/**
 * Doc 05 §2.2 `export:run` — the API half of the export pipeline.
 *
 * Server formats (engine DDL, `ir-json`, `markdown`, `pdf`) create a row and enqueue; the
 * processor re-resolves visibility when it runs. `png`/`svg` are rendered by the browser
 * from the canvas it already holds (a redacted view), so the row gets a presigned PUT for
 * its one key and `complete` checks what landed there before the row says `done`.
 *
 * Rows are the requester's own. Every id-addressed read answers 404 for a row that is not
 * the caller's, and re-checks `export:run` at the project (or the row's area), so a revoked grant also revokes
 * the download of an artifact made before it.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly storage: StorageService,
    private readonly resolver: PermissionResolver,
    @Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry,
  ) {}

  /**
   * `areaId` is set by `POST /areas/:id/exports`, whose guard already checked `export:run`
   * at that area. Images are project-only: the browser renders the canvas it holds, which
   * is not cut to one area.
   */
  async create(
    subject: User,
    projectId: string,
    input: CreateExportInput,
    areaId?: string,
  ): Promise<ExportJobView> {
    const { format } = input;
    if (isImageFormat(format)) {
      if (areaId !== undefined) {
        throw new BadRequestException({ code: 'export_format_unsupported', format });
      }
      return this.createUpload(subject, projectId, format, input.sizeBytes);
    }
    await this.assertServerFormat(projectId, format);

    const row = await this.prisma.exportJob.create({
      data: { projectId, requestedById: subject.userId, format, areaId: areaId ?? null },
    });
    await this.jobs.enqueueExport({
      exportJobId: row.id,
      projectId,
      ...(areaId === undefined ? {} : { areaId }),
      subject,
      format,
      ...(input.options === undefined ? {} : { options: input.options }),
    });
    return view(row);
  }

  /** `projectId` fences an API token to its own project (Phase 11 §4). */
  async get(subject: User, id: string, projectId?: string): Promise<ExportJobView> {
    const row = await this.ownRow(subject, id, projectId);
    if (row.status !== 'done' || row.storageKey === null) return view(row);
    return {
      ...view(row),
      downloadUrl: await this.storage.presignGet(
        row.storageKey,
        EXPORT_DOWNLOAD_TTL_SEC,
        `${DOWNLOAD_BASENAME[row.format] ?? 'schema'}.${row.storageKey.slice(row.storageKey.lastIndexOf('.') + 1)}`,
      ),
    };
  }

  /**
   * The browser finished its PUT. The signed headers should already have stopped a wrong
   * type or size at the store; this checks the object itself, because a store that
   * ignores signed headers must not turn into an unbounded upload surface.
   */
  async complete(subject: User, id: string): Promise<ExportJobView> {
    const row = await this.ownRow(subject, id);
    if (!isImageFormat(row.format) || row.status !== 'running' || row.storageKey === null) {
      throw new ConflictException({ code: 'export_not_awaiting_upload' });
    }
    const expected = IMAGE_EXPORT_FORMATS[row.format].contentType;
    const head = await this.storage.head(row.storageKey);
    if (head === null) throw new BadRequestException({ code: 'export_upload_missing' });

    const valid =
      head.size > 0 &&
      head.size <= IMAGE_EXPORT_MAX_BYTES &&
      head.contentType?.split(';')[0]?.trim() === expected;
    if (!valid) {
      await this.storage.delete(row.storageKey);
      await this.prisma.exportJob.update({
        where: { id },
        data: { status: 'failed', error: 'export_upload_invalid' },
      });
      throw new BadRequestException({ code: 'export_upload_invalid' });
    }

    const done = await this.prisma.exportJob.update({
      where: { id },
      data: {
        status: 'done',
        sizeBytes: head.size,
        error: null,
        expiresAt: new Date(Date.now() + EXPORT_ARTIFACT_TTL_MS),
      },
    });
    return this.get(subject, done.id);
  }

  private async createUpload(
    subject: User,
    projectId: string,
    format: ImageFormat,
    sizeBytes: number | undefined,
  ): Promise<ExportJobView> {
    if (sizeBytes === undefined) throw new BadRequestException({ code: 'export_size_required' });
    if (sizeBytes > IMAGE_EXPORT_MAX_BYTES) {
      throw new PayloadTooLargeException({ code: 'export_too_large', max: IMAGE_EXPORT_MAX_BYTES });
    }
    const { contentType, fileExtension } = IMAGE_EXPORT_FORMATS[format];
    // `running` from the start: there is no queue step, the browser is the worker.
    const row = await this.prisma.exportJob.create({
      data: { projectId, requestedById: subject.userId, format, status: 'running' },
    });
    const storageKey = exportObjectKey(projectId, row.id, fileExtension);
    const updated = await this.prisma.exportJob.update({
      where: { id: row.id },
      data: { storageKey },
    });
    return {
      ...view(updated),
      uploadUrl: await this.storage.presignPut(
        storageKey,
        contentType,
        PRESIGN_PUT_TTL_SEC,
        sizeBytes,
      ),
    };
  }

  /** A format the job would only fail on is a 400 now, not a `failed` row later. */
  private async assertServerFormat(projectId: string, format: string): Promise<void> {
    if ((CORE_EXPORT_FORMATS as readonly string[]).includes(format)) return;
    const project = await this.prisma.project.findFirst({
      where: { id: projectId },
      select: { engineId: true },
    });
    const engine = project === null ? undefined : this.registry.tryGet(project.engineId);
    if (
      engine?.exporter === undefined ||
      !engine.capabilities.exportFormats.some((f) => f.id === format)
    ) {
      throw new BadRequestException({ code: 'export_format_unsupported', format });
    }
  }

  /** Not the caller's, gone, or expired: the same 404. */
  private async ownRow(subject: User, id: string, projectId?: string): Promise<ExportJob> {
    const row = await this.prisma.exportJob.findFirst({
      where: {
        id,
        requestedById: subject.userId,
        ...(projectId === undefined ? {} : { projectId }),
      },
    });
    if (row === null || (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now())) {
      throw notFound(id);
    }
    const map = await this.resolver.resolveProject(subject, row.projectId);
    if (!canOpenProject(map)) throw notFound(id);
    const atoms = exportAtomsOf(map, row.areaId);
    if (atoms === undefined) throw notFound(id);
    if (!atoms.has('export:run')) throw new ForbiddenException({ code: 'forbidden' });
    return row;
  }
}

function view(row: ExportJob): ExportJobView {
  return { id: row.id, format: row.format, status: row.status, error: row.error };
}

const notFound = (id: string): NotFoundException =>
  new NotFoundException({ code: 'not_found', resourceType: 'export_job', id });
