import { IdSchema } from '@schemaloom/schema-model';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The trust boundary for the one snapshot route that takes a body. `ZodValidationPipe` is
 * global (`main.ts`), so naming this as the `@Body()` type is what makes a bad payload a
 * 422 before any handler code runs — and what stops a client supplying `kind`, `ir` or
 * `enginePluginVersion`, all of which are server-owned (§8.9, §15.2).
 */
export const CreateSnapshotSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

export class CreateSnapshotDto extends createZodDto(CreateSnapshotSchema) {}

/** Phase 4 §2.1 — renames a human confirmed in the import dialog. Shape only here; the
 *  service validates each one against the fresh merge (`import-renames.ts`). */
export const ConfirmedRenamesSchema = z
  .array(
    z.object({
      type: z.enum(['entity', 'field']),
      fromId: IdSchema,
      toName: z.string().min(1).max(255),
    }),
  )
  .max(500);

/** `POST /projects/:projectId/import/preview`. */
export const ImportPreviewSchema = z.object({
  source: z.string().min(1).max(5_000_000),
  /** Phase 7b — one of the engine's `importFormats` (`prisma`); the first one when absent.
   *  The service checks it against the project's engine. */
  format: z.string().min(1).max(64).optional(),
});

export class ImportPreviewDto extends createZodDto(ImportPreviewSchema) {}

/** `POST /projects/:projectId/import`. The byte cap is the service's (it is UTF-8 bytes,
 *  not characters); this bound only stops an absurd body before it reaches the importer. */
export const ImportSourceSchema = ImportPreviewSchema.extend({
  renames: ConfirmedRenamesSchema.default([]),
});

export class ImportSourceDto extends createZodDto(ImportSourceSchema) {}

/** Doc 03 §11.2 `MigrationOptions`, from a query string: only the literal `true` / `false`. */
const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true');

/** `GET …/migration/…`. Destructive steps are commented out unless asked for (§11.2). */
export const MigrationQuerySchema = z.object({
  allowDestructive: flag('false'),
  transactional: flag('true'),
});

export class MigrationQueryDto extends createZodDto(MigrationQuerySchema) {}
