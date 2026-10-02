import { orgRoleSchema } from '@schemaloom/contracts';
import { z } from 'zod';
import { serverFetch } from '@/lib/server-api';

/** `GET /organizations/:slug/members` — `apps/api/src/organizations/members.service.ts`. */
export const MemberViewSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: orgRoleSchema,
  joinedAt: z.string(),
});
export type MemberView = z.infer<typeof MemberViewSchema>;

/** `GET /organizations/:slug/groups` — `apps/api/src/organizations/groups.service.ts`. */
export const GroupViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  members: z.array(z.object({ userId: z.string(), name: z.string(), email: z.string() })),
});
export type GroupView = z.infer<typeof GroupViewSchema>;

const org = (slug: string) => `/organizations/${encodeURIComponent(slug)}`;

export async function listMembers(orgSlug: string): Promise<MemberView[]> {
  return MemberViewSchema.array().parse(await serverFetch<unknown>(`${org(orgSlug)}/members`));
}

/** `GET /organizations/:slug/invitations` — `apps/api/src/organizations/member-invites.service.ts`. */
export const PendingInviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: orgRoleSchema,
  invitedBy: z.string().nullable(),
  expiresAt: z.string(),
});
export type PendingInvite = z.infer<typeof PendingInviteSchema>;

export async function listInvites(orgSlug: string): Promise<PendingInvite[]> {
  return PendingInviteSchema.array().parse(
    await serverFetch<unknown>(`${org(orgSlug)}/invitations`),
  );
}

/** The signed-in user's id, so the members list can mark (and lock) their own row. */
export async function myUserId(): Promise<string> {
  return z.object({ id: z.string() }).parse(await serverFetch<unknown>('/auth/me')).id;
}

export async function listGroups(orgSlug: string): Promise<GroupView[]> {
  return GroupViewSchema.array().parse(await serverFetch<unknown>(`${org(orgSlug)}/groups`));
}
