'use client';

import { Button } from '@schemaloom/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { ApiError, apiFetch, apiUrl } from '@/lib/api-client';

/**
 * `/invite/[token]` — doc 05 §6.4 (R11), §12.2(b).
 *
 * The read is a plain `fetch`: the route is `@Public()` and the visitor may have no
 * session, so `apiFetch`'s refresh-then-/login dance would be wrong here. The accept is
 * `apiFetch` — it needs the CSRF echo, and a dead session there SHOULD go to /login with
 * `next` pointing back at this page.
 *
 * `signedIn` comes from the page, which reads the httpOnly `sl_presence` cookie server-side.
 */
const InviteSchema = z.object({
  organizationName: z.string(),
  email: z.string(),
  roleName: z.string().nullable(),
});
const AcceptedSchema = z.object({
  organizationId: z.string(),
  orgSlug: z.string(),
  projectId: z.string().nullable(),
});

type State =
  | { kind: 'loading' }
  | { kind: 'dead' }
  | { kind: 'ready'; invite: z.infer<typeof InviteSchema>; error: string | null; pending: boolean };

function acceptError(error: unknown, email: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'email_not_verified') {
      return `Verify ${email} first — check your inbox for the verification email, then open this link again.`;
    }
    if (error.code === 'invitation_email_mismatch') {
      return `This invitation is for ${email}. Sign in with that address to accept it.`;
    }
    if (error.status === 404) return 'This invitation is no longer valid.';
  }
  return 'Something went wrong. Try again.';
}

export function InviteAccept({ token, signedIn }: { readonly token: string; readonly signedIn: boolean }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const path = `/invitations/${encodeURIComponent(token)}`;
  const next = encodeURIComponent(`/invite/${encodeURIComponent(token)}`);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(apiUrl(path), {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }).catch(() => null);
      if (controller.signal.aborted) return;
      const parsed = response?.ok === true ? InviteSchema.safeParse(await response.json()) : null;
      setState(
        parsed?.success === true
          ? { kind: 'ready', invite: parsed.data, error: null, pending: false }
          : { kind: 'dead' },
      );
    })();
    return () => {
      controller.abort();
    };
  }, [path]);

  if (state.kind === 'loading') return <p className="text-sm text-text-subtle">Loading…</p>;
  if (state.kind === 'dead') {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-base font-semibold text-text">Invitation not found</h1>
        <p className="text-sm text-text-muted">
          This invitation has expired, was revoked, or has already been used. Ask whoever
          invited you to send a new one.
        </p>
      </div>
    );
  }

  const { invite } = state;
  const accept = async () => {
    setState({ ...state, pending: true, error: null });
    try {
      const accepted = AcceptedSchema.parse(await apiFetch<unknown>(`${path}/accept`, { method: 'POST' }));
      // Make the invited org the active one, the way the create-project form does, then a
      // FULL navigation so every Server Component renders under the new session.
      await apiFetch('/auth/switch-org', { method: 'POST', body: { organizationId: accepted.organizationId } });
      window.location.assign(
        accepted.projectId === null
          ? `/${accepted.orgSlug}`
          : `/${accepted.orgSlug}/p/${encodeURIComponent(accepted.projectId)}`,
      );
    } catch (error) {
      setState({ ...state, pending: false, error: acceptError(error, invite.email) });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-base font-semibold text-text">You’re invited to {invite.organizationName}</h1>
      <p className="text-sm text-text-muted">
        This invitation is for <span className="text-text">{invite.email}</span>
        {invite.roleName !== null && <> with the {invite.roleName} role</>}.
      </p>
      {state.error !== null && (
        <p role="alert" className="text-sm text-danger-text">
          {state.error}
        </p>
      )}
      {signedIn ? (
        <Button disabled={state.pending} onClick={() => { void accept(); }}>
          Accept invitation
        </Button>
      ) : (
        <div className="flex gap-2">
          <Button asChild>
            <Link href={`/signup?next=${next}`}>Create an account</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/login?next=${next}`}>Sign in</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
