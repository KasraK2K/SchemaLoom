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
