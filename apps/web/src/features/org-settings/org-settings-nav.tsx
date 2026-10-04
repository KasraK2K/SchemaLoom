import type { OrgRole } from '@schemaloom/contracts';
import Link from 'next/link';

/** Tabs between the org settings pages. Roles and the audit log are owner/admin only. */
export function OrgSettingsNav({
  orgSlug,
  orgRole,
  current,
}: {
  readonly orgSlug: string;
  readonly orgRole: OrgRole;
  readonly current: 'members' | 'groups' | 'workspaces' | 'roles' | 'audit-log' | 'sso';
}) {
  const tabs = [
    { key: 'members', label: 'Members' },
    { key: 'groups', label: 'Groups' },
    ...(orgRole === 'owner' || orgRole === 'admin'
      ? [
          { key: 'roles', label: 'Roles' },
          { key: 'audit-log', label: 'Audit log' },
        ]
      : []),
    ...(orgRole === 'owner'
      ? [
          { key: 'workspaces', label: 'Workspaces' },
          { key: 'sso', label: 'Single sign-on' },
        ]
      : []),
  ] as const;
  return (
    <nav
      aria-label="Organisation settings"
      className="mb-6 flex gap-4 border-b border-border text-sm"
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={`/${orgSlug}/settings/${tab.key}`}
          aria-current={tab.key === current ? 'page' : undefined}
          className={
            tab.key === current
              ? '-mb-px border-b-2 border-accent pb-2 text-text'
              : 'pb-2 text-text-muted hover:text-text'
          }
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
