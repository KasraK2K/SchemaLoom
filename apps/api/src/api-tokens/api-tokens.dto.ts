import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { API_TOKEN_SCOPES } from '../access';

/** Phase 11 §1 and Q8: an expiry is required, 90 days by default, a year at most. */
export const CreateApiTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(z.enum(API_TOKEN_SCOPES))
    .min(1)
    .refine((s) => s.includes('read'), {
      message: 'Every token can read.',
    }),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});
export class CreateApiTokenDto extends createZodDto(CreateApiTokenSchema) {}
