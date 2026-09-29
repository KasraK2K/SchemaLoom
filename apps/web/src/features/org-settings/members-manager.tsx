'use client';

import { ORG_ROLES, type OrgRole } from '@schemaloom/contracts';
import { Button } from '@schemaloom/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { orgAdminMessage } from './messages';
import type { MemberView } from './org-settings-api';

const ROLE_LABELS: Record<OrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
};

/**
 * Doc 05 §3.2 org members. The API applies every rule (owner/admin only, owners for
 * owners, never the last owner); the controls here only hide what the caller's role can
 * never do, and a refusal is shown as a sentence. After a write the Server Component
 * re-renders, so the list is always the API's.
 */
export function MembersManager({
  orgSlug,
  orgRole,
  members,
}: {
  readonly orgSlug: string;
  readonly orgRole: OrgRole;
  readonly members: readonly MemberView[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const manages = orgRole === 'owner' || orgRole === 'admin';
  const base = `/organizations/${encodeURIComponent(orgSlug)}/members`;

  const run = async (write: () => Promise<unknown>) => {
    setError(null);
    try {
      await write();
      router.refresh();
    } catch (caught) {
      setError(orgAdminMessage(caught));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error !== null && (
        <p
          role="alert"
          className="rounded-md border border-danger px-3 py-2 text-sm text-danger-text"
        >
          {error}
        </p>
      )}
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {members.map((member) => {
          // An admin can never touch an owner; the API says so too.
          const editable = manages && (orgRole === 'owner' || member.role !== 'owner');
          const choices = orgRole === 'owner' ? ORG_ROLES : ORG_ROLES.filter((r) => r !== 'owner');
          return (
            <li
              key={member.userId}
              className="flex items-center gap-3 p-3"
              data-testid="org-member"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text">{member.name}</p>
                <p className="truncate text-xs text-text-muted">{member.email}</p>
              </div>
              {editable ? (
                <>
                  <select
                    aria-label={`Role of ${member.name}`}
                    className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text"
                    value={member.role}
                    onChange={(event) => {
                      const role = event.target.value as OrgRole;
                      void run(() =>
                        apiFetch(`${base}/${member.userId}`, { method: 'PATCH', body: { role } }),
                      );
                    }}
                  >
                    {choices.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove ${member.name} from the organisation? Their grants stop working immediately.`,
                        )
                      ) {
                        void run(() => apiFetch(`${base}/${member.userId}`, { method: 'DELETE' }));
                      }
                    }}
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <span className="text-sm text-text-muted">{ROLE_LABELS[member.role]}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
