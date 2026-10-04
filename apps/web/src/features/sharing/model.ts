import {
  orgRoleSchema,
  permissionAtomSchema,
  resourceTypeSchema,
  type PermissionAtom,
} from '@schemaloom/contracts';
import { z } from 'zod';

/**
 * The wire shapes the sharing UI reads. Parsed, never cast — every one of these crosses
 * the network trust boundary and the narrowing warning is computed from them.
 *
 * The payload mirrors doc 05 §7.7's `GET /projects/:id/access?explain=1`: it lists
 * *people* with their contributing grants and the deciding level, which is exactly what
 * `effective.ts` needs to run R15 (nearest-level-wins, per principal) on the client
 * instead of a dry-run round trip per keystroke.
 */

/**
 * Principals that appear in the grant list. `share_link` is deliberately NOT one:
 * §7.12 keeps link grants out of this list entirely and in their own section, whose only
 * action is Revoke — deleting the grant while the `ShareLink` row survives leaves a token
 * that unlocks into a project where every call 404s.
 */
export const GRANT_PRINCIPAL_KINDS = ['user', 'group', 'email_invite'] as const;
export const grantPrincipalKindSchema = z.enum(GRANT_PRINCIPAL_KINDS);
export type GrantPrincipalKind = (typeof GRANT_PRINCIPAL_KINDS)[number];

export const principalRefSchema = z.object({
  kind: grantPrincipalKindSchema,
  id: z.string(),
  /** display name, group name, or the invited email address */
  label: z.string(),
  /** Users only, and carried on the CANDIDATE list too: R13 makes a grant to an org
   *  owner or admin inert, and that has to be sayable before the person has any grant
   *  to look the org role up from. */
  orgRole: orgRoleSchema.nullable().optional(),
});
export type PrincipalRef = z.infer<typeof principalRefSchema>;

/** One node of the grantable tree: project -> area -> entity. `parentId` is what makes
 *  `ancestorChain` possible without a second request. */
export const resourceNodeSchema = z.object({
  type: resourceTypeSchema,
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
});
export type ResourceNode = z.infer<typeof resourceNodeSchema>;

export const roleOptionSchema = z.object({
  key: z.string(),
  name: z.string(),
  atoms: z.array(permissionAtomSchema),
  builtIn: z.boolean(),
});
export type RoleOption = z.infer<typeof roleOptionSchema>;

/** A single grant contributing to one person's effective access, tagged with the
 *  principal it hangs off — a user's own grant and a grant via a group are different
 *  principals, and E3 means a narrowing grant narrows only its own. */
export const contributingGrantSchema = z.object({
  id: z.string(),
  principal: principalRefSchema,
  /** `workspace`: inherited from the project's workspace (roadmap 19); changed there, not here. */
  resourceType: z.union([resourceTypeSchema, z.literal('workspace')]),
  resourceId: z.string(),
  resourceName: z.string(),
  roleKey: z.string(),
  roleName: z.string(),
  atoms: z.array(permissionAtomSchema),
  canUseAi: z.boolean(),
  canViewRestricted: z.boolean(),
  expiresAt: z.string().nullable(),
});
export type ContributingGrant = z.infer<typeof contributingGrantSchema>;

export const accessEntrySchema = z.object({
  principal: principalRefSchema,
  /** Users only. R13: an org `owner` or `admin` already holds every atom, which is what
   *  makes any grant to them inert. A group or a pending invite has no org role. */
  orgRole: orgRoleSchema.nullable(),
  email: z.string().nullable(),
  grants: z.array(contributingGrantSchema),
});
export type AccessEntry = z.infer<typeof accessEntrySchema>;

export const accessListSchema = z.object({
  canManage: z.boolean(),
  resources: z.array(resourceNodeSchema),
  roles: z.array(roleOptionSchema),
  entries: z.array(accessEntrySchema),
});
export type AccessList = z.infer<typeof accessListSchema>;

export const candidateListSchema = z.object({
  principals: z.array(principalRefSchema),
});

/**
 * A live share link. It carries no token: §7.12 stores only `sha256(token)`, so the
 * plaintext exists exactly once, in the create response. The list therefore cannot offer
 * "copy" — see `createdShareLinkSchema`.
 */
export const shareLinkSchema = z.object({
  id: z.string(),
  resourceType: resourceTypeSchema,
  resourceId: z.string(),
  resourceName: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  hasPassword: z.boolean(),
  useCount: z.number(),
  lastUsedAt: z.string().nullable(),
});
export type ShareLink = z.infer<typeof shareLinkSchema>;

export const createdShareLinkSchema = z.object({
  link: shareLinkSchema,
  /** Returned once, at creation, and never again. */
  url: z.string(),
});
export type CreatedShareLink = z.infer<typeof createdShareLinkSchema>;

export const shareLinkListSchema = z.object({ links: z.array(shareLinkSchema) });

export const accessRequestSchema = z.object({
  id: z.string(),
  requesterLabel: z.string(),
  requesterEmail: z.string().nullable(),
  resourceType: resourceTypeSchema,
  resourceId: z.string(),
  resourceName: z.string(),
  requestedRoleKey: z.string().nullable(),
  message: z.string().nullable(),
  createdAt: z.string(),
});
export type AccessRequest = z.infer<typeof accessRequestSchema>;

export const accessRequestListSchema = z.object({ requests: z.array(accessRequestSchema) });

/** The two per-grant toggles. Neither is in any built-in role (see `BUILT_IN_ROLES`), so
 *  turning one on is always a deliberate, separate act. */
export const AI_ATOM = 'ai:use' satisfies PermissionAtom;
export const RESTRICTED_ATOM = 'field:viewRestricted' satisfies PermissionAtom;
export type ToggleAtom = typeof AI_ATOM | typeof RESTRICTED_ATOM;

export function principalKeyOf(principal: PrincipalRef): string {
  return `${principal.kind}:${principal.id}`;
}
