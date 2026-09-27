import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';

/**
 * `(share)` — the public, read-only share-link viewer (doc 01 §5.1). Deliberately NOT
 * inside `(app)`: that tree's layout fetches a user session, which a link visitor does
 * not have. It gets the same client providers (query client, theme, tooltips) and
 * nothing else.
 *
 * The middleware matcher excludes `/s/` for the same reason: no `sl_presence` cookie.
 */
export default function ShareLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <div className="min-h-dvh bg-canvas">{children}</div>
    </Providers>
  );
}
