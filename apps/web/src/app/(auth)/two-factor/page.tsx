import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TwoFactorForm } from '@/features/auth/two-factor-form';

export const metadata: Metadata = { title: 'Two-factor authentication' };

export default function TwoFactorPage() {
  return (
    <>
      <h1 className="text-base font-semibold text-text">Two-factor authentication</h1>
      <p className="mt-2 text-sm text-text-muted">One more step to sign in.</p>
      <Suspense fallback={<p className="mt-6 text-sm text-text-subtle">Loading…</p>}>
        <TwoFactorForm />
      </Suspense>
    </>
  );
}
