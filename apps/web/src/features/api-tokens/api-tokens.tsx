'use client';

import { Button } from '@schemaloom/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/lib/api-client';

/**
 * Phase 11 §6 (docs/phase11/DESIGN.md) — API tokens for the CLI. Created from a project's
 * settings (the project is the token's whole scope), listed and revoked on the account
 * page; people who manage sharing also see and revoke everyone's tokens on the project.
 */

const TokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  owner: z.object({ id: z.string(), name: z.string(), email: z.string() }).optional(),
});
type ApiToken = z.infer<typeof TokenSchema>;
const CreatedSchema = TokenSchema.extend({ secret: z.string() });

const mineKey = ['api-tokens', 'mine'] as const;
const projectKey = (projectId: string) => ['api-tokens', 'project', projectId] as const;

async function listMine(): Promise<ApiToken[]> {
  return z.array(TokenSchema).parse(await apiFetch<unknown>('/me/api-tokens'));
}

/** Managers get everyone's; anyone else gets their own on this project. */
async function listForProject(projectId: string): Promise<ApiToken[]> {
  try {
    return z
      .array(TokenSchema)
      .parse(await apiFetch<unknown>(`/projects/${encodeURIComponent(projectId)}/api-tokens`));
  } catch (caught) {
    if (!(caught instanceof ApiError && (caught.status === 403 || caught.status === 404))) {
      throw caught;
    }
    return (await listMine()).filter((t) => t.projectId === projectId);
  }
}

const revokeToken = (id: string) =>
  apiFetch<unknown>(`/api-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });

const day = (iso: string) => new Date(iso).toLocaleDateString();

function TokenList({
  tokens,
  showProject,
  onRevoked,
}: {
  readonly tokens: readonly ApiToken[];
  readonly showProject: boolean;
  readonly onRevoked: () => Promise<unknown>;
}) {
  const [error, setError] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: revokeToken,
    onSuccess: onRevoked,
    onError: () => {
      setError('Could not revoke the token. Try again.');
    },
  });
  if (tokens.length === 0) return <p className="text-xs text-text-subtle">No tokens.</p>;
  return (
    <>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {tokens.map((token) => (
          <li key={token.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-text">
                {token.name}{' '}
                <code className="font-mono text-xs text-text-muted">slt_{token.prefix}…</code>
              </span>
              <span className="text-xs text-text-muted">
                {[
                  showProject ? token.projectName : null,
                  token.owner?.name ?? null,
                  token.scopes.join(' + '),
                  `expires ${day(token.expiresAt)}`,
                  token.lastUsedAt === null ? 'never used' : `last used ${day(token.lastUsedAt)}`,
                ]
                  .filter((part) => part !== null)
                  .join(' · ')}
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={revoke.isPending}
              onClick={() => {
                setError(null);
                revoke.mutate(token.id);
              }}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      {error !== null && <p className="text-xs text-danger-text">{error}</p>}
    </>
  );
}

/** Account page: every token you hold, on any project. */
export function AccountApiTokens() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: mineKey, queryFn: listMine });
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold text-text">API tokens</h2>
      <p className="text-sm text-text-muted">
        For the <code className="font-mono">schemaloom</code> CLI and CI. Create one from a
        project’s Settings; a token acts as you, on that project only.
      </p>
      {query.data === undefined ? (
        <p className="text-sm text-text-subtle">
          {query.isError ? 'Could not load your tokens.' : 'Loading…'}
        </p>
      ) : (
        <TokenList
          tokens={query.data}
          showProject
          onRevoked={() => client.invalidateQueries({ queryKey: ['api-tokens'] })}
        />
      )}
    </section>
  );
}

const EXPIRY_DAYS = [30, 90, 180, 365] as const;

/** Project settings: create a token for this project, and see the project's tokens. */
export function ProjectApiTokens({ projectId }: { readonly projectId: string }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: projectKey(projectId),
    queryFn: () => listForProject(projectId),
    retry: false,
  });
  const [name, setName] = useState('');
  const [drift, setDrift] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<number>(90);
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () =>
      CreatedSchema.parse(
        await apiFetch<unknown>(`/projects/${encodeURIComponent(projectId)}/api-tokens`, {
          method: 'POST',
          body: { name: name.trim(), scopes: drift ? ['read', 'drift'] : ['read'], expiresInDays },
        }),
      ),
    onSuccess: async (created) => {
      setSecret(created.secret);
      setName('');
      await client.invalidateQueries({ queryKey: ['api-tokens'] });
    },
  });
  const createError =
    create.error === null
      ? null
      : create.error instanceof ApiError && create.error.status === 403
        ? 'Check drift needs edit access to this project.'
        : 'Could not create the token. Try again.';

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm text-text">API tokens</legend>
      <p className="text-xs text-text-muted">
        For the <code className="font-mono">schemaloom</code> CLI and CI: pull the design, or
        check the saved connection for drift. A token acts as you, on this project only.
      </p>
      {secret !== null && (
        <div role="status" className="flex flex-col gap-1 rounded-md border border-border p-2">
          <span className="text-xs text-text">Copy it now. It won’t be shown again.</span>
          <code className="font-mono text-xs break-all text-text">{secret}</code>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(secret);
              }}
            >
              Copy
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setSecret(null);
              }}
            >
              Done
            </Button>
          </div>
        </div>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '') create.mutate();
        }}
      >
        <label className="flex flex-col gap-1 text-sm text-text">
          Name
          <input
            className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text"
            value={name}
            maxLength={100}
            placeholder="GitHub Actions"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            className="size-3.5 accent-accent"
            checked={drift}
            onChange={(event) => {
              setDrift(event.target.checked);
            }}
          />
          Can also check drift against the saved connection
        </label>
        <label className="flex items-center gap-2 text-sm text-text">
          Expires after
          <select
            className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text"
            value={expiresInDays}
            onChange={(event) => {
              setExpiresInDays(Number(event.target.value));
            }}
          >
            {EXPIRY_DAYS.map((days) => (
              <option key={days} value={days}>
                {days} days
              </option>
            ))}
          </select>
        </label>
        {createError !== null && <p className="text-xs text-danger-text">{createError}</p>}
        <div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={create.isPending || name.trim() === ''}
          >
            Create token
          </Button>
        </div>
      </form>
      {query.data !== undefined && (
        <TokenList
          tokens={query.data}
          showProject={false}
          onRevoked={() => client.invalidateQueries({ queryKey: ['api-tokens'] })}
        />
      )}
    </fieldset>
  );
}
