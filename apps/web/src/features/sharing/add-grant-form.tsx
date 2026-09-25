'use client';

import { Button } from '@schemaloom/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type SyntheticEvent } from 'react';
import { GrantWarningNotice } from './grant-warning-notice';
import { previewGrant, toggleState } from './grant-warnings';
import {
  AI_ATOM,
  RESTRICTED_ATOM,
  principalKeyOf,
  type AccessEntry,
  type PrincipalRef,
  type ResourceNode,
  type RoleOption,
} from './model';
import { candidateQueryOptions, emailInvitePrincipal, type GrantWrite } from './sharing-api';

/**
 * Add by user, by group, or by email — one combobox, because that is one question:
 * "who?". An address that matches no member is an email invite; everything else comes
 * from the candidate endpoint.
 *
 * The narrowing warning is recomputed on every change to the principal, the role or the
 * two toggles, from the `?explain=1` payload already in hand. §7.7 is explicit that a
 * dry-run resolve per keystroke is the thing not to build.
 */
export function AddGrantForm({
  projectId,
  scope,
  resources,
  roles,
  entries,
  onSubmit,
  pending,
}: {
  readonly projectId: string;
  readonly scope: ResourceNode;
  readonly resources: readonly ResourceNode[];
  readonly roles: readonly RoleOption[];
  readonly entries: readonly AccessEntry[];
  readonly onSubmit: (write: GrantWrite) => void;
  readonly pending: boolean;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<PrincipalRef | null>(null);
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? '');
  const [canUseAi, setCanUseAi] = useState(false);
  const [canViewRestricted, setCanViewRestricted] = useState(false);

  const { data: candidates } = useQuery(candidateQueryOptions(projectId, query));
  const role = roles.find((option) => option.key === roleKey);

  // The person's existing access, so the preview knows what this grant would displace.
  // Someone with no grant yet still needs an entry: their ORG role alone can make the
  // grant inert (R13).
  const entry = useMemo<AccessEntry | null>(() => {
    if (picked === null) return null;
    const key = principalKeyOf(picked);
    return (
      entries.find((candidate) => principalKeyOf(candidate.principal) === key) ?? {
        principal: picked,
        orgRole: picked.orgRole ?? null,
        email: null,
        grants: [],
      }
    );
  }, [picked, entries]);

  const warnings = useMemo(
    () =>
      entry === null || role === undefined
        ? []
        : previewGrant(entry, resources, { target: scope, role, canUseAi, canViewRestricted }),
    [entry, resources, scope, role, canUseAi, canViewRestricted],
  );

  const aiState = role === undefined ? null : toggleState(role, AI_ATOM, canUseAi);
  const restrictedState =
    role === undefined ? null : toggleState(role, RESTRICTED_ATOM, canViewRestricted);

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (picked === null || role === undefined) return;
    onSubmit({
      principalKind: picked.kind,
      principalId: picked.id,
      resourceType: scope.type,
      resourceId: scope.id,
      roleKey: role.key,
      canUseAi,
      canViewRestricted,
    });
    setPicked(null);
    setQuery('');
  }

  const offerInvite =
    picked === null && query.includes('@') && (candidates ?? []).length === 0 && query.length > 3;

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <div className="flex items-center gap-2">
        <input
          type="text"
          aria-label="Add people, groups, or an email address"
          placeholder="Add people, groups, or an email address"
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm text-text"
          value={picked === null ? query : picked.label}
          onChange={(event) => {
            setPicked(null);
            setQuery(event.target.value);
          }}
        />
        <select
          aria-label="Role for the new grant"
          className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-text"
          value={roleKey}
          onChange={(event) => {
            setRoleKey(event.target.value);
          }}
        >
          {roles.map((option) => (
            <option key={option.key} value={option.key}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      {picked === null && (candidates ?? []).length > 0 && (
        <ul className="max-h-40 overflow-auto rounded-md border border-border">
          {(candidates ?? []).map((candidate) => (
            <li key={principalKeyOf(candidate)}>
              <button
                type="button"
                className="w-full px-2 py-1.5 text-left text-sm text-text hover:bg-surface-hover"
                onClick={() => {
                  setPicked(candidate);
                }}
              >
                {candidate.label}
                {candidate.kind === 'group' && (
                  <span className="ml-1.5 text-xs text-text-subtle">Group</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {offerInvite && (
        <button
          type="button"
          className="rounded-md border border-dashed border-border px-2 py-1.5 text-left text-sm text-text-muted hover:bg-surface-hover"
          onClick={() => {
            setPicked(emailInvitePrincipal(query.trim()));
          }}
        >
          Invite {query.trim()} by email
        </button>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {aiState !== null && (
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            <input
              type="checkbox"
              className="size-3.5 accent-accent"
              checked={aiState.checked}
              disabled={aiState.disabled}
              onChange={(event) => {
                setCanUseAi(event.target.checked);
              }}
            />
            Use AI
            {aiState.note !== null && <span className="text-text-subtle">({aiState.note})</span>}
          </label>
        )}
        {restrictedState !== null && (
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            <input
              type="checkbox"
              className="size-3.5 accent-accent"
              checked={restrictedState.checked}
              disabled={restrictedState.disabled}
              onChange={(event) => {
                setCanViewRestricted(event.target.checked);
              }}
            />
            View restricted fields
            {restrictedState.note !== null && (
              <span className="text-text-subtle">({restrictedState.note})</span>
            )}
          </label>
        )}
      </div>

      <GrantWarningNotice warnings={warnings} />

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={picked === null || pending}>
          {warnings.some((warning) => warning.code === 'narrows') ? 'Save anyway' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
