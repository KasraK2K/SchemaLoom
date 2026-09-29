'use client';

import { PanelLeftClose, PanelLeftOpen } from '@schemaloom/ui';
import type { ReactNode } from 'react';
import { ResizeHandle, usePanelState, type PanelBounds } from './panel';

const BOUNDS: PanelBounds = { defaultWidth: 240, min: 180, max: 420 };

/**
 * The left sidebar's chrome: resizable, and collapsible to an icon strip. The nav itself
 * stays a Server Component passed as children; collapsed labels are hidden with the
 * `group/sidebar` data attribute instead of re-rendering them.
 */
export function SidebarFrame({ children }: { readonly children: ReactNode }) {
  const { width, setWidth, collapsed, setCollapsed } = usePanelState('sl-panel-left', BOUNDS);
  return (
    <nav
      aria-label="Primary"
      data-collapsed={collapsed}
      style={{ width: collapsed ? 48 : width }}
      className="group/sidebar relative hidden shrink-0 flex-col border-r border-border bg-surface md:flex"
    >
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
      <div className="min-h-0 flex-1">{children}</div>
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
