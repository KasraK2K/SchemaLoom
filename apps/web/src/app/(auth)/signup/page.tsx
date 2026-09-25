import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Create an account' };

export default function SignupPage() {
  return (
    <>
      <h1 className="text-base font-semibold text-text">Create an account</h1>
      <p className="mt-2 text-sm text-text-muted">The sign-up form is not built yet.</p>
    </>
  );
}
