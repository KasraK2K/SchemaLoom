import { selectionSchema } from '@schemaloom/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Wire shapes, mirrored by `apps/web/src/features/ai/ai-api.ts`. */

export const createThreadSchema = z.object({
  selection: selectionSchema,
  title: z.string().trim().min(1).max(200).optional(),
});
export class CreateThreadDto extends createZodDto(createThreadSchema) {}

export const postMessageSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  mode: z.enum(['query', 'explain']),
});
export class PostMessageDto extends createZodDto(postMessageSchema) {}

export const docDraftsSchema = z.object({
  entityIds: z.array(z.string().min(1)).min(1).max(50),
});
export class DocDraftsDto extends createZodDto(docDraftsSchema) {}

export const draftSchemaSchema = z.object({
  description: z.string().trim().min(1).max(10_000),
});
export class DraftSchemaDto extends createZodDto(draftSchemaSchema) {}
