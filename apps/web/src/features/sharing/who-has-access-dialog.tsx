'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Users,
} from '@schemaloom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { useTerminology } from '@/engines';
import { ApiError } from '@/lib/api-client';
import { AccessRequestsPanel } from './access-requests-panel';
import { AddGrantForm } from './add-grant-form';
import { ancestorChain, decidingOwnGrant } from './effective';
import { GrantRow } from './grant-row';
import { GrantWarningNotice } from './grant-warning-notice';
import { previewGrant, type ProposedGrant } from './grant-warnings';
import { principalKeyOf, type AccessEntry, type ToggleAtom } from './model';
import { RequestAccessButton } from './request-access-button';
import { resourceNounFor, resourceOptionLabel } from './resource-noun';
import { ShareLinksPanel } from './share-links-panel';
import {
  accessQueryKey,
  accessQueryOptions,
  createGrant,
  deleteGrant,
  updateGrant,
  type GrantWrite,
} from './sharing-api';

/**
 * "Who has access" — doc 05 §7.7's first consumer of the inverse resolver.
 *
 * Radix's `Dialog` owns the focus trap, the Escape handler, the scroll lock and
 * `aria-modal`; none of it is re-implemented here. A hand-rolled modal is how keyboard
 * users end up stranded behind an overlay, and there is nothing about sharing that needs
 * a different one.
 *
 * The one thing this dialog does that a sharing dialog usually does not: it refuses to
 * save a narrowing grant silently. See `grant-warnings.ts`.
 */

/** A change to an existing row, held back from the wire until its warning has been read. */
interface StagedChange {
  readonly entry: AccessEntry;
  readonly roleKey: string;
  readonly canUseAi: boolean;
  readonly canViewRestricted: boolean;
}

export function WhoHasAccessDialog({
  projectId,
  trigger,
}: {
  readonly projectId: string;
  readonly trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-sm text-text-muted hover:bg-surface-hover"
          >
            <Users className="size-4" aria-hidden="true" />
            Share
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogTitle>Who has access</DialogTitle>
        <DialogDescription>
          Access granted here applies to everything inside it, unless something inside has
          its own grant.
        </DialogDescription>
        {open && <AccessBody projectId={projectId} />}
      </DialogContent>
    </Dialog>
  );
}

