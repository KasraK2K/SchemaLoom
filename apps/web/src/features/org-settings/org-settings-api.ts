import { appearanceInputSchema, orgRoleSchema } from '@schemaloom/contracts';
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
  /** Roadmap 14b: filled by the IdP (SCIM or a sign-in claim), read-only here. */
  managedBy: z.enum(['scim', 'claim']).nullable(),
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

/** `GET /organizations/:slug/sso-connections` — `apps/api/src/auth/sso.controller.ts`. */
export const SsoConnectionSchema = z.object({
  id: z.string(),
  protocol: z.enum(['oidc', 'saml']),
  name: z.string(),
  domains: z.array(z.string()),
  oidcIssuer: z.string().nullable(),
  oidcClientId: z.string().nullable(),
  hasClientSecret: z.boolean(),
  samlEntryPoint: z.string().nullable(),
  samlIdpCert: z.string().nullable(),
  jit: z.boolean(),
  defaultOrgRole: z.enum(['member', 'guest', 'admin', 'owner']),
  enforced: z.boolean(),
  sp: z.union([
    z.object({ redirectUri: z.string() }),
    z.object({ entityId: z.string(), acsUrl: z.string(), metadataUrl: z.string() }),
  ]),
  /** Roadmap 14b: directory sync. */
  groupsClaim: z.string().nullable(),
  scimBaseUrl: z.string(),
  scim: z
    .object({ prefix: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable() })
    .nullable(),
  groupMappings: z.array(
    z.object({
      id: z.string(),
      claimValue: z.string(),
      groupId: z.string(),
      groupName: z.string(),
    }),
  ),
});
export type SsoConnection = z.infer<typeof SsoConnectionSchema>;

export async function listSsoConnections(orgSlug: string): Promise<SsoConnection[]> {
  return SsoConnectionSchema.array().parse(
    await serverFetch<unknown>(`${org(orgSlug)}/sso-connections`),
  );
}

/** `GET /organizations/:slug/workspaces/:id/grants` — `workspace-grants.service.ts` (roadmap 19). */
export const WorkspaceGrantSchema = z.object({
  id: z.string(),
  principalKind: z.enum(['user', 'group']),
  principalId: z.string(),
  principalName: z.string(),
  principalEmail: z.string().nullable(),
  roleKey: z.string(),
  roleName: z.string(),
  canUseAi: z.boolean(),
  canViewRestricted: z.boolean(),
  expiresAt: z.string().nullable(),
});
export type WorkspaceGrant = z.infer<typeof WorkspaceGrantSchema>;

export async function listWorkspaceGrants(
  orgSlug: string,
  workspaceId: string,
): Promise<WorkspaceGrant[]> {
  return WorkspaceGrantSchema.array().parse(
    await serverFetch<unknown>(
      `${org(orgSlug)}/workspaces/${encodeURIComponent(workspaceId)}/grants`,
    ),
  );
}

/** `GET /organizations/:slug/settings` — `apps/api/src/organizations/organizations.service.ts`. */
export const OrgSettingsSchema = z.object({
  allowGuestInvites: z.boolean(),
  defaultAppearance: appearanceInputSchema.nullable(),
});
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

export async function getOrgSettings(orgSlug: string): Promise<OrgSettings> {
  return OrgSettingsSchema.parse(await serverFetch<unknown>(`${org(orgSlug)}/settings`));
}
