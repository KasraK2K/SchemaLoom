'use client';

import { Button } from '@schemaloom/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useId, useState, type SyntheticEvent } from 'react';
import { safeNextPath, verifyTwoFactor } from './auth-api';
import { messageFor } from './auth-form';

/** The second half of a 2FA sign-in. The challenge is an httpOnly cookie the API set. */
export function TwoFactorForm() {
  const params = useSearchParams();
  const id = useId();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await verifyTwoFactor(code.trim());
      // Full navigation for the same reason as the sign-in form: middleware must see
      // the `sl_presence` cookie the API just set.
      window.location.assign(safeNextPath(params.get('next')));
    } catch (e) {
      setError(messageFor(e));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-6 flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-text">
          Code
        </label>
        <input
          id={id}
          value={code}
          onChange={(e) => { setCode(e.target.value); }}
          autoComplete="one-time-code"
          autoFocus
          aria-describedby={`${id}-hint`}
          className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text"
        />
        <p id={`${id}-hint`} className="text-xs text-text-muted">
          The 6-digit code from your authenticator app, or one of your recovery codes.
        </p>
      </div>
      {error !== null && (
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-text">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || code.trim() === ''}>
        {busy ? 'Checking…' : 'Verify'}
      </Button>
      <Link href="/login" className="text-sm text-accent-text underline underline-offset-2">
        Start over
      </Link>
    </form>
  );
}
