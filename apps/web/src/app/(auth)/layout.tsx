import type { ReactNode } from 'react';
import { LogoMark } from '@/components/logo-mark';

/**
 * `(auth)` — unauthenticated. No shell, no session fetch, no Providers (doc 01 §5.1).
 * A separate group exists so this layout does not pay for the app shell's data fetch
 * on the one page a signed-out visitor actually reaches.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-panel">
        <p className="mb-6 flex items-center gap-2 text-sm font-semibold tracking-tight text-text">
          <LogoMark className="size-6" />
          SchemaLoom
        </p>
        {children}
      </div>
    </div>
  );
}
