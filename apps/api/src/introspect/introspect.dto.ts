import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ConfirmedRenamesSchema } from '../snapshots';

/** Shape only: the engine's `connectionFields` are the real schema (`connection.ts`). */
const ConnectionSchema = z.record(z.string(), z.unknown());

/** Details typed now, or `saved: true` for the project's saved connection (6c) — one of. */
const source = {
  connection: ConnectionSchema.optional(),
  saved: z.literal(true).optional(),
};
const oneSource = (body: { connection?: unknown; saved?: true }) =>
  (body.connection === undefined) !== (body.saved === undefined);
const ONE_SOURCE = { message: 'Send either connection or saved: true.' };

export const IntrospectPreviewSchema = z.object(source).refine(oneSource, ONE_SOURCE);
export class IntrospectPreviewDto extends createZodDto(IntrospectPreviewSchema) {}

export const IntrospectApplySchema = z.object({
  sourceId: z.uuid(),
  renames: ConfirmedRenamesSchema.default([]),
});
export class IntrospectApplyDto extends createZodDto(IntrospectApplySchema) {}

/** Destructive steps are commented out unless asked for, as on the History screen. */
export const IntrospectDriftSchema = z
  .object({
    ...source,
    allowDestructive: z.boolean().default(false),
    transactional: z.boolean().default(true),
  })
  .refine(oneSource, ONE_SOURCE);

/** 6c — `PUT …/connection`. A blank secret keeps the saved one (`mergeSecrets`). */
export const SaveConnectionSchema = z.object({ connection: ConnectionSchema });
export class SaveConnectionDto extends createZodDto(SaveConnectionSchema) {}

/** 6d — `PATCH …/connection`. */
export const DriftScheduleSchema = z.object({ driftSchedule: z.enum(['off', 'daily', 'weekly']) });
export class DriftScheduleDto extends createZodDto(DriftScheduleSchema) {}
export class IntrospectDriftDto extends createZodDto(IntrospectDriftSchema) {}
