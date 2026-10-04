'use client';

import { Button } from '@schemaloom/ui';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';
import { apiFetch } from '@/lib/api-client';
import { orgAdminMessage } from './messages';
import type { WorkspaceGrant } from './org-settings-api';

const INPUT = 'h-8 rounded-md border border-border bg-surface px-2 text-sm text-text';

interface Option {
  readonly value: string;
  readonly label: string;
}

/**
 * Roadmap 19 — one workspace's grants: a user or group gets a role on every project in it,
 * including later ones. A project's own grant for the same person still decides inside that
 * project (nearest level wins). Owners only; the api re-checks every write.
 */
export function WorkspaceSharing({
  orgSlug,
  workspace,
  grants,
  people,
  roles,
}: {
  readonly orgSlug: string;
  readonly workspace: { readonly id: string; readonly name: string };
  readonly grants: readonly WorkspaceGrant[];
  /** `user:<id>` / `group:<id>` values */
  readonly people: readonly Option[];
  readonly roles: readonly Option[];
}) {
  const router = useRouter();
  const [principal, setPrincipal] = useState('');
  const [role, setRole] = useState(roles[0]?.value ?? 'viewer');
  const [canUseAi, setCanUseAi] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const org = `/organizations/${encodeURIComponent(orgSlug)}`;

  const run = async (write: () => Promise<unknown>, done: string) => {
    setNotice(null);
    try {
      await write();
      setNotice({ error: false, text: done });
      router.refresh();
    } catch (caught) {
      setNotice({ error: true, text: orgAdminMessage(caught) });
    }
  };

  const add = async (event: SyntheticEvent) => {
    event.preventDefault();
    const [kind, id] = principal.split(':');
    if (id === undefined) return;
    const label = people.find((p) => p.value === principal)?.label ?? id;
    await run(
      () =>
        apiFetch(`${org}/workspaces/${encodeURIComponent(workspace.id)}/grants`, {
          method: 'POST',
          body: {
            principalKind: kind,
            principalId: id,
            roleKey: role,
            canUseAi,
            canViewRestricted: false,
          },
        }),
      `${label} now has this role on every project in ${workspace.name}.`,
    );
    setPrincipal('');
  };

  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-border p-4"
      aria-label={`Share ${workspace.name}`}
    >
      <h2 className="text-sm font-semibold text-text">{workspace.name}</h2>
      {grants.length === 0 ? (
        <p className="text-sm text-text-muted">
          Not shared as a workspace. Projects are shared one by one.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {grants.map((g) => (
            <li key={g.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-text">
                {g.principalName}
                {g.principalKind === 'group' && <span className="text-text-muted"> (group)</span>}
              </span>
              <span className="text-text-muted">
                {g.roleName}
                {g.canUseAi && ' · AI'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void run(
                    () =>
                      apiFetch(`${org}/workspace-grants/${encodeURIComponent(g.id)}`, {
                        method: 'DELETE',
                      }),
                    `${g.principalName} no longer gets ${workspace.name} as a workspace.`,
                  )
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => void add(e)} className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`Person or group for ${workspace.name}`}
          className={INPUT}
          value={principal}
          onChange={(e) => {
            setPrincipal(e.target.value);
          }}
        >
          <option value="">Add a person or group…</option>
          {people.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          aria-label={`Role for ${workspace.name}`}
          className={INPUT}
          value={role}
          onChange={(e) => {
            setRole(e.target.value);
          }}
        >
          {roles.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={canUseAi}
            onChange={(e) => {
              setCanUseAi(e.target.checked);
            }}
          />
          Use AI
        </label>
        <Button type="submit" size="sm" disabled={principal === ''}>
          Share
        </Button>
      </form>
      {notice !== null && (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={notice.error ? 'text-sm text-danger-text' : 'text-sm text-text-muted'}
        >
          {notice.text}
        </p>
      )}
    </section>
  );
}
