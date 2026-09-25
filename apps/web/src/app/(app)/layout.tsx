import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';

/**
 * `(app)` — the authenticated tree. Server Component, and the single place a session
 * is fetched server-side once `src/lib/server-api.ts` exists (doc 01 §5.1/§5.2): it
 * forwards the incoming Cookie header so the first paint needs no client waterfall.
 *
 * It does NOT fetch the IR. That belongs to the canvas route's own query
 * (doc 01 §5.2) — dehydrating a 300-entity model into this layout would inline
 * megabytes into the flight payload of every navigation, including /settings.
 *
 * `<Providers>` sits here rather than in the root layout so the `(auth)` group stays
 * a pure Server Component tree with no query client and no theme context.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
