import { resourceTypeSchema } from '@schemaloom/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Wire shapes for the sharing routes, mirroring `apps/web/src/features/sharing/model.ts`
 * and `sharing-api.ts`. The web half parses every response with zod, so a drift here
 * fails loudly in the browser rather than rendering a wrong access list.
 */

const id = z.string().min(1).max(64);

/**
 * For `email_invite` the `principalId` is the address (R11, doc 05 §6.4); the service
 * lowercases and shape-checks it, and `roleKey` may name a built-in or an org custom role.
 */
export const createGrantSchema = z.object({
  principalKind: z.enum(['user', 'group', 'email_invite']),
  principalId: z.string().trim().min(1).max(320),
  resourceType: resourceTypeSchema,
  resourceId: id,
  roleKey: z.string().min(1).max(64),
  canUseAi: z.boolean(),
  canViewRestricted: z.boolean(),
});
export class CreateGrantDto extends createZodDto(createGrantSchema) {}

export const updateGrantSchema = createGrantSchema.pick({
  roleKey: true,
  canUseAi: true,
  canViewRestricted: true,
});
export class UpdateGrantDto extends createZodDto(updateGrantSchema) {}

export const createShareLinkSchema = z.object({
  resourceType: resourceTypeSchema,
  resourceId: id,
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  password: z.string().min(8).max(200).nullable(),
});
export class CreateShareLinkDto extends createZodDto(createShareLinkSchema) {}

export const requestAccessSchema = z.object({
  projectId: id,
  resourceType: resourceTypeSchema,
  resourceId: id,
  requestedRoleKey: z.string().min(1).max(64).optional(),
  message: z.string().trim().max(1000).optional(),
});
export class RequestAccessDto extends createZodDto(requestAccessSchema) {}

export const approveAccessRequestSchema = z.object({ roleKey: z.string().min(1).max(64) });
export class ApproveAccessRequestDto extends createZodDto(approveAccessRequestSchema) {}

export const denyAccessRequestSchema = z.object({
  decisionNote: z.string().trim().max(1000).nullable(),
});
export class DenyAccessRequestDto extends createZodDto(denyAccessRequestSchema) {}

export const unlockShareLinkSchema = z.object({ password: z.string().max(200).nullable().default(null) });
export class UnlockShareLinkDto extends createZodDto(unlockShareLinkSchema) {}
