import { AI_PROVIDER_IDS } from '@schemaloom/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AI_ABILITY_IDS } from './abilities';

/** Roadmap 24 §5.1 wire shapes. Keys are write-only: no response ever carries one. */

const models = z.array(z.string().trim().min(1).max(200)).min(1).max(50);
const apiKey = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .regex(/^[^\r\n]*$/, 'one line');

export const createIntegrationSchema = z
  .object({
    provider: z.enum(AI_PROVIDER_IDS),
    name: z.string().trim().min(1).max(100),
    baseUrl: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .optional(),
    apiKey: apiKey.optional(),
    models,
  })
  .refine((b) => (b.provider === 'openai_compatible') === (b.baseUrl !== undefined), {
    message: 'baseUrl is required for openai_compatible and only there',
    path: ['baseUrl'],
  })
  .refine((b) => b.provider === 'openai_compatible' || b.apiKey !== undefined, {
    message: 'apiKey is required',
    path: ['apiKey'],
  });
export class CreateIntegrationDto extends createZodDto(createIntegrationSchema) {}
export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>;

/** Absent fields are kept; `apiKey` rotates. Provider can't change: delete and re-add. */
export const updateIntegrationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    baseUrl: z.url({ protocol: /^https?$/ }).max(2000),
    apiKey,
    models,
  })
  .partial()
  .strict();
export class UpdateIntegrationDto extends createZodDto(updateIntegrationSchema) {}
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;

export const grantSchema = z
  .object({ projectId: z.string().min(1).nullable(), userId: z.string().min(1).nullable() })
  .strict();
export class GrantDto extends createZodDto(grantSchema) {}
export type GrantInput = z.infer<typeof grantSchema>;

export const choiceSchema = z
  .object({
    ability: z.enum(AI_ABILITY_IDS),
    integrationId: z.string().min(1),
    model: z.string().min(1).max(200),
    locked: z.boolean().default(false),
  })
  .strict();
export class ChoiceDto extends createZodDto(choiceSchema) {}
export type ChoiceInput = z.infer<typeof choiceSchema>;
