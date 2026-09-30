import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ConfirmedRenamesSchema } from '../snapshots';

/** Shape only: the engine's `connectionFields` are the real schema (`connection.ts`). */
const ConnectionSchema = z.record(z.string(), z.unknown());

export const IntrospectPreviewSchema = z.object({ connection: ConnectionSchema });
export class IntrospectPreviewDto extends createZodDto(IntrospectPreviewSchema) {}

export const IntrospectApplySchema = z.object({
  sourceId: z.uuid(),
  renames: ConfirmedRenamesSchema.default([]),
});
export class IntrospectApplyDto extends createZodDto(IntrospectApplySchema) {}

/** Destructive steps are commented out unless asked for, as on the History screen. */
export const IntrospectDriftSchema = z.object({
  connection: ConnectionSchema,
  allowDestructive: z.boolean().default(false),
  transactional: z.boolean().default(true),
});
export class IntrospectDriftDto extends createZodDto(IntrospectDriftSchema) {}
