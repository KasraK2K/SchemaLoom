'use client';

import type { Id } from '@schemaloom/schema-model';
import type { NodeProps } from '@xyflow/react';
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEngine, useEngineUi } from '@/engines';
import { EntityBody } from './entity-body';
import { NodeHandles } from './field-handle';
import type { EntityNode as EntityNodeType } from './graph';
import { peerColor, selectPeersOn, usePresenceStore } from './realtime';
import { useCanvasStore } from './store';

const NO_HIGHLIGHTS: ReadonlySet<Id> = new Set<Id>();

/**
 * The React Flow node type. Hooks and nothing else: `EntityBody` decides what is drawn,
 * which is what keeps the redaction branch testable outside a flow canvas.
 *
 * `collapsed` is read here rather than carried on `node.data` so collapsing one card does
 * not rebuild all 300 nodes — zustand re-renders only the subscriber whose slice changed.
 */
export function EntityNode({ id, data, selected }: NodeProps<EntityNodeType>) {
  const facet = useEngine();
  const ui = useEngineUi();
  const collapsed = useCanvasStore((state) => state.collapsed.has(id));
  const toggleCollapse = useCanvasStore((state) => state.toggleCollapse);
  const selectField = useCanvasStore((state) => state.selectField);

  const onToggleCollapse = useCallback(() => {
    toggleCollapse(id);
  }, [toggleCollapse, id]);

  const onFieldSelect = useCallback(
    (fieldId: Id) => {
      selectField(id, fieldId);
    },
    [selectField, id],
  );

  return (
    <>
      <PeerSelection entityId={id} />
      <NodeHandles />
      <EntityBody
        data={data}
        facet={facet}
        ui={ui}
        selected={selected}
        collapsed={collapsed}
        highlightedFieldIds={NO_HIGHLIGHTS}
        onFieldSelect={onFieldSelect}
        onToggleCollapse={onToggleCollapse}
      />
    </>
  );
}

/**
 * Other users who have this card selected: a coloured ring and their initials. Ids the
 * viewer cannot see never arrive (the server strips them, doc 05 L16).
 */
function PeerSelection({ entityId }: { readonly entityId: Id }) {
  const peers = usePresenceStore(useShallow(selectPeersOn(entityId)));
  if (peers.length === 0) return null;
  const color = peerColor(peers[0]?.peerId ?? '');
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-1 rounded-lg"
        style={{ boxShadow: `0 0 0 2px ${color}` }}
      />
      <div className="pointer-events-none absolute -top-6 right-0 flex gap-1">
        {peers.map((peer) => (
          <span
            key={peer.peerId}
            title={`${peer.name ?? 'Someone'} has this selected`}
            className="rounded-full px-1.5 text-[10px] leading-4 font-semibold text-white"
            style={{ backgroundColor: peerColor(peer.peerId) }}
          >
            {initials(peer.name ?? '')}
          </span>
        ))}
      </div>
    </>
  );
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
