'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { afterFirstFactor, consumeMagicLink } from './auth-api';
import { messageFor } from './auth-form';

/**
 * Spends `?token` with a POST — the email link is a GET to this page, never to the API,
 * so a mail scanner prefetching it cannot burn the single-use token.
 */
export function MagicLinkConsumer() {
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  // The token is single use, and a dev-mode double effect would spend it on the first
  // run and report "expired" on the second.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = params.get('token');
    if (!token) {
      setError('This link is missing its token. Ask for a new one.');
      return;
    }
    consumeMagicLink(token)
      .then((result) => {
        window.location.assign(afterFirstFactor(result, params.get('next')));
      })
      .catch((e: unknown) => {
        setError(messageFor(e));
      });
  }, [params]);

  if (error === null) return <p className="mt-6 text-sm text-text-muted">Signing you in…</p>;
  return (
    <div className="mt-6 flex flex-col gap-3">
      <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-text">
        {error}
      </p>
      <Link href="/login" className="text-sm text-accent-text underline underline-offset-2">
        Back to sign in
      </Link>
    </div>
  );
}
