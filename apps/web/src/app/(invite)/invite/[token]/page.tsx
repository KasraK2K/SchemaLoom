import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { InviteAccept } from '@/features/sharing/invite-accept';

export const metadata: Metadata = { title: 'Invitation', robots: { index: false } };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // `sl_presence` is httpOnly, so only the server can see it. A hint for which buttons
  // to show, like in `middleware.ts`; the API decides whether the accept is allowed.
  const signedIn = (await cookies()).has('sl_presence');
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-panel">
        <InviteAccept token={token} signedIn={signedIn} />
      </div>
    </main>
  );
}
