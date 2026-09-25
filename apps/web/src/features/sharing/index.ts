/**
 * The sharing feature (build-order step 25). Everything outside this folder imports from
 * here — the dialog's internals, the warning rules and the wire schemas are not part of
 * the contract.
 */
export { ProjectShareButton } from './project-share-button';
export { RequestAccessButton } from './request-access-button';
export { WhoHasAccessDialog } from './who-has-access-dialog';
export { INERT_ORG_ADMIN_LABEL, isInertGrant, previewGrant, toggleState } from './grant-warnings';
export type { GrantWarning, ProposedGrant, ToggleState } from './grant-warnings';
export { ancestorChain, effectiveAtomsAt, grantAtoms, nearestGrants } from './effective';
export type { AccessEntry, AccessList, ResourceNode, RoleOption } from './model';
