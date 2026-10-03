'use client';

import { cn } from '@schemaloom/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  changeRequestsQueryOptions,
  projectShellQueryOptions,
} from '@/features/change-requests/change-requests-api';

/**
 * The project routes' breadcrumb: the organisation (the way back out), the project's
 * name, then the views. One component, so the five project pages cannot drift apart.
 */
export function ProjectBreadcrumb({
  orgSlug,
  projectId,
}: {
  readonly orgSlug: string;
  readonly projectId: string;
}) {
  const shell = useQuery(projectShellQueryOptions(projectId));
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Link href={`/${orgSlug}`} className="hidden truncate hover:text-text md:inline">
        {orgSlug}
      </Link>
      <span aria-hidden="true" className="hidden text-border-strong md:inline">
        /
      </span>
      <span className="max-w-48 truncate font-medium text-text">
        {shell.data?.name ?? 'Project'}
      </span>
      <ProjectTabs orgSlug={orgSlug} projectId={projectId} />
    </span>
  );
}

/**
 * Phase 4 §1.2 — "Canvas | History | Docs | Changes" in the project header, as one
 * segmented control. The web does not know the caller's atoms, so History is always
 * offered; without `history:view` the page renders the API's refusal as its "not available"
 * state.
 */
export function ProjectTabs({
  orgSlug,
  projectId,
}: {
  readonly orgSlug: string;
  readonly projectId: string;
}) {
  const pathname = usePathname();
  // The open-request count. The list is empty for anyone without a complete view, so
  // the badge never tells a partial viewer more than the Changes page would.
  const requests = useQuery(changeRequestsQueryOptions(projectId));
  const open = requests.data?.filter((r) => r.status === 'open').length ?? 0;
  const base = `/${encodeURIComponent(orgSlug)}/p/${encodeURIComponent(projectId)}`;
  const tabs = [
    { href: base, label: 'Canvas' },
    { href: `${base}/history`, label: 'History' },
    { href: `${base}/docs`, label: 'Docs' },
    { href: `${base}/changes`, label: 'Changes' },
  ];
  return (
    <nav
      aria-label="Project views"
      className="ml-1 flex items-center gap-0.5 rounded-lg border border-border bg-surface-sunken p-0.5"
    >
      {tabs.map((tab) => {
        // A request page sits under Changes, so that tab stays lit there.
        const active =
          pathname === tab.href || (tab.label === 'Changes' && pathname.startsWith(`${tab.href}/`));
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-surface-raised text-text shadow-panel'
                : 'text-text-muted hover:text-text',
            )}
          >
            {tab.label}
            {tab.label === 'Changes' && open > 0 && (
              // Hidden from the accessible name: the link is "Changes", the count is a hint.
              <span
                aria-hidden="true"
                className="rounded-full bg-accent-subtle px-1.5 text-[0.6875rem] font-semibold text-accent-text"
              >
                {open}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
