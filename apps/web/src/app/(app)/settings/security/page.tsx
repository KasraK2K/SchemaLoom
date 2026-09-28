import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell/app-shell';
import { SecuritySettings } from '@/features/auth/security-settings';
import { NotificationPrefsSection } from '@/features/notifications/notification-prefs';

export const metadata: Metadata = { title: 'Account' };

/**
 * Account-level, not org-level: 2FA, devices and notification emails belong to the user,
 * whichever org is active. Renamed "Account" in Phase 4; the URL stays `/settings/security`.
 */
export default function SecuritySettingsPage() {
  return (
    <AppShell nav={[]}>
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="mb-8 text-lg font-semibold text-text">Account</h1>
        <div className="flex flex-col gap-10">
          <SecuritySettings />
          <NotificationPrefsSection />
        </div>
      </div>
    </AppShell>
  );
}
