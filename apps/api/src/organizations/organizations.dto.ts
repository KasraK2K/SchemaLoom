import { orgRoleSchema, orgSettingsPatchSchema } from '@schemaloom/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createOrganizationSchema = z.object({ name: z.string().trim().min(1).max(120) });
export class CreateOrganizationDto extends createZodDto(createOrganizationSchema) {}

export const createWorkspaceSchema = z.object({ name: z.string().trim().min(1).max(120) });
export class CreateWorkspaceDto extends createZodDto(createWorkspaceSchema) {}

/** Atoms are plain strings here so an unknown one is V2's `unknown_atom`, not a zod 400. */
const roleName = z.string().trim().min(1).max(80);
const roleDescription = z.string().trim().max(500).nullable();
const roleAtoms = z.array(z.string().max(64)).max(32);

export const createRoleSchema = z.object({
  name: roleName,
  description: roleDescription.optional(),
  atoms: roleAtoms,
});
export class CreateRoleDto extends createZodDto(createRoleSchema) {}

export const updateRoleSchema = z.object({
  name: roleName.optional(),
  description: roleDescription.optional(),
  atoms: roleAtoms.optional(),
  archived: z.boolean().optional(),
});
export class UpdateRoleDto extends createZodDto(updateRoleSchema) {}

export class UpdateOrgSettingsDto extends createZodDto(orgSettingsPatchSchema) {}

export const updateMemberSchema = z.object({ role: orgRoleSchema });
export class UpdateMemberDto extends createZodDto(updateMemberSchema) {}

export const createInviteSchema = z.object({ email: z.email().max(254), role: orgRoleSchema });
export class CreateInviteDto extends createZodDto(createInviteSchema) {}

const groupName = z.string().trim().min(1).max(120);
const groupDescription = z.string().trim().max(500).nullable();

export const createGroupSchema = z.object({
  name: groupName,
  description: groupDescription.optional(),
});
export class CreateGroupDto extends createZodDto(createGroupSchema) {}

export const updateGroupSchema = z.object({
  name: groupName.optional(),
  description: groupDescription.optional(),
});
export class UpdateGroupDto extends createZodDto(updateGroupSchema) {}

export const addGroupMemberSchema = z.object({ userId: z.string().min(1).max(64) });
export class AddGroupMemberDto extends createZodDto(addGroupMemberSchema) {}

/** Roadmap 14 §2 — the audit log's filters, shared by the page and the CSV. */
export const auditQuerySchema = z.object({
  action: z.string().trim().min(1).max(80).optional(),
  actor: z.string().trim().min(1).max(320).optional(),
  projectId: z.string().min(1).max(64).optional(),
  // ISO strings, not z.date(): Swagger can't describe a Date and refuses to boot.
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  before: z.string().min(1).max(128).optional(),
});
export class AuditQueryDto extends createZodDto(auditQuerySchema) {}

/** Roadmap 19 — a grant on a whole workspace. Users and groups only. */
export const workspaceGrantSchema = z.object({
  principalKind: z.enum(['user', 'group']),
  principalId: z.string().trim().min(1).max(64),
  roleKey: z.string().min(1).max(64),
  canUseAi: z.boolean(),
  canViewRestricted: z.boolean(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export class WorkspaceGrantDto extends createZodDto(workspaceGrantSchema) {}
