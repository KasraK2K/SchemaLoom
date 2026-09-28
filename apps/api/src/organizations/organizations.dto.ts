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
