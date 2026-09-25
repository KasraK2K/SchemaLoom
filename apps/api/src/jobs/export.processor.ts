import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EngineRegistry } from '@schemaloom/engine-sdk';
import { VisibilityFilter } from '../access';
import { ENGINE_REGISTRY } from '../engines';
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
    @Inject(ENGINE_REGISTRY) private readonly registry: EngineRegistry,
    private readonly storage: StorageService,
  ) {}

  async run(data: ExportJobData): Promise<ExportJobResult> {
    const { exportJobId, projectId, subject, format } = data;
    await this.prisma.exportJob.update({
      where: { id: exportJobId },
      data: { status: 'running' },
    });

    try {
      const model = await this.visibility.redactModel(
        await this.loader.load(projectId),
        subject,
        projectId,
      );
      // The engine id travels ON the model, so there is no second project read and no way
      // for the two to disagree. `get` throws `UnknownEngineError` for an engine this
      // deployment does not carry, which fails the job rather than emitting wrong DDL.
      const engine = this.registry.get(model.engineId);
      const rendered = await renderExport({ model, format, engine });

      const storageKey = exportObjectKey(projectId, exportJobId, rendered.fileExtension);
      const body = Buffer.from(rendered.body, 'utf8');
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
}
