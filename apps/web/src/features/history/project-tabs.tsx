'use client';

import { cn } from '@schemaloom/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Phase 4 §1.2 — "Canvas | History | Docs" in the project header. The web does not know the
 * caller's atoms, so History is always offered; without `history:view` the page renders
 * the API's refusal as its "not available" state.
 */
export function ProjectTabs({ orgSlug, projectId }: { readonly orgSlug: string; readonly projectId: string }) {
  const pathname = usePathname();
  const base = `/${encodeURIComponent(orgSlug)}/p/${encodeURIComponent(projectId)}`;
  const tabs = [
    { href: base, label: 'Canvas' },
    { href: `${base}/history`, label: 'History' },
    { href: `${base}/docs`, label: 'Docs' },
  ];
  return (
    <nav aria-label="Project views" className="flex items-center gap-1">
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded px-2 py-0.5 text-xs',
              active ? 'bg-surface-sunken text-text' : 'text-text-muted hover:text-text',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
