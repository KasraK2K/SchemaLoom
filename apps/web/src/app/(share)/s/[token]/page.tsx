import type { Metadata } from 'next';
import { ShareUnlock } from '@/features/sharing/share-unlock';

// No project or org name in the title either: the visitor has not unlocked anything yet.
export const metadata: Metadata = { title: 'Shared link', robots: { index: false } };

export default async function ShareLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-panel">
        <ShareUnlock token={token} />
      </div>
    </main>
  );
}
