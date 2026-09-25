'use client';

import { Button } from '@schemaloom/ui';

/**
 * Next requires this to be a Client Component. It renders the message and nothing
 * from the error object beyond it — a stack trace in the UI is a leak, and in
 * production Next has already redacted it to a digest anyway.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-lg font-semibold text-text">Something went wrong</h1>
      <p className="max-w-md text-sm text-text-muted">{error.message}</p>
      {error.digest !== undefined && (
        <p className="font-mono text-xs text-text-subtle">{error.digest}</p>
      )}
      <Button variant="secondary" size="sm" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
