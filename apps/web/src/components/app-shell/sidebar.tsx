import { Database, ScrollArea, type LucideIcon } from '@schemaloom/ui';
import Link from 'next/link';
import { SidebarFrame } from './sidebar-frame';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Server Component: the list is rendered from server data (doc 01 §5.2). Filtering and
 * reordering become a client island under it when there is anything to filter.
 *
 * `orgLabel` is the organisation the visitor is currently inside. Without it the sidebar
 * looks identical in every org, which is the kind of ambiguity that gets someone editing
 * the wrong schema.
 */
export function Sidebar({ items, orgLabel }: { items: readonly NavItem[]; orgLabel?: string }) {
  return (
    <SidebarFrame>
      <ScrollArea className="h-full theme-float:h-auto">
        {orgLabel !== undefined && (
          <div className="mx-2 mt-1 flex items-center gap-2.5 rounded-lg border border-border bg-surface-raised px-2 py-1.5 group-data-[collapsed=true]/sidebar:hidden">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-subtle text-xs font-semibold text-accent-text"
            >
              {orgLabel.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 truncate text-sm font-medium text-text">{orgLabel}</span>
          </div>
        )}
        <ul className="flex flex-col gap-0.5 p-2">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                title={item.label}
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium text-text-muted transition-colors group-data-[collapsed=true]/sidebar:justify-center hover:bg-surface-hover hover:text-text"
              >
                <item.icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate group-data-[collapsed=true]/sidebar:sr-only">
                  {item.label}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </SidebarFrame>
  );
}

/**
 * ONE entry, and the reason is that only one org route exists.
 *
 * This used to list Overview → `/:org`, Projects → `/:org/w/default`, Members and
 * Settings. Three of those four had no page behind them, and `/w/default` never existed
 * at all — a sidebar whose links 404 is the same dead end as a sidebar with no links,
 * plus the false promise. `/:org` IS the project list, so "Overview" and "Projects" were
 * always going to resolve to the same page.
 *
 * Add a row back when its route lands, not before.
 */
export function orgNavItems(orgSlug: string): readonly NavItem[] {
  return [{ href: `/${orgSlug}`, label: 'Projects', icon: Database }];
}

export type { NavItem };
