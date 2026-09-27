'use client';

import { Button } from '@schemaloom/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiUrl } from '@/lib/api-client';

/**
 * `/s/[token]` — doc 05 §7.12 steps 1-3.
 *
 * Plain `fetch`, not `apiFetch`: a wrong password is a 401, and `apiFetch` answers a 401
 * by trying to refresh a user session this visitor does not have and then sending them
 * to /login. Neither request needs a CSRF echo — both routes are `@Public()`, and the
 * API exempts the unlock path explicitly.
 *
 * The page names nothing: no project, no org, no resource. Until the cookie exists the
 * visitor has proved nothing, and a name is a disclosure (§12.2 step 2).
 */
type State =
  | { kind: 'checking' }
  | { kind: 'dead' }
  | { kind: 'password'; error: string | null; pending: boolean };

export function ShareUnlock({ token }: { readonly token: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [password, setPassword] = useState('');

  const path = `/s/${encodeURIComponent(token)}`;

  async function unlock(withPassword: string | null): Promise<void> {
    const response = await fetch(apiUrl(`${path}/unlock`), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password: withPassword }),
    });
    if (response.ok) {
      const { projectId } = (await response.json()) as { projectId: string };
      router.replace(`${path}/p/${encodeURIComponent(projectId)}`);
      return;
    }
    if (response.status === 401 || response.status === 429) {
      setState({
        kind: 'password',
        pending: false,
        error:
          response.status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : 'That password did not work.',
      });
      return;
    }
    setState({ kind: 'dead' });
  }

  useEffect(() => {
    // Aborted on unmount (and on React's dev double-mount), so a stale check never
    // overwrites the state of the one that is still mounted.
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(apiUrl(path), {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }).catch(() => null);
      if (controller.signal.aborted) return;
      if (response?.ok !== true) {
        setState({ kind: 'dead' });
        return;
      }
      const { needsPassword } = (await response.json()) as { needsPassword: boolean };
      if (needsPassword) setState({ kind: 'password', error: null, pending: false });
      else await unlock(null);
    })();
    return () => {
      controller.abort();
    };
  }, [path]);

  if (state.kind === 'checking') {
    return <p className="text-sm text-text-subtle">Opening the shared link…</p>;
  }
  if (state.kind === 'dead') {
    return (
      <>
        <h1 className="text-base font-semibold text-text">This link is not available</h1>
        <p className="mt-2 text-sm text-text-muted">
          Ask the person who shared it to send you a new one.
        </p>
      </>
    );
  }

  const onSubmit = (event: { preventDefault(): void }) => {
    event.preventDefault();
    setState({ kind: 'password', error: null, pending: true });
    void unlock(password);
  };

  return (
    <>
      <h1 className="text-base font-semibold text-text">This link is password-protected</h1>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="share-password" className="text-sm font-medium text-text">
            Password
          </label>
          <input
            id="share-password"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            aria-invalid={state.error !== null}
            aria-describedby={state.error === null ? undefined : 'share-password-error'}
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text"
          />
        </div>
        {state.error !== null && (
          <p
            id="share-password-error"
            role="alert"
            className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-text"
          >
            {state.error}
          </p>
        )}
        <Button type="submit" disabled={state.pending || password === ''}>
          {state.pending ? 'Checking…' : 'Open'}
        </Button>
      </form>
    </>
  );
}
