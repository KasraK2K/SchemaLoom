import { BUILT_IN_ROLE_ORDER, orgRoleSchema } from '@schemaloom/contracts';
import { z } from 'zod';
import { serverFetch } from '@/lib/server-api';

/**
 * The two navigation reads, server-side.
 *
 * Parsed, not cast. These cross a trust boundary and everything downstream — the link
 * target, the role badge, the redirect decision — reads them as if the shape were
 * guaranteed. A drifted `slug` would render as a list of links to `/undefined`.
 *
 * The API declares these shapes in `apps/api/src/{organizations,projects}`, not in
 * `packages/contracts`, because both are projections of a permission map onto a row and
 * only the API can compute one. So they are restated here rather than imported, and the
 * schemas are what keeps the restatement honest.
 */
const resourceRoleSchema = z.enum(BUILT_IN_ROLE_ORDER).nullable();

export const OrganizationSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  orgRole: orgRoleSchema,
});
export type OrganizationSummary = z.infer<typeof OrganizationSummarySchema>;

export const ProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  engineId: z.string(),
  updatedAt: z.string(),
  /** `null` = access is area- or entity-scoped only (doc 05 §7.9). */
  role: resourceRoleSchema,
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const WorkspaceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

/** `[]` for a guest or a non-member, exactly like the project list. */
export async function listWorkspaces(orgSlug: string): Promise<WorkspaceSummary[]> {
  return WorkspaceSummarySchema.array().parse(
    await serverFetch<unknown>(`/organizations/${encodeURIComponent(orgSlug)}/workspaces`),
  );
}

/** The subset of `GET /engines` the create form reads. `comingSoon` engines are not offered. */
const EngineOptionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  capabilities: z.object({
    importFormats: z.array(z.object({ id: z.string(), fileExtensions: z.array(z.string()) })),
  }),
});
export interface EngineOption {
  id: string;
  displayName: string;
  importFormats: { id: string; fileExtensions: string[] }[];
}

export async function listEngines(): Promise<EngineOption[]> {
  const { available } = z
    .object({ available: EngineOptionSchema.array() })
    .parse(await serverFetch<unknown>('/engines'));
  return available.map((engine) => ({
    id: engine.id,
    displayName: engine.displayName,
    importFormats: engine.capabilities.importFormats,
  }));
}

export async function listOrganizations(): Promise<OrganizationSummary[]> {
  return OrganizationSummarySchema.array().parse(await serverFetch<unknown>('/organizations'));
}

/**
 * Only the projects the caller may open — the API filters server-side over one batch
 * resolve. A slug the caller is not a member of answers `[]`, identically to a slug that
 * does not exist, so this route is not an existence oracle. The org page distinguishes
 * the two by checking the caller's own org list, which is theirs to see.
 */
export async function listProjects(orgSlug: string): Promise<ProjectSummary[]> {
  return ProjectSummarySchema.array().parse(
    await serverFetch<unknown>(`/organizations/${encodeURIComponent(orgSlug)}/projects`),
  );
}

/**
 * Where `/` sends a signed-in visitor.
 *
 * Exactly one organisation is the common case, and a list of one is a click that carries
 * no information. Zero is a real state, not an error — the window between registering and
 * joining a first org — so it gets a prompt, never a 404.
 */
export function homeDestination(
  orgs: readonly OrganizationSummary[],
): { kind: 'empty' } | { kind: 'list' } | { kind: 'redirect'; href: string } {
  if (orgs.length === 0) return { kind: 'empty' };
  const only = orgs[0];
  if (orgs.length === 1 && only !== undefined) return { kind: 'redirect', href: `/${only.slug}` };
  return { kind: 'list' };
}
