import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthForm } from '@/features/auth/auth-form';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * `AuthForm` reads `?next=` with `useSearchParams`, which Next requires to sit under a
 * Suspense boundary or the whole route opts out of static rendering with a build error.
 */
export default function LoginPage() {
  return (
    <>
      <h1 className="text-base font-semibold text-text">Sign in</h1>
      <p className="mt-2 text-sm text-text-muted">Welcome back.</p>
      <Suspense fallback={<p className="mt-6 text-sm text-text-subtle">Loading…</p>}>
        <AuthForm mode="sign-in" />
      </Suspense>
    </>
  );
}
