import { Search } from '@schemaloom/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LogoMark } from '@/components/logo-mark';
import { UserMenu } from '@/components/app-shell/user-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { NotificationsBell } from '@/features/notifications/notifications-bell';

/**
 * Server Component. The only client islands are the notifications bell, the theme
 * toggle, the account menu and, later, the command palette — the bar itself is static chrome.
 */
export function TopBar({
  breadcrumb,
  actions,
}: {
  breadcrumb?: ReactNode;
  /** Route-owned controls, right-aligned before search. The project routes put the
   *  "Who has access" dialog here. */
  actions?: ReactNode;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
      <Link
        href="/"
        className="flex shrink-0 items-center gap-2 rounded-md text-sm font-semibold tracking-tight text-text"
      >
        <LogoMark className="size-6" />
        <span className="hidden sm:inline">SchemaLoom</span>
      </Link>
      {breadcrumb !== undefined && (
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-2 text-sm text-text-muted"
        >
          <span aria-hidden="true" className="text-border-strong">
            /
          </span>
          {breadcrumb}
        </nav>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        {actions}
        {/* The command palette is not built yet; the box says where it will be. */}
        <button
          type="button"
          disabled
          className="hidden h-8 w-48 items-center gap-2 rounded-md border border-border bg-surface-sunken px-2.5 text-sm text-text-subtle xl:flex"
        >
          <Search className="size-4" aria-hidden="true" />
          Search
          <kbd className="ml-auto rounded border border-border px-1 font-mono text-[0.625rem]">
            ⌘K
          </kbd>
        </button>
        <NotificationsBell />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
