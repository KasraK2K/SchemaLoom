import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EngineRegistry } from '@schemaloom/engine-sdk';
import { PermissionResolver, VisibilityFilter, canOpenProject, isCompleteView } from '../access';
import { ENGINE_REGISTRY } from '../engines';
import { NotificationsService } from '../notifications';
import { PrismaService } from '../prisma/prisma.service';
import { SchemaLoader } from '../schema';
import { StorageService } from '../storage';
import { exportObjectKey, renderExport } from './export-render';
import type { ExportJobData, ExportJobResult } from './queues';

/**
 * How long a rendered artifact survives. The bucket's lifecycle rule deletes the object
 * at `export_jobs.expires_at` and the row is swept with it (doc 02's `ExportJob`), so the
 * store does not accumulate every DDL anyone ever downloaded.
 */
export const EXPORT_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Build-order step 26 — the export job.
 *
 * THE WHOLE PATH IS `SchemaLoader -> VisibilityFilter -> renderExport -> S3`. It cannot be
 * short-circuited: `load()` returns a `RawSchemaModel` whose payload lives in a
 * module-private `WeakMap` and whose `toJSON` throws, `redact()` is the only function that
 * accepts one, and `renderExport` accepts only what `redact()` returns. A background job
 * is exactly where "it's only an internal render, permissions were checked at enqueue" gets
 * written; here it does not compile.
 *
 * Permissions are resolved WHEN THE JOB RUNS, from the `(projectId, subject)` in the
 * payload — so a grant revoked between enqueue and render is honoured.
 */
@Injectable()
export class ExportProcessor {
  private readonly logger = new Logger(ExportProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: SchemaLoader,
    private readonly visibility: VisibilityFilter,
    private readonly resolver: PermissionResolver,
    @Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
  ) {}

  async run(data: ExportJobData): Promise<ExportJobResult> {
    const { exportJobId, projectId, subject, format } = data;
    await this.prisma.exportJob.update({
      where: { id: exportJobId },
      data: { status: 'running' },
    });

    try {
      // doc 05 L11: `export:run` is re-checked HERE, not only at enqueue, so a grant revoked
      // while the job sat in the queue stops the render.
      const map = await this.resolver.resolveProject(subject, projectId);
      if (!canOpenProject(map) || !map.projectAtoms.has('export:run')) {
        throw new Error('export_access_revoked');
      }
      const skel = await this.resolver.skeleton(projectId);
      const model = this.visibility.redactWith(
        await this.loader.load(projectId),
        subject,
        projectId,
        map,
        skel,
      );
      // A hidden table leaves no stub behind, so the model alone cannot say it is partial.
      const partialView = !isCompleteView(this.visibility.contextFrom(subject, projectId, map, skel));
      // The engine id travels ON the model, so there is no second project read and no way
      // for the two to disagree. `get` throws `UnknownEngineError` for an engine this
      // deployment does not carry, which fails the job rather than emitting wrong DDL.
      const engine = this.registry.get(model.engineId);
      // Every doc row of the project: `renderExport` keeps only those the REDACTED model
      // still points at, so no visibility rule is repeated here.
      const docs = DOC_FORMATS.has(format)
        ? await this.prisma.doc.findMany({
            where: { projectId },
            select: { id: true, targetType: true, targetId: true, plainText: true, structured: true },
          })
        : [];
      const rendered = await renderExport({ model, format, engine, docs, options: data.options, partialView });

      const storageKey = exportObjectKey(projectId, exportJobId, rendered.fileExtension);
      const body =
        typeof rendered.body === 'string' ? Buffer.from(rendered.body, 'utf8') : rendered.body;
      await this.storage.put(storageKey, body, rendered.contentType);

      await this.prisma.exportJob.update({
        where: { id: exportJobId },
        data: {
          status: 'done',
          storageKey,
          sizeBytes: body.byteLength,
          error: null,
          expiresAt: new Date(Date.now() + EXPORT_ARTIFACT_TTL_MS),
        },
      });

      await this.notifyReady(data);
      return { storageKey, sizeBytes: body.byteLength, incomplete: rendered.incomplete };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, exportJobId, format }, 'export job failed');
      await this.prisma.exportJob.update({
        where: { id: exportJobId },
        data: { status: 'failed', error: message },
      });
      // Rethrown so BullMQ records the failure and applies the retry policy. The row is
      // already `failed`; a retry moves it back to `running` on its next attempt.
      throw error;
    }
  }

  /**
   * `export.ready` to the requester. The title names the format only (L7: no schema
   * names in a stored title). Best effort: the artifact is already written and `done`.
   */
  private async notifyReady({ exportJobId, projectId, subject, format }: ExportJobData): Promise<void> {
    if (subject.kind !== 'user') return;
    try {
      const project = await this.prisma.project.findFirst({
        where: { id: projectId },
        select: { organizationId: true },
      });
      if (project === null) return;
      await this.notifications.send([
        {
          userId: subject.userId,
          actorUserId: null,
          organizationId: project.organizationId,
          projectId,
          type: 'export.ready',
          title: `Your ${format} export is ready`,
          url: await this.notifications.projectUrl(projectId),
          data: { exportJobId, format },
        },
      ]);
    } catch (error) {
      this.logger.warn({ err: error, exportJobId }, 'export.ready notification failed');
    }
  }
}

/** The formats that print documentation, and so need the `docs` rows. */
const DOC_FORMATS: ReadonlySet<string> = new Set(['markdown', 'pdf']);
