import { Database, LayoutGrid, ScrollArea, Settings, Users, type LucideIcon } from '@schemaloom/ui';
import Link from 'next/link';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Server Component: the list is rendered from server data (doc 01 §5.2). Filtering and
 * reordering become a client island under it when there is anything to filter.
 */
export function Sidebar({ items }: { items: readonly NavItem[] }) {
  return (
    <nav
      aria-label="Primary"
      className="hidden w-60 shrink-0 border-r border-border bg-surface md:block"
    >
      <ScrollArea className="h-full">
        <ul className="flex flex-col gap-0.5 p-2">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
              >
                <item.icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </nav>
  );
}

export function orgNavItems(orgSlug: string): readonly NavItem[] {
  return [
    { href: `/${orgSlug}`, label: 'Overview', icon: LayoutGrid },
    { href: `/${orgSlug}/w/default`, label: 'Projects', icon: Database },
    { href: `/${orgSlug}/settings/members`, label: 'Members', icon: Users },
    { href: `/${orgSlug}/settings/general`, label: 'Settings', icon: Settings },
  ];
}

export type { NavItem };
