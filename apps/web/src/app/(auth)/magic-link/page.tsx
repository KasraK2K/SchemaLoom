import type { Metadata } from 'next';
import { Suspense } from 'react';
import { MagicLinkConsumer } from '@/features/auth/magic-link-consumer';

export const metadata: Metadata = { title: 'Signing in' };

/** Suspense for `useSearchParams`, as on the sign-in page. */
export default function MagicLinkPage() {
  return (
    <>
      <h1 className="text-base font-semibold text-text">Sign-in link</h1>
      <Suspense fallback={<p className="mt-6 text-sm text-text-subtle">Loading…</p>}>
        <MagicLinkConsumer />
      </Suspense>
    </>
  );
}
