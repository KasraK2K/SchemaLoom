'use client';

import { PanelLeftClose, PanelLeftOpen } from '@schemaloom/ui';
import type { ReactNode } from 'react';
import { useTheme } from '@/components/theme-provider';
import { ResizeHandle, usePanelState, type PanelBounds } from './panel';

const BOUNDS: PanelBounds = { defaultWidth: 240, min: 180, max: 420 };

/**
 * The left sidebar's chrome: resizable, and collapsible to an icon strip. The nav itself
 * stays a Server Component passed as children; collapsed labels are hidden with the
 * `group/sidebar` data attribute instead of re-rendering them.
 */
export function SidebarFrame({ children }: { readonly children: ReactNode }) {
  const {
    width,
    setWidth,
    collapsed: chosen,
    setCollapsed,
  } = usePanelState('sl-panel-left', BOUNDS);
  // Compact and Float use an icon rail (Float's floats as a dock). Not a stored choice:
  // switching back to Studio brings back the width the user left it at.
  const { look } = useTheme();
  const rail = look.theme === 'compact' || look.theme === 'float';
  const collapsed = chosen || rail;
  return (
    <nav
      aria-label="Primary"
      data-collapsed={collapsed}
      style={{ width: collapsed ? 48 : width }}
      className="group/sidebar relative hidden shrink-0 flex-col border-r border-border bg-surface md:flex theme-float:absolute theme-float:top-[calc(var(--sl-topbar-h)+24px)] theme-float:left-3 theme-float:z-20 theme-float:w-[52px]! theme-float:rounded-xl theme-float:border theme-float:border-border theme-float:pb-2 theme-float:shadow-panel theme-float:backdrop-blur-xl"
    >
      {!rail && (
        <button
          type="button"
          onClick={() => {
            setCollapsed(!collapsed);
          }}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          className="m-2 mb-0 flex size-8 items-center justify-center self-end rounded-md text-text-muted group-data-[collapsed=true]/sidebar:self-center hover:bg-surface-hover hover:text-text"
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      )}
      <div className="min-h-0 flex-1 theme-float:flex-none">{children}</div>
      {!collapsed && (
        <ResizeHandle
          side="left"
          width={width}
          bounds={BOUNDS}
          onResize={setWidth}
          label="Resize sidebar"
        />
      )}
    </nav>
  );
}
