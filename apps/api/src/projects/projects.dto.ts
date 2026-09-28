import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The trust boundary for `POST /projects`. `ZodValidationPipe` is global (`main.ts`), so
 * naming this as the `@Body()` type is what makes a bad payload a 422 before any handler
 * code runs.
 *
 * `organizationId` is in the BODY and not the path because that is what the route marker
 * reads: `@RequireOrgRole('body.organizationId', …)` resolves the caller's org role
 * before the handler exists. A create route that took only `workspaceId` could not be
 * org-gated at all — the guard does no database lookups, so it cannot learn a workspace's
 * org — and the check would have to move into the service, where the boot sweep can no
 * longer see it.
 *
 * Server-owned and therefore absent: `slug` (derived from `name`), `enginePluginVersion`
 * (the registered engine's own `version`, doc 03 §15), `restrictedFieldMode`,
 * `permGeneration`, `schemaRevision` and `createdById`.
 */
export const CreateProjectSchema = z.object({
  organizationId: z.string().min(1).max(64),
  /** Omitted → the org's first workspace, created on demand. No route lists workspaces
   *  yet, so the web client has nothing to put here. */
  workspaceId: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** An `EngineRegistry` key. Validated against the registry, not against a list here. */
  engineId: z.string().min(1).max(64),
  /** The TARGET DATABASE version the picker chose ("16"), not the plugin version. */
  engineVersion: z.string().min(1).max(32),
});

export class CreateProjectDto extends createZodDto(CreateProjectSchema) {}

/** `PATCH /projects/:id` — the name only. The slug stays: URLs carry the id, not the slug. */
export const UpdateProjectSchema = z.object({ name: z.string().trim().min(1).max(200) });

export class UpdateProjectDto extends createZodDto(UpdateProjectSchema) {}
