'use client';

import type { Id } from '@schemaloom/schema-model';
import {
  Code2,
  Columns3,
  FileText,
  Link2,
  MessageSquare,
  Sparkles,
  Table2,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type LucideIcon,
} from '@schemaloom/ui';
import { useRef, useState, type ReactNode } from 'react';
import { ResizeHandle, usePanelState, type PanelBounds } from '@/components/app-shell/panel';
import { AiPanel } from '@/features/ai/ai-panel';
import { CommentsPanel, CommentsTabCount } from '@/features/comments/comments-panel';
import { DocsPanel } from '@/features/docs/docs-panel';
import { EngineGate } from '@/features/project/engine-gate';
import { QueriesPanel } from '@/features/queries/queries-panel';
import { InspectorBody } from './inspector-body';

const BOUNDS: PanelBounds = { defaultWidth: 320, min: 260, max: 720 };

interface RailTab {
  readonly value: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly badge?: ReactNode;
}

/**
 * The right-hand context panel. Its tabs are fixed by the product spec (entity / field /
 * link / docs, plus the Phase 2 saved-query library, the Phase 4 comments and the Phase 5
 * AI assistant); the contents follow the canvas selection.
 *
 * Layout: a vertical icon rail on the far right. Hovering the rail widens it over the panel
 * to show every label; clicking the active tab collapses the panel to the rail, clicking
 * any tab opens it. The panel's left edge is a resize handle.
 */
export function InspectorPanel({ projectId }: { readonly projectId: Id }) {
  const [tab, setTab] = useState('entity');
  const { width, setWidth, collapsed, setCollapsed } = usePanelState('sl-panel-right', BOUNDS);
  // Radix switches tabs on pointer-down, so by `click` the tab is already active. Whether
  // the click landed on the ACTIVE tab is recorded before that happens.
  const wasActive = useRef(false);

  const tabs: readonly RailTab[] = [
    { value: 'entity', label: 'Entity', icon: Table2 },
    { value: 'field', label: 'Field', icon: Columns3 },
    { value: 'link', label: 'Link', icon: Link2 },
    { value: 'docs', label: 'Docs', icon: FileText },
    { value: 'comments', label: 'Comments', icon: MessageSquare, badge: <CommentsTabCount projectId={projectId} /> },
    { value: 'queries', label: 'Queries', icon: Code2 },
    { value: 'ai', label: 'AI', icon: Sparkles },
  ];

  return (
    <Tabs value={tab} onValueChange={setTab} orientation="vertical" className="flex h-full">
      {/* Hidden with CSS, not unmounted, so an open editor keeps its state while collapsed. */}
      <div style={{ width }} className={collapsed ? 'hidden' : 'relative h-full min-w-0'}>
        <div className="flex h-full flex-col overflow-auto p-2">
        <EngineGate
          projectId={projectId}
          fallback={<p className="p-2 text-sm text-text-subtle">Loading…</p>}
        >
          <InspectorBody projectId={projectId} />
          <TabsContent value="comments" className="overflow-auto">
            <CommentsPanel projectId={projectId} />
          </TabsContent>
          <TabsContent value="queries" className="overflow-auto">
            <QueriesPanel projectId={projectId} />
          </TabsContent>
          <TabsContent value="docs" className="overflow-auto">
            <DocsPanel projectId={projectId} />
          </TabsContent>
          <TabsContent value="ai" className="overflow-auto">
            <AiPanel projectId={projectId} />
          </TabsContent>
        </EngineGate>
        </div>
        <ResizeHandle side="right" width={width} bounds={BOUNDS} onResize={setWidth} label="Resize inspector" />
      </div>
      {/* The rail keeps its 44px slot; the list inside widens leftwards over the panel. */}
      <div className="relative w-11 shrink-0">
        <TabsList className={`group/rail absolute inset-y-0 right-0 z-20 flex w-11 flex-col items-stretch gap-1 border-b-0 border-border bg-surface px-1 ${collapsed ? '' : 'border-l'} py-2 transition-[width] duration-150 hover:w-40 hover:shadow-lg focus-within:w-40`}>
          {tabs.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              aria-label={t.label}
              onPointerDown={() => {
                wasActive.current = tab === t.value;
              }}
              onClick={() => {
                setCollapsed(wasActive.current ? !collapsed : false);
                wasActive.current = false;
              }}
              className="relative mb-0 flex h-9 items-center gap-3 overflow-hidden rounded-md border-b-0 px-2.5 hover:bg-surface-hover data-[state=active]:bg-surface-sunken data-[state=active]:text-text"
            >
              <t.icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate whitespace-nowrap opacity-0 transition-opacity group-hover/rail:opacity-100 group-focus-within/rail:opacity-100">
                {t.label}
              </span>
              {t.badge !== undefined && (
                <span className="absolute top-0.5 left-6 group-hover/rail:static">{t.badge}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </Tabs>
  );
}
