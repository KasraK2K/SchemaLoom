import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/theme-provider';

/**
 * `(invite)` — the email-invite landing page (doc 05 §6.4). Outside `(app)`, whose layout
 * assumes a session, and outside `(auth)`, which the middleware bounces a signed-in
 * visitor away from; `/invite` is an open route in `middleware.ts` for exactly that.
 *
 * Only the theme provider, not `Providers`: a new member signs up and lands here first, so
 * this is where the account's look (the org's default, for a new one) has to be adopted. A
 * signed-out visitor keeps the stored look.
 */
export default function InviteLayout({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <div className="min-h-dvh bg-canvas">{children}</div>
    </ThemeProvider>
  );
}
