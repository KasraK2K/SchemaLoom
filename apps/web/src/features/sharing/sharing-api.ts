import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import {
  accessListSchema,
  accessRequestListSchema,
  candidateListSchema,
  createdShareLinkSchema,
  shareLinkListSchema,
  type AccessList,
  type CreatedShareLink,
  type GrantPrincipalKind,
  type PrincipalRef,
  type ShareLink,
} from './model';

/**
 * Every sharing call goes through `apiFetch`, which owns `credentials: 'include'` and the
 * CSRF double-submit echo. Nothing here re-implements either — a second copy of the echo
 * is a second place for it to drift out of sync with the cookie the API checks.
 */

export const accessQueryKey = (projectId: string): readonly unknown[] => [
  'project',
  projectId,
  'access',
];

/** §7.7 — the "Who has access" payload. `explain=1` adds the contributing grants and
 *  their deciding levels, which is what the narrowing warning is computed from. */
export function accessQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: accessQueryKey(projectId),
    queryFn: async (): Promise<AccessList> =>
      accessListSchema.parse(await apiFetch<unknown>(`/projects/${projectId}/access?explain=1`)),
  });
}

/** One combobox covers add-by-user and add-by-group; an address that matches nothing
 *  becomes an email invite, which is what `emailInvitePrincipal` builds. */
export function candidateQueryOptions(projectId: string, query: string) {
  return queryOptions({
    queryKey: ['project', projectId, 'access', 'candidates', query],
    queryFn: async (): Promise<PrincipalRef[]> =>
      candidateListSchema.parse(
        await apiFetch<unknown>(
          `/projects/${projectId}/access/candidates?q=${encodeURIComponent(query)}`,
        ),
      ).principals,
    enabled: query.trim().length > 1,
  });
}

export function emailInvitePrincipal(email: string): PrincipalRef {
  return { kind: 'email_invite', id: email, label: email };
}

export interface GrantWrite {
  readonly principalKind: GrantPrincipalKind;
  readonly principalId: string;
  readonly resourceType: 'project' | 'area' | 'entity';
  readonly resourceId: string;
  readonly roleKey: string;
  readonly canUseAi: boolean;
  readonly canViewRestricted: boolean;
}

export async function createGrant(projectId: string, body: GrantWrite): Promise<void> {
  await apiFetch<unknown>(`/projects/${projectId}/grants`, { method: 'POST', body });
}

export async function updateGrant(
  grantId: string,
  body: Pick<GrantWrite, 'roleKey' | 'canUseAi' | 'canViewRestricted'>,
): Promise<void> {
  await apiFetch<unknown>(`/grants/${grantId}`, { method: 'PATCH', body });
}

export async function deleteGrant(grantId: string): Promise<void> {
  await apiFetch<unknown>(`/grants/${grantId}`, { method: 'DELETE' });
}

export const shareLinksQueryKey = (projectId: string): readonly unknown[] => [
  'project',
  projectId,
  'share-links',
];

export function shareLinksQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: shareLinksQueryKey(projectId),
    queryFn: async (): Promise<ShareLink[]> =>
      shareLinkListSchema.parse(await apiFetch<unknown>(`/projects/${projectId}/share-links`))
        .links,
  });
}

export interface ShareLinkWrite {
  readonly resourceType: 'project' | 'area' | 'entity';
  readonly resourceId: string;
  /** ISO date, or null for "never". */
  readonly expiresAt: string | null;
  readonly password: string | null;
}

/**
 * No role in the request body. §7.12: creation always writes the built-in `viewer` role
 * and R17 caps a share-link session at `schema:view` regardless — so a role picker here
 * could only ever promise something the resolver would take away.
 */
export async function createShareLink(
  projectId: string,
  body: ShareLinkWrite,
): Promise<CreatedShareLink> {
  return createdShareLinkSchema.parse(
    await apiFetch<unknown>(`/projects/${projectId}/share-links`, { method: 'POST', body }),
  );
}

/** §7.12: revocation goes through this endpoint only — it sets `revokedAt` AND deletes
 *  the grant in one transaction. Deleting the grant from the grant list instead would
 *  leave a token that unlocks into a project where every call 404s. */
export async function revokeShareLink(linkId: string): Promise<void> {
  await apiFetch<unknown>(`/share-links/${linkId}`, { method: 'DELETE' });
}

export const accessRequestsQueryKey = (projectId: string): readonly unknown[] => [
  'project',
  projectId,
  'access-requests',
];

export function accessRequestsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: accessRequestsQueryKey(projectId),
    queryFn: async () =>
      accessRequestListSchema.parse(
        await apiFetch<unknown>(`/projects/${projectId}/access-requests`),
      ).requests,
  });
}

/** §7.13: `202 Accepted` unconditionally — for a project that does not exist, one in
 *  another org, or one you already hold. The endpoint is not an enumeration oracle, so
 *  the UI must not render anything that distinguishes the cases either. */
export async function requestAccess(body: {
  projectId: string;
  resourceType: 'project' | 'area' | 'entity';
  resourceId: string;
  requestedRoleKey?: string;
  message?: string;
}): Promise<void> {
  await apiFetch<unknown>('/access-requests', { method: 'POST', body });
}

export async function approveAccessRequest(requestId: string, roleKey: string): Promise<void> {
  await apiFetch<unknown>(`/access-requests/${requestId}/approve`, {
    method: 'POST',
    body: { roleKey },
  });
}

export async function denyAccessRequest(
  requestId: string,
  decisionNote: string | null,
): Promise<void> {
  await apiFetch<unknown>(`/access-requests/${requestId}/deny`, {
    method: 'POST',
    body: { decisionNote },
  });
}
