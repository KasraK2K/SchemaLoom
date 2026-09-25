import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * Placeholder. The real form arrives with the auth feature (`src/features/auth`); it
 * posts to the API through `apiFetch`, never through a Next Server Action — the API
 * already owns auth and a second hop would be a second place to re-implement it.
 */
export default function LoginPage() {
  return (
    <>
      <h1 className="text-base font-semibold text-text">Sign in</h1>
      <p className="mt-2 text-sm text-text-muted">The sign-in form is not built yet.</p>
    </>
  );
}
