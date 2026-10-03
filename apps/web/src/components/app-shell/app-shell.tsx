import { cn } from '@schemaloom/ui';
import type { ReactNode } from 'react';
import { Sidebar, type NavItem } from '@/components/app-shell/sidebar';
import { TopBar } from '@/components/app-shell/top-bar';

interface AppShellProps {
  nav: readonly NavItem[];
  /** The organisation the visitor is currently inside, shown above the nav. */
  orgLabel?: string;
  breadcrumb?: ReactNode;
  /** Route-owned top-bar controls, e.g. the project's "Who has access" dialog. */
  actions?: ReactNode;
  /** The right-hand context panel (inspector). Omitted on routes that have none. */
  rightPanel?: ReactNode;
  /** The canvas: in the Float theme it runs under the floating chrome, edge to edge. */
  fullBleed?: boolean;
  children: ReactNode;
}

/**
 * Top bar / left sidebar / centre / right panel.
 *
 * `h-dvh` with `min-h-0` on the scrolling row: the canvas owns its own scroll and the
 * page itself must never scroll, or the viewport drifts under a dragged node.
 */
export function AppShell({
  nav,
  orgLabel,
  breadcrumb,
  actions,
  rightPanel,
  fullBleed = false,
  children,
}: AppShellProps) {
  return (
    // Float: the same three regions, lifted off the edges. The main area fills the window
    // and the bar, the dock and the inspector float over it; a page that is not the canvas
    // is padded clear of them.
    <div className="flex h-dvh flex-col theme-float:relative theme-float:block">
      <TopBar breadcrumb={breadcrumb} actions={actions} />
      <div className="flex min-h-0 flex-1 theme-float:contents">
        <Sidebar items={nav} orgLabel={orgLabel} />
        <main
          className={cn(
            'min-w-0 flex-1 overflow-auto theme-float:absolute theme-float:inset-0',
            !fullBleed &&
              'theme-float:pt-[calc(var(--sl-topbar-h)+24px)] theme-float:pl-[66px] theme-float:max-md:pl-0',
          )}
        >
          {children}
        </main>
        {rightPanel !== undefined && (
          <aside
            aria-label="Inspector"
            // Width, collapse and the tab rail belong to the panel itself (InspectorPanel).
            className="hidden shrink-0 border-l border-border bg-surface lg:flex theme-float:absolute theme-float:top-[calc(var(--sl-topbar-h)+24px)] theme-float:right-3 theme-float:bottom-3 theme-float:z-20 theme-float:overflow-hidden theme-float:rounded-xl theme-float:border theme-float:border-border theme-float:shadow-panel theme-float:backdrop-blur-xl"
          >
            {rightPanel}
          </aside>
        )}
      </div>
    </div>
  );
}