/** Split out so the query does not run until the dialog is actually opened. */
function AccessBody({ projectId }: { readonly projectId: string }) {
  const terminology = useTerminology();
  const noun = useMemo(() => resourceNounFor(terminology), [terminology]);
  const queryClient = useQueryClient();
  const { data, isPending, isError } = useQuery(accessQueryOptions(projectId));
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedChange | null>(null);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: accessQueryKey(projectId) });
  };
  const write = useMutation({
    mutationFn: async (input: { grantId: string | null; body: GrantWrite }) => {
      if (input.grantId === null) await createGrant(projectId, input.body);
      else
        await updateGrant(input.grantId, {
          roleKey: input.body.roleKey,
          canUseAi: input.body.canUseAi,
          canViewRestricted: input.body.canViewRestricted,
        });
    },
    onSuccess: async () => {
      setStaged(null);
      await invalidate();
    },
  });
  const remove = useMutation({ mutationFn: deleteGrant, onSuccess: invalidate });

  if (isPending) return <p className="py-4 text-sm text-text-subtle">Loading…</p>;
  if (isError)
    return <p className="py-4 text-sm text-danger-text">Could not load who has access.</p>;

  const project = data.resources.find((node) => node.type === 'project');
  const scope = data.resources.find((node) => node.id === scopeId) ?? project;
  if (scope === undefined)
    return <p className="py-4 text-sm text-danger-text">This project has no access tree.</p>;

  const chain = ancestorChain(data.resources, scope);
  const proposalFor = (change: StagedChange): ProposedGrant | null => {
    const role = data.roles.find((option) => option.key === change.roleKey);
    return role === undefined
      ? null
      : {
          target: scope,
          role,
          canUseAi: change.canUseAi,
          canViewRestricted: change.canViewRestricted,
        };
  };

  /** The grant this principal holds AT the scope, if any — an update, not an insert. */
  const directGrantId = (entry: AccessEntry): string | null => {
    const deciding = decidingOwnGrant(entry, chain);
    return deciding?.resourceId === scope.id ? deciding.id : null;
  };

  const commit = (change: StagedChange) => {
    const proposal = proposalFor(change);
    if (proposal === null) return;
    write.mutate({
      grantId: directGrantId(change.entry),
      body: {
        principalKind: change.entry.principal.kind,
        principalId: change.entry.principal.id,
        resourceType: scope.type,
        resourceId: scope.id,
        roleKey: change.roleKey,
        canUseAi: change.canUseAi,
        canViewRestricted: change.canViewRestricted,
      },
    });
  };

  /**
   * A row edit goes straight to the wire UNLESS it narrows. The whole point of §7.7 is
   * that narrowing is the one outcome nobody predicts, so that one stops and asks.
   */
  const stageOrCommit = (change: StagedChange) => {
    const proposal = proposalFor(change);
    if (proposal === null) return;
    const warnings = previewGrant(change.entry, data.resources, proposal);
    if (warnings.some((warning) => warning.code === 'narrows')) setStaged(change);
    else commit(change);
  };

  const stagedProposal = staged === null ? null : proposalFor(staged);
  const failure = write.error ?? remove.error;

  return (
    <div className="mt-3 flex flex-col gap-4">
      {data.resources.length > 1 && (
        <label className="flex items-center gap-2 text-xs text-text-muted">
          Sharing
          <select
            aria-label="Resource to share"
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm text-text"
            value={scope.id}
            onChange={(event) => {
              setScopeId(event.target.value);
              setStaged(null);
            }}
          >
            {data.resources.map((node) => (
              <option key={node.id} value={node.id}>
                {resourceOptionLabel(noun, node)}
              </option>
            ))}
          </select>
        </label>
      )}

      {data.canManage ? (
        <AddGrantForm
          projectId={projectId}
          scope={scope}
          resources={data.resources}
          roles={data.roles}
          entries={data.entries}
          pending={write.isPending}
          onSubmit={(body) => {
            write.mutate({ grantId: null, body });
          }}
        />
      ) : (
        // §7.13 — any authenticated user may ask. The endpoint answers 202 whatever the
        // truth is, so this path never reveals whether the request went anywhere.
        <div className="flex flex-col gap-2 rounded-md border border-border p-2">
          <p className="text-xs text-text-muted">
            You cannot change who has access to {resourceOptionLabel(noun, scope)}.
          </p>
          <RequestAccessButton
            projectId={projectId}
            resourceType={scope.type}
            resourceId={scope.id}
            className="text-xs text-text-muted"
          />
        </div>
      )}

      {failure !== null && (
        <p role="alert" className="text-xs text-danger-text">
          {writeErrorMessage(failure)}
        </p>
      )}

      {staged !== null && stagedProposal !== null && (
        <div className="flex flex-col gap-2 rounded-md border border-warning p-2">
          <GrantWarningNotice
            warnings={previewGrant(staged.entry, data.resources, stagedProposal)}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-sm px-2 py-1 text-xs text-text-muted"
              onClick={() => {
                setStaged(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-sm bg-accent px-2 py-1 text-xs text-on-accent"
              onClick={() => {
                commit(staged);
              }}
            >
              Save anyway
            </button>
          </div>
        </div>
      )}

      <ul className="flex flex-col">
        {data.entries.map((entry) => (
          <GrantRow
            key={principalKeyOf(entry.principal)}
            entry={entry}
            scope={scope}
            resources={data.resources}
            roles={data.roles}
            noun={noun}
            readOnly={!data.canManage}
            onRoleChange={(roleKey) => {
              const deciding = decidingOwnGrant(entry, chain);
              stageOrCommit({
                entry,
                roleKey,
                canUseAi: deciding?.canUseAi ?? false,
                canViewRestricted: deciding?.canViewRestricted ?? false,
              });
            }}
            onToggle={(atom: ToggleAtom, on) => {
              const deciding = decidingOwnGrant(entry, chain);
              if (deciding === undefined) return;
              stageOrCommit({
                entry,
                roleKey: deciding.roleKey,
                canUseAi: atom === 'ai:use' ? on : deciding.canUseAi,
                canViewRestricted:
                  atom === 'field:viewRestricted' ? on : deciding.canViewRestricted,
              });
            }}
            onRemove={() => {
              const grantId = directGrantId(entry);
              if (grantId !== null) remove.mutate(grantId);
            }}
          />
        ))}
        {data.entries.length === 0 && (
          <li className="py-2 text-xs text-text-subtle">Nobody has been given access yet.</li>
        )}
      </ul>

      <ShareLinksPanel
        projectId={projectId}
        scope={scope}
        noun={noun}
        canManage={data.canManage}
      />

      {data.canManage && (
        <AccessRequestsPanel projectId={projectId} roles={data.roles} noun={noun} />
      )}
    </div>
  );
}

/** The API's own message is written for people; a few codes get a sentence of context. */
function writeErrorMessage(error: Error): string {
  if (!(error instanceof ApiError)) return 'That change could not be saved.';
  if (error.code === 'guest_invites_disabled') {
    return 'This organisation does not allow inviting people from outside it.';
  }
  if (error.code === 'guest_cannot_manage') {
    return 'People outside the organisation cannot be given sharing rights.';
  }
  if (error.code === 'invalid_email') return 'That does not look like an email address.';
  return error.message;
}
