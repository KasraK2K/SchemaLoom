import type { Metadata } from 'next';
import { InviteAccept } from '@/features/sharing/invite-accept';

export const metadata: Metadata = { title: 'Invitation', robots: { index: false } };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-panel">
        <InviteAccept token={token} />
      </div>
    </main>
  );
}
