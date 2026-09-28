import type { OrgRole } from '@schemaloom/contracts';

/**
 * One row of the org switcher. `orgRole` travels with the org rather than being fetched
 * per org: it is the same `OrgMember` row the membership filter already read, and the
 * switcher needs it to decide whether to offer "New project" (doc 05 §3.2 — not for a
 * guest) before any project has been listed.
 */
export interface OrganizationSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly orgRole: OrgRole;
}

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}
