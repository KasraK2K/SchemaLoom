import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createOrganizationSchema = z.object({ name: z.string().trim().min(1).max(120) });
export class CreateOrganizationDto extends createZodDto(createOrganizationSchema) {}

export const createWorkspaceSchema = z.object({ name: z.string().trim().min(1).max(120) });
export class CreateWorkspaceDto extends createZodDto(createWorkspaceSchema) {}
