'use client';

import { Button } from '@schemaloom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import type { CreatedShareLink, ResourceNode } from './model';
import { resourceOptionLabel, type ResourceNoun } from './resource-noun';
import {
  createShareLink,
  revokeShareLink,
  shareLinksQueryKey,
  shareLinksQueryOptions,
} from './sharing-api';

/**
 * Share links — §7.12.
 *
 * Two things this panel deliberately does not have:
 *
 *  1. **A role picker.** Creation always writes the built-in `viewer` role, and R17 caps
 *     a share-link session at `schema:view` whatever the grant says. A picker offering
 *     "Editor" could only promise something the resolver takes away at the door.
 *  2. **A copy button on the list.** Only `sha256(token)` is stored, so the plaintext URL
 *     exists exactly once — in the create response. A row that offered "copy" would have
 *     to invent a URL that does not resolve.
 *
 * Links live here rather than in the grant list because revocation must go through
 * `DELETE /share-links/:id`: it clears `revokedAt` AND the grant in one transaction.
 * Deleting the grant alone leaves a token that unlocks successfully into a project where
 * every subsequent call 404s.
 */
export function ShareLinksPanel({
  projectId,
  scope,
  noun,
  canManage,
}: {
  readonly projectId: string;
  readonly scope: ResourceNode;
  readonly noun: ResourceNoun;
  readonly canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: links } = useQuery(shareLinksQueryOptions(projectId));
  const [created, setCreated] = useState<CreatedShareLink | null>(null);
  const [copied, setCopied] = useState(false);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: shareLinksQueryKey(projectId) });
  };

  const create = useMutation({
    mutationFn: (input: { expiresAt: string | null; password: string | null }) =>
      createShareLink(projectId, {
        resourceType: scope.type,
        resourceId: scope.id,
        ...input,
      }),
    onSuccess: async (result) => {
      setCreated(result);
      setCopied(false);
      await invalidate();
    },
  });

  const revoke = useMutation({
    mutationFn: revokeShareLink,
    onSuccess: invalidate,
  });

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-text">Links</h3>
      <p className="text-xs text-text-muted">
        Anyone with the link can view {resourceOptionLabel(noun, scope)}. Links are always
        view-only — they cannot comment, edit, or see who else has access.
      </p>

      {canManage && <CreateLinkForm onCreate={create.mutate} pending={create.isPending} />}

      {created !== null && (
        <div className="flex flex-col gap-1 rounded-md border border-accent-border bg-accent-subtle p-2">
          <p className="text-xs text-text-muted">
            Copy it now — this is the only time it is shown.
          </p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              aria-label="Share link"
              className="h-8 min-w-0 flex-1 rounded border border-border bg-surface px-2 font-mono text-xs text-text"
              value={created.url}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(created.url).then(
                  () => {
                    setCopied(true);
                  },
                  () => {
                    setCopied(false);
                  },
                );
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}

      <ul className="flex flex-col">
        {(links ?? []).map((link) => (
          <li
            key={link.id}
            className="flex items-center gap-2 border-b border-border py-1.5 text-sm last:border-b-0"
          >
            <span className="min-w-0 flex-1 truncate text-text">
              {resourceOptionLabel(noun, {
                type: link.resourceType,
                id: link.resourceId,
                name: link.resourceName,
                parentId: null,
              })}
            </span>
            <span className="shrink-0 text-xs text-text-subtle">
              {link.expiresAt === null ? 'No expiry' : `Expires ${link.expiresAt.slice(0, 10)}`}
              {link.hasPassword && ' · Password'}
              {` · ${String(link.useCount)} uses`}
            </span>
            <button
              type="button"
              disabled={!canManage || revoke.isPending}
              className="rounded-sm px-2 py-1 text-xs text-text-subtle hover:text-danger-text disabled:opacity-50"
              onClick={() => {
                revoke.mutate(link.id);
              }}
            >
              Revoke
            </button>
          </li>
        ))}
        {(links ?? []).length === 0 && (
          <li className="py-1.5 text-xs text-text-subtle">No links yet.</li>
        )}
      </ul>
    </section>
  );
}

/**
 * Expiry is `<input type="date">` — the platform's own picker, already localised, already
 * keyboard-accessible. Password is optional; the API hashes it with argon2id and the
 * unlock route is rate-limited, neither of which is this form's business.
 */
function CreateLinkForm({
  onCreate,
  pending,
}: {
  readonly onCreate: (input: { expiresAt: string | null; password: string | null }) => void;
  readonly pending: boolean;
}) {
  const [expiresAt, setExpiresAt] = useState('');
  const [password, setPassword] = useState('');

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    onCreate({
      expiresAt: expiresAt === '' ? null : expiresAt,
      password: password === '' ? null : password,
    });
    setExpiresAt('');
    setPassword('');
  }

  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Expires
        <input
          type="date"
          className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text"
          value={expiresAt}
          onChange={(event) => {
            setExpiresAt(event.target.value);
          }}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Password (optional)
        <input
          type="password"
          autoComplete="new-password"
          className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Create link
      </Button>
    </form>
  );
}
