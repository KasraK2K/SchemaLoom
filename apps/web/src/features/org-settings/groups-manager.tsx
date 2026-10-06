'use client';

import { Button } from '@schemaloom/ui';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';
import { apiFetch } from '@/lib/api-client';
import { orgAdminMessage } from './messages';
import type { GroupView, MemberView } from './org-settings-api';

const INPUT = 'h-8 rounded-md border border-border bg-surface px-2 text-sm text-text';

/**
 * Doc 05 §3.2 user groups: create, rename, delete, add and remove members. Members of
 * the org see the list read-only; the API re-checks every write.
 */
export function GroupsManager({
  orgSlug,
  canManage,
  groups,
  members,
}: {
  readonly orgSlug: string;
  readonly canManage: boolean;
  readonly groups: readonly GroupView[];
  readonly members: readonly MemberView[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const base = `/organizations/${encodeURIComponent(orgSlug)}/groups`;

  const run = async (write: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await write();
      router.refresh();
      return true;
    } catch (caught) {
      setError(orgAdminMessage(caught));
      return false;
    }
  };

  const create = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (await run(() => apiFetch(base, { method: 'POST', body: { name: newName.trim() } })))
      setNewName('');
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
      {canManage && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            void create(event);
          }}
        >
          <input
            required
            maxLength={120}
            aria-label="New group name"
            placeholder="New group name"
            className={`${INPUT} flex-1`}
            value={newName}
            onChange={(event) => {
              setNewName(event.target.value);
            }}
          />
          <Button type="submit" size="sm" disabled={newName.trim() === ''}>
            Create group
          </Button>
        </form>
      )}
      {groups.length === 0 && <p className="text-sm text-text-subtle">No groups yet.</p>}
      <ul className="flex flex-col gap-3">
        {groups.map((group) => (
          <GroupCard
            key={group.id}
            base={base}
            group={group}
            members={members}
            canManage={canManage}
            run={run}
          />
        ))}
      </ul>
    </div>
  );
}

function GroupCard({
  base,
  group,
  members,
  canManage,
  run,
}: {
  readonly base: string;
  readonly group: GroupView;
  readonly members: readonly MemberView[];
  readonly canManage: boolean;
  readonly run: (write: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(group.name);
  const [adding, setAdding] = useState('');
  const url = `${base}/${group.id}`;
  const inGroup = new Set(group.members.map((m) => m.userId));
  const addable = members.filter((m) => !inGroup.has(m.userId));
  // Roadmap 14b §1.4: the IdP fills it, so no renaming or member edits here. It can still
  // be shared, and deleted.
  const editable = canManage && group.managedBy === null;

  return (
    <li className="rounded-md border border-border p-3" data-testid="org-group">
      <div className="flex items-center gap-2">
        {renaming ? (
          <form
            className="flex flex-1 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => apiFetch(url, { method: 'PATCH', body: { name: name.trim() } })).then(
                (ok) => {
                  if (ok) setRenaming(false);
                },
              );
            }}
          >
            <input
              required
              maxLength={120}
              aria-label="Group name"
              className={`${INPUT} flex-1`}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <Button type="submit" size="sm" disabled={name.trim() === ''}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setRenaming(false);
                setName(group.name);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <p className="flex-1 text-sm font-medium text-text">
            {group.name}
            <span className="ml-1.5 text-xs font-normal text-text-subtle">
              {group.members.length} member{group.members.length === 1 ? '' : 's'}
            </span>
            {group.managedBy !== null && (
              <span className="ml-2 rounded bg-surface-sunken px-1.5 py-0.5 text-xs font-normal text-text-muted">
                Managed by your identity provider
              </span>
            )}
          </p>
        )}
        {canManage && !renaming && (
          <>
            {editable && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRenaming(true);
                }}
              >
                Rename
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (
                  window.confirm(`Delete the group "${group.name}"? Access it grants is removed.`)
                ) {
                  void run(() => apiFetch(url, { method: 'DELETE' }));
                }
              }}
            >
              Delete
            </Button>
          </>
        )}
      </div>

      <ul className="mt-2 flex flex-col gap-1">
        {group.members.map((m) => (
          <li key={m.userId} className="flex items-center gap-2 text-sm text-text">
            <span className="min-w-0 flex-1 truncate">
              {m.name} <span className="text-xs text-text-muted">{m.email}</span>
            </span>
            {editable && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${m.name} from ${group.name}`}
                onClick={() => {
                  void run(() => apiFetch(`${url}/members/${m.userId}`, { method: 'DELETE' }));
                }}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>

      {editable && addable.length > 0 && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() =>
              apiFetch(`${url}/members`, { method: 'POST', body: { userId: adding } }),
            ).then((ok) => {
              if (ok) setAdding('');
            });
          }}
        >
          <select
            aria-label={`Add a member to ${group.name}`}
            className={`${INPUT} flex-1`}
            value={adding}
            onChange={(event) => {
              setAdding(event.target.value);
            }}
          >
            <option value="">Add a member…</option>
            {addable.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name} ({m.email})
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" disabled={adding === ''}>
            Add
          </Button>
        </form>
      )}
    </li>
  );
}
