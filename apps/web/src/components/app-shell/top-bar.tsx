import { Button, Search } from '@schemaloom/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';

/**
 * Server Component. The only client islands are the theme toggle and, later, the
 * command palette — the bar itself is static chrome.
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
      <Link href="/" className="rounded-sm text-sm font-semibold tracking-tight text-text">
        SchemaLoom
      </Link>
      {breadcrumb !== undefined && (
        <nav aria-label="Breadcrumb" className="min-w-0 text-sm text-text-muted">
          {breadcrumb}
        </nav>
      )}
      <div className="ml-auto flex items-center gap-1">
        {actions}
        <Button variant="ghost" size="sm" className="gap-2 text-text-muted" disabled>
          <Search className="size-4" aria-hidden="true" />
          Search
          <kbd className="rounded border border-border px-1 font-mono text-[0.625rem]">⌘K</kbd>
        </Button>
        <ThemeToggle />
      </div>
    </header>
  );
}
