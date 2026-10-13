'use client';

import { Button } from '@schemaloom/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { orgAdminMessage } from '@/features/org-settings/messages';
import { addGrant, listGrants, removeGrant, type Grant } from './ai-integrations-api';
import { INPUT, Message, useRun } from './use-run';

type Scope = 'everyone' | 'project' | 'member' | 'member_project';

function grantLabel(g: Grant): string {
  const project = g.projectName ?? g.projectId;
  const member = g.userName ?? g.userId;
  if (project !== null && member !== null) return `${member} in ${project}`;
  if (project !== null) return `Project: ${project}`;
  if (member !== null) return `Member: ${member}`;
  return 'Everyone';
}

/** Who may use one org integration: everyone, a project, a member, or a member in a project. */
export function GrantsEditor({
  orgSlug,
  integrationId,
  members,
  projects,
}: {
  readonly orgSlug: string;
  readonly integrationId: string;
  readonly members: readonly { id: string; label: string }[];
  readonly projects: readonly { id: string; name: string }[];
}) {
  const queryKey = ['ai-grants', orgSlug, integrationId];
  const queryClient = useQueryClient();
  const grants = useQuery({ queryKey, queryFn: () => listGrants(orgSlug, integrationId) });
  const { busy, message, run } = useRun(() => queryClient.invalidateQueries({ queryKey }));
  const [scope, setScope] = useState<Scope>('everyone');
  const [projectId, setProjectId] = useState('');
  const [userId, setUserId] = useState('');
  const needsProject = scope === 'project' || scope === 'member_project';
  const needsMember = scope === 'member' || scope === 'member_project';

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    void run(async () => {
      await addGrant(orgSlug, integrationId, {
        projectId: needsProject ? projectId : null,
        userId: needsMember ? userId : null,
      });
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <h3 className="text-xs font-semibold text-text">Who can use it</h3>
      {grants.isPending ? (
        <p className="text-sm text-text-subtle">Loading…</p>
      ) : grants.isError ? (
        <p role="alert" className="text-sm text-danger-text">
          {orgAdminMessage(grants.error)}
        </p>
      ) : grants.data.length === 0 ? (
        <p className="text-sm text-text-muted">
          Nobody yet. Add access so people can pick this integration.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {grants.data.map((g) => (
            <li key={g.id} className="flex items-center gap-2 text-sm text-text">
              <span>{grantLabel(g)}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={`Remove ${grantLabel(g)}`}
                onClick={() => {
                  void run(() => removeGrant(orgSlug, integrationId, g.id));
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex flex-wrap gap-2" onSubmit={onSubmit}>
        <select
          aria-label="Grant scope"
          className={INPUT}
          value={scope}
          onChange={(e) => {
            setScope(e.target.value as Scope);
          }}
        >
          <option value="everyone">Everyone</option>
          <option value="project">Project</option>
          <option value="member">Member</option>
          <option value="member_project">Member in project</option>
        </select>
        {needsProject && (
          <select
            required
            aria-label="Project"
            className={INPUT}
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
            }}
          >
            <option value="">Choose a project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {needsMember && (
          <select
            required
            aria-label="Member"
            className={INPUT}
            value={userId}
            onChange={(e) => {
              setUserId(e.target.value);
            }}
          >
            <option value="">Choose a member</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
        <Button type="submit" size="sm" disabled={busy}>
          Add access
        </Button>
      </form>
      <Message message={message} />
    </div>
  );
}
