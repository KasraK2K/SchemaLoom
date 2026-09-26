import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthForm } from '@/features/auth/auth-form';

export const metadata: Metadata = { title: 'Create account' };

export default function SignUpPage() {
  return (
    <>
      <h1 className="text-base font-semibold text-text">Create account</h1>
      <p className="mt-2 text-sm text-text-muted">Start designing in a minute.</p>
      <Suspense fallback={<p className="mt-6 text-sm text-text-subtle">Loading…</p>}>
        <AuthForm mode="sign-up" />
      </Suspense>
    </>
  );
}
