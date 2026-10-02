'use client';

import { ORG_ROLES, type OrgRole } from '@schemaloom/contracts';
import { Button } from '@schemaloom/ui';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';
import { apiFetch } from '@/lib/api-client';
import { ROLE_LABELS } from './members-manager';
import { orgAdminMessage } from './messages';
import type { PendingInvite } from './org-settings-api';

const INPUT = 'h-8 rounded-md border border-border bg-surface px-2 text-sm text-text';

/**
 * Roadmap 16 §3 — invite someone by email with an org role, and the invites still
 * waiting. Owners and admins only (the page does not render this for anyone else); the
 * API re-checks every write, including "only owners invite owners".
 */
export function InvitesManager({
  orgSlug,
  orgRole,
  invites,
}: {
  readonly orgSlug: string;
  readonly orgRole: OrgRole;
  readonly invites: readonly PendingInvite[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('member');
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const base = `/organizations/${encodeURIComponent(orgSlug)}/invitations`;
  const choices = orgRole === 'owner' ? ORG_ROLES : ORG_ROLES.filter((r) => r !== 'owner');

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

  const invite = async (event: SyntheticEvent) => {
    event.preventDefault();
    const address = email.trim();
    await run(
      () => apiFetch(base, { method: 'POST', body: { email: address, role } }),
      `Invitation sent to ${address}.`,
    );
    setEmail('');
  };

  return (
    <section className="mt-8 flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-text">Invite people</h2>
      <p className="text-sm text-text-muted">
        They get an email with a link to create their account (or sign in) and join. The link
        works for 7 days.
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          void invite(event);
        }}
      >
        <input
          required
          type="email"
          maxLength={254}
          aria-label="Email to invite"
          placeholder="name@example.com"
          className={`${INPUT} min-w-48 flex-1`}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <select
          aria-label="Role for the invitation"
          className={INPUT}
          value={role}
          onChange={(event) => {
            setRole(event.target.value as OrgRole);
          }}
        >
          {choices.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={email.trim() === ''}>
          Send invitation
        </Button>
      </form>
      {notice !== null && (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={
            notice.error
              ? 'rounded-md border border-danger px-3 py-2 text-sm text-danger-text'
              : 'text-sm text-text-muted'
          }
        >
          {notice.text}
        </p>
      )}

      {invites.length > 0 && (
        <ul
          className="flex flex-col divide-y divide-border rounded-md border border-border"
          aria-label="Pending invitations"
        >
          {invites.map((inv) => {
            const expired = new Date(inv.expiresAt) <= new Date();
            const editable = orgRole === 'owner' || inv.role !== 'owner';
            return (
              <li key={inv.id} className="flex items-center gap-3 p-3" data-testid="org-invite">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-text">{inv.email}</p>
                  <p className="truncate text-xs text-text-muted">
                    {ROLE_LABELS[inv.role]} ·{' '}
                    {expired
                      ? 'Expired'
                      : `Expires ${new Date(inv.expiresAt).toLocaleDateString()}`}
                    {inv.invitedBy !== null && ` · invited by ${inv.invitedBy}`}
                  </p>
                </div>
                {editable && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void run(
                          () => apiFetch(`${base}/${inv.id}/resend`, { method: 'POST' }),
                          `Sent a new link to ${inv.email}.`,
                        );
                      }}
                    >
                      Resend
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        void run(
                          () => apiFetch(`${base}/${inv.id}`, { method: 'DELETE' }),
                          `Revoked the invitation for ${inv.email}.`,
                        );
                      }}
                    >
                      Revoke
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
