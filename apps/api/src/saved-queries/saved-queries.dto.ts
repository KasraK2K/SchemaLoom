import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Wire shapes, mirrored by `apps/web/src/features/queries/queries-api.ts`. */

const queryText = z.string().min(1).max(100_000);

const fields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable(),
  queryText,
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
};

export const createSavedQuerySchema = z.object({
  ...fields,
  description: fields.description.optional(),
  tags: fields.tags.optional(),
});
export class CreateSavedQueryDto extends createZodDto(createSavedQuerySchema) {}

/** Every key optional and none defaulted: an absent key is left as stored. */
export const updateSavedQuerySchema = z.object(fields).partial();
export class UpdateSavedQueryDto extends createZodDto(updateSavedQuerySchema) {}

export const validateQuerySchema = z.object({ query: queryText });
export class ValidateQueryDto extends createZodDto(validateQuerySchema) {}
