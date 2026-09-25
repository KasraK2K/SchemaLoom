'use client';

import type { Id } from '@schemaloom/schema-model';
import type { NodeProps } from '@xyflow/react';
import { useCallback } from 'react';
import { useEngine, useEngineUi } from '@/engines';
import { EntityBody } from './entity-body';
import { NodeHandles } from './field-handle';
import type { EntityNode as EntityNodeType } from './graph';
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
