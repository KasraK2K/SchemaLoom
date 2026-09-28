import { z } from 'zod';
import { serverFetch } from '@/lib/server-api';

/** `GET /organizations/:slug/roles` — `apps/api/src/organizations/roles.service.ts`. */
export const RoleViewSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  atoms: z.array(z.string()),
  builtIn: z.boolean(),
  archived: z.boolean(),
});
export type RoleView = z.infer<typeof RoleViewSchema>;

/** `[]` for a guest or a non-member; archived custom roles only for owners and admins. */
export async function listRoles(orgSlug: string): Promise<RoleView[]> {
  return RoleViewSchema.array().parse(
    await serverFetch<unknown>(`/organizations/${encodeURIComponent(orgSlug)}/roles`),
  );
}
