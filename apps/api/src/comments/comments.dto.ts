import { commentTargetTypeSchema } from '@schemaloom/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Wire shapes, mirrored by `apps/web/src/features/comments/comments-api.ts`. */

const id = z.string().min(1).max(64);

/** A TipTap document. The walker in `comment-rules.ts` tolerates any node shape. */
const content = z
  .object({ type: z.literal('doc'), content: z.array(z.unknown()).max(500).optional() })
  .loose()
  .refine((doc) => JSON.stringify(doc).length <= 50_000, { message: 'comment_too_large' });

export const commentTargetQuerySchema = z.object({
  targetType: commentTargetTypeSchema,
  targetId: id,
});
export class CommentTargetQueryDto extends createZodDto(commentTargetQuerySchema) {}

export const createCommentSchema = z.object({
  targetType: commentTargetTypeSchema,
  targetId: id,
  parentId: id.optional(),
  content,
});
export class CreateCommentDto extends createZodDto(createCommentSchema) {}

export const updateCommentSchema = z.object({ content });
export class UpdateCommentDto extends createZodDto(updateCommentSchema) {}
