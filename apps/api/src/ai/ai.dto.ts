import { selectionSchema } from '@schemaloom/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Wire shapes, mirrored by `apps/web/src/features/ai/ai-api.ts`. */

export const createThreadSchema = z.object({
  selection: selectionSchema,
  title: z.string().trim().min(1).max(200).optional(),
});
export class CreateThreadDto extends createZodDto(createThreadSchema) {}

export const postMessageSchema = z
  .object({
    content: z.string().trim().min(1).max(20_000),
    mode: z.enum(['query', 'explain', 'code']),
    /** Phase 18 — code mode's ORM; the service checks the engine exports it. */
    orm: z.enum(['prisma', 'drizzle', 'typeorm', 'django']).optional(),
  })
  .refine((b) => (b.mode === 'code') === (b.orm !== undefined), {
    message: 'orm is required in code mode and only there',
    path: ['orm'],
  });
export class PostMessageDto extends createZodDto(postMessageSchema) {}

export const docDraftsSchema = z.object({
  entityIds: z.array(z.string().min(1)).min(1).max(50),
});
export class DocDraftsDto extends createZodDto(docDraftsSchema) {}

/** Phase 22 §2.1. `revise` is stateless: the client sends back the draft it holds. */
export const draftSchemaSchema = z.object({
  description: z.string().trim().min(1).max(10_000),
  focusEntityIds: z.array(z.string().min(1)).max(50).optional(),
  revise: z
    .object({
      draft: z
        .string()
        .min(1)
        .refine((s) => Buffer.byteLength(s, 'utf8') <= 100_000, 'draft is over 100 KB'),
      instruction: z.string().trim().min(1).max(2_000),
    })
    .optional(),
});
export class DraftSchemaDto extends createZodDto(draftSchemaSchema) {}
