import type {
  BuiltInResourceRole,
  OrgRole,
  PermissionAtom,
  RestrictedFieldMode,
} from '@schemaloom/contracts';
import type { ProjectPermissionMap } from '../access';
import { effectiveRole } from './effective-role';

/**
 * The two shapes the navigation surfaces return. They are declared here rather than in
 * `packages/contracts` on purpose: everything below is a *projection of a permission map
 * onto a row*, which only the API can compute, and `contracts` would have to import the
 * resolver's types to describe it.
 *
 * Dates leave as ISO strings, not `Date`. A `Date`-typed field is a lie on the wire —
 * `JSON.stringify` has already turned it into a string by the time the browser sees it —
 * and the mismatch is invisible until a client does date arithmetic on a string.
 */

/** One row of the project list. Deliberately small: the sidebar renders 3-20 of these. */
export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly engineId: string;
  readonly updatedAt: string;
  /** `null` = access is area- or entity-scoped only (doc 05 §7.9). See `effectiveRole`. */
  readonly role: BuiltInResourceRole | null;
}

/**
 * The project shell: enough to paint a title and an engine badge without fetching the IR.
 *
 * This is `GET /projects/:id`, which is in `SHARE_LINK_ROUTES` (R21), so everything here
 * is readable by a share-link subject. That is why it carries no schema content, no
 * member list, no org id and no slug — a link holder learns the project's name and which
 * engine it uses, which is exactly what the link already told them.
 */
export interface ProjectDetail {
  readonly id: string;
  readonly name: string;
  readonly engineId: string;
  /** The TARGET DATABASE version ("16"), for the badge. */
  readonly engineVersion: string;
  /** The ENGINE PLUGIN contract version the stored props were written under (doc 03 §15). */
  readonly enginePluginVersion: string;
  readonly restrictedFieldMode: RestrictedFieldMode;
  readonly updatedAt: string;
  /** The caller's PROJECT-scope atoms, sorted so the payload is byte-stable. */
  readonly atoms: PermissionAtom[];
  readonly role: BuiltInResourceRole | null;
  /** `null` for a share-link subject: a link belongs to no organisation (§7.1). */
  readonly orgRole: OrgRole | null;
  /** Phase 10: set when this project is a change request's draft, for the canvas banner. */
  readonly draft: DraftOf | null;
  /** Phase 10b: schema edits only through change requests; the canvas opens read-only. */
  readonly requireChangeRequests: boolean;
}

export interface DraftOf {
  readonly projectId: string;
  readonly changeRequestId: string;
  readonly title: string;
  readonly status: 'open' | 'merged' | 'closed';
}

/** Exactly the columns `toSummary` reads. A Prisma row satisfies it structurally. */
export interface ProjectSummaryRow {
  readonly id: string;
  readonly name: string;
  readonly engineId: string;
  readonly updatedAt: Date;
}

export interface ProjectDetailRow extends ProjectSummaryRow {
  readonly engineVersion: string;
  readonly enginePluginVersion: string;
  readonly restrictedFieldMode: RestrictedFieldMode;
  readonly requireChangeRequests: boolean;
}

export const toSummary = (row: ProjectSummaryRow, map: ProjectPermissionMap): ProjectSummary => ({
  id: row.id,
  name: row.name,
  engineId: row.engineId,
  updatedAt: row.updatedAt.toISOString(),
  role: effectiveRole(map.projectAtoms),
});

export const toDetail = (
  row: ProjectDetailRow,
  map: ProjectPermissionMap,
  draft: DraftOf | null = null,
): ProjectDetail => ({
  id: row.id,
  name: row.name,
  engineId: row.engineId,
  engineVersion: row.engineVersion,
  enginePluginVersion: row.enginePluginVersion,
  restrictedFieldMode: row.restrictedFieldMode,
  updatedAt: row.updatedAt.toISOString(),
  atoms: [...map.projectAtoms].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  role: effectiveRole(map.projectAtoms),
  orgRole: map.orgRole,
  draft,
  requireChangeRequests: row.requireChangeRequests,
});
