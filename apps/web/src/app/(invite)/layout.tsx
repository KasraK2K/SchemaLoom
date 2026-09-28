import type { ReactNode } from 'react';

/**
 * `(invite)` — the email-invite landing page (doc 05 §6.4). Outside `(app)`, whose layout
 * assumes a session, and outside `(auth)`, which the middleware bounces a signed-in
 * visitor away from; `/invite` is an open route in `middleware.ts` for exactly that.
 */
export default function InviteLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh bg-canvas">{children}</div>;
}
