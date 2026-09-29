import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Wire shape of `PUT /projects/:id/docs/:targetType/:targetId`, mirrored by
 * `apps/web/src/features/docs/docs-api.ts`. Only the envelope here: the content and the
 * facts are sanitised and parsed by `DocsService.write`, which the AI draft accept path
 * calls directly, so there is one validator and not two.
 */
export const writeDocSchema = z.object({
  content: z.unknown(),
  structured: z.unknown().optional(),
  version: z.number().int().min(0).optional(),
});
export class WriteDocDto extends createZodDto(writeDocSchema) {}
