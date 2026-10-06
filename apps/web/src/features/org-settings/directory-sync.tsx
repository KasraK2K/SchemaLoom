'use client';

import { Button } from '@schemaloom/ui';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';
import { apiFetch } from '@/lib/api-client';
import { orgAdminMessage } from './messages';
import type { GroupView, SsoConnection } from './org-settings-api';

const INPUT = 'h-8 rounded-md border border-border bg-surface px-2 text-sm text-text';

const when = (iso: string | null): string =>
  iso === null ? 'never' : new Date(iso).toLocaleString();

/**
 * Roadmap 14b (`docs/phase14/DIRECTORY-SYNC.md` §1.1, §2) — one connection's directory sync:
 * the SCIM token (shown once, one live at a time) and the groups-claim mappings.
 */
export function DirectorySync({
  base,
  connection,
  groups,
}: {
  /** `/organizations/:slug/sso-connections/:id` */
  readonly base: string;
  readonly connection: SsoConnection;
  readonly groups: readonly GroupView[];
}) {
  const router = useRouter();
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimValue, setClaimValue] = useState('');
  const [groupId, setGroupId] = useState('');
  const { scim, groupMappings } = connection;
  // One source per group (D4): a SCIM group can't also come from a claim.
  const mappable = groups.filter((g) => g.managedBy !== 'scim');

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

  const generate = () =>
    run(async () => {
      const token = await apiFetch<{ secret: string }>(`${base}/scim-token`, { method: 'POST' });
      setSecret(token.secret);
    });

  const addMapping = async (event: SyntheticEvent) => {
    event.preventDefault();
    const ok = await run(() =>
      apiFetch(`${base}/group-mappings`, {
        method: 'POST',
        body: { claimValue: claimValue.trim(), groupId },
      }),
    );
    if (ok) {
      setClaimValue('');
      setGroupId('');
    }
  };

  return (
    <section
      aria-label={`Directory sync for ${connection.name}`}
      className="mt-2 flex flex-col gap-3 border-t border-border pt-3"
    >
      <h3 className="text-sm font-medium text-text">Directory sync</h3>
      {error !== null && (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2 text-xs">
        <p className="text-text-muted">
          SCIM base URL{' '}
          <span className="font-mono break-all text-text">{connection.scimBaseUrl}</span>
        </p>
        {secret !== null && (
          <label className="flex flex-col gap-1 text-text">
            <span>Copy the token now; it is not shown again.</span>
            <input
              readOnly
              aria-label="SCIM token"
              className={`${INPUT} font-mono`}
              value={secret}
              onFocus={(e) => {
                e.target.select();
              }}
            />
          </label>
        )}
        <div className="flex items-center gap-2">
          <span className="flex-1 text-text-muted">
            {scim === null
              ? 'No SCIM token. Your identity provider cannot provision people yet.'
              : `Token ${scim.prefix}… created ${when(scim.createdAt)}, last used ${when(scim.lastUsedAt)}`}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void generate()}>
            {scim === null ? 'Generate SCIM token' : 'Regenerate'}
          </Button>
          {scim !== null && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (
                  window.confirm(
                    'Revoke the SCIM token? Provisioning stops until you generate a new one.',
                  )
                ) {
                  setSecret(null);
                  void run(() => apiFetch(`${base}/scim-token`, { method: 'DELETE' }));
                }
              }}
            >
              Revoke
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 text-xs">
        <p className="text-text-muted">
          {connection.groupsClaim === null
            ? 'Group mappings fill groups from a claim at sign-in. Set a groups claim on the connection to use them.'
            : `At every sign-in, people join the mapped groups their "${connection.groupsClaim}" claim lists, and leave the others.`}
        </p>
        {groupMappings.length > 0 && (
          <ul className="flex flex-col gap-1">
            {groupMappings.map((m) => (
              <li key={m.id} className="flex items-center gap-2 text-sm text-text">
                <span className="flex-1">
                  <span className="font-mono">{m.claimValue}</span> → {m.groupName}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove the mapping ${m.claimValue}`}
                  onClick={() => {
                    void run(() =>
                      apiFetch(`${base}/group-mappings/${m.id}`, { method: 'DELETE' }),
                    );
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form className="flex gap-2" onSubmit={(e) => void addMapping(e)}>
          <input
            required
            maxLength={300}
            aria-label="Claim value"
            placeholder="Claim value, e.g. data-team"
            className={`${INPUT} flex-1`}
            value={claimValue}
            onChange={(e) => {
              setClaimValue(e.target.value);
            }}
          />
          <select
            required
            aria-label="Group"
            className={`${INPUT} flex-1`}
            value={groupId}
            onChange={(e) => {
              setGroupId(e.target.value);
            }}
          >
            <option value="">Group…</option>
            {mappable.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" disabled={claimValue.trim() === '' || groupId === ''}>
            Add mapping
          </Button>
        </form>
      </div>
    </section>
  );
}
