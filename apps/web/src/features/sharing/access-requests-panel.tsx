'use client';

import { Button } from '@schemaloom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { RoleOption } from './model';
import { resourceOptionLabel, type ResourceNoun } from './resource-noun';
import {
  accessRequestsQueryKey,
  accessRequestsQueryOptions,
  approveAccessRequest,
  denyAccessRequest,
} from './sharing-api';

/**
 * The manager half of §7.13. Approval is an ordinary grant write and therefore subject to
 * R4 attenuation — an approver cannot grant more than they hold — so the role list here
 * is the same `roles` the dialog already filtered, and the API re-checks it anyway.
 *
 * `canUseAi` and `canViewRestricted` are never set by an approval: §7.13 makes turning
 * either on a deliberate, separate act, which is why this panel has no toggles.
 */
export function AccessRequestsPanel({
  projectId,
  roles,
  noun,
}: {
  readonly projectId: string;
  readonly roles: readonly RoleOption[];
  readonly noun: ResourceNoun;
}) {
  const queryClient = useQueryClient();
  const { data: requests } = useQuery(accessRequestsQueryOptions(projectId));
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: accessRequestsQueryKey(projectId) });
  };

  const approve = useMutation({
    mutationFn: (input: { id: string; roleKey: string }) =>
      approveAccessRequest(input.id, input.roleKey),
    onSuccess: invalidate,
  });
  const deny = useMutation({
    mutationFn: (id: string) => denyAccessRequest(id, null),
    onSuccess: invalidate,
  });

  if ((requests ?? []).length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-text">Requests</h3>
      <ul className="flex flex-col">
        {(requests ?? []).map((request) => (
          <RequestRow
            key={request.id}
            defaultRoleKey={request.requestedRoleKey ?? roles[0]?.key ?? ''}
            roles={roles}
            pending={approve.isPending || deny.isPending}
            label={request.requesterLabel}
            detail={`${resourceOptionLabel(noun, {
              type: request.resourceType,
              id: request.resourceId,
              name: request.resourceName,
              parentId: null,
            })}${request.message === null ? '' : ` — “${request.message}”`}`}
            onApprove={(roleKey) => {
              approve.mutate({ id: request.id, roleKey });
            }}
            onDeny={() => {
              deny.mutate(request.id);
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function RequestRow({
  label,
  detail,
  roles,
  defaultRoleKey,
  pending,
  onApprove,
  onDeny,
}: {
  readonly label: string;
  readonly detail: string;
  readonly roles: readonly RoleOption[];
  readonly defaultRoleKey: string;
  readonly pending: boolean;
  readonly onApprove: (roleKey: string) => void;
  readonly onDeny: () => void;
}) {
  const [roleKey, setRoleKey] = useState(defaultRoleKey);
  return (
    <li className="flex items-center gap-2 border-b border-border py-1.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text">{label}</p>
        <p className="truncate text-xs text-text-subtle">{detail}</p>
      </div>
      <select
        aria-label={`Role to grant ${label}`}
        className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text"
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
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          onApprove(roleKey);
        }}
      >
        Approve
      </Button>
      <button
        type="button"
        disabled={pending}
        className="rounded-sm px-2 py-1 text-xs text-text-subtle hover:text-danger-text disabled:opacity-50"
        onClick={onDeny}
      >
        Deny
      </button>
    </li>
  );
}
