import { orgRoleSchema } from '@schemaloom/contracts';
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

export const updateMemberSchema = z.object({ role: orgRoleSchema });
export class UpdateMemberDto extends createZodDto(updateMemberSchema) {}

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
