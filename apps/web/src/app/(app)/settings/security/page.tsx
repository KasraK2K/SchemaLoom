import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell/app-shell';
import { SecuritySettings } from '@/features/auth/security-settings';

export const metadata: Metadata = { title: 'Security' };

/** Account-level, not org-level: 2FA and devices belong to the user, whichever org is active. */
export default function SecuritySettingsPage() {
  return (
    <AppShell nav={[]}>
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="mb-8 text-lg font-semibold text-text">Security</h1>
        <SecuritySettings />
      </div>
    </AppShell>
  );
}
