import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-lg font-semibold text-text">Not found</h1>
      <p className="text-sm text-text-muted">
        That page does not exist, or you do not have access to it — the API does not say
        which, on purpose.
      </p>
      <Link href="/" className="rounded-sm text-sm font-medium text-accent-text underline">
        Back to your organisations
      </Link>
    </div>
  );
}
