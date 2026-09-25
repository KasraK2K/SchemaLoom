import type { ReactNode } from 'react';
import { Sidebar, type NavItem } from '@/components/app-shell/sidebar';
import { TopBar } from '@/components/app-shell/top-bar';

interface AppShellProps {
  nav: readonly NavItem[];
  breadcrumb?: ReactNode;
  /** Route-owned top-bar controls, e.g. the project's "Who has access" dialog. */
  actions?: ReactNode;
  /** The right-hand context panel (inspector). Omitted on routes that have none. */
  rightPanel?: ReactNode;
  children: ReactNode;
}

/**
 * Top bar / left sidebar / centre / right panel.
 *
 * `h-dvh` with `min-h-0` on the scrolling row: the canvas owns its own scroll and the
 * page itself must never scroll, or the viewport drifts under a dragged node.
 */
export function AppShell({ nav, breadcrumb, actions, rightPanel, children }: AppShellProps) {
  return (
    <div className="flex h-dvh flex-col">
      <TopBar breadcrumb={breadcrumb} actions={actions} />
      <div className="flex min-h-0 flex-1">
        <Sidebar items={nav} />
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
        {rightPanel !== undefined && (
          <aside
            aria-label="Inspector"
            className="hidden w-80 shrink-0 overflow-auto border-l border-border bg-surface lg:block"
          >
            {rightPanel}
          </aside>
        )}
      </div>
    </div>
  );
}
