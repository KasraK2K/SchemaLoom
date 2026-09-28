'use client';

import '@xyflow/react/dist/style.css';

import { createIndex, type Id, type Point, type SchemaModel } from '@schemaloom/schema-model';
import { Button, LayoutGrid } from '@schemaloom/ui';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeTypes,
  type FinalConnectionState,
  type NodeTypes,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEngine, useEngineUi } from '@/engines';
import { areaColors } from './area-color';
import { CanvasMenu, type CanvasMenuItem, type CanvasMenuTarget } from './canvas-menu';
import { cardinalityFor, checkConnection, explainCheck } from './connect';
import { createLink } from './create-link';
import { CrowFootDefs } from './crow-foot';
import { CanvasEmptyState } from './empty-state';
import { EntityNode } from './entity-node';
import { createGeometryAutosave, postGeometry } from './geometry';
import {
  ENTITY_NODE_TYPE,
  LINK_EDGE_TYPE,
  buildEdges,
  buildNodes,
  type EntityNode as EntityNodeType,
  type LinkEdge as LinkEdgeType,
} from './graph';
import { parseHandleId } from './handles';
import { GRID_SIZE, autoLayout, unstack } from './layout';
import { LinkEdge } from './link-edge';
import { useCanvasStore } from './store';
import { useCanvasShortcuts } from './use-canvas-shortcuts';

/**
 * The canvas. Client-only by construction (`canvas-client.tsx` loads it with `ssr: false`):
 * React Flow measures the DOM, so its server output is discarded on hydration and costs a
 * full render of 300+ nodes for nothing (doc 01 §5.2).
 *
 * `nodeTypes` / `edgeTypes` are module constants. A fresh object per render makes React
 * Flow remount every node, which is the most common way a flow canvas becomes unusable.
 */
const nodeTypes: NodeTypes = { [ENTITY_NODE_TYPE]: EntityNode };
const edgeTypes: EdgeTypes = { [LINK_EDGE_TYPE]: LinkEdge };
const SNAP: [number, number] = [GRID_SIZE, GRID_SIZE];

/** Shift-click adds to the selection; shift-drag on the pane is still the lasso, because
 *  one gesture starts on a card and the other does not. */
const MULTI_SELECT_KEYS = ['Shift', 'Meta', 'Control'];

/** Only auto-layout needs a size for a node React Flow has not measured yet. */
const FALLBACK_NODE_WIDTH = 220;
const FALLBACK_NODE_HEIGHT = 160;

interface Move {
  readonly id: Id;
  readonly before: Point;
  readonly after: Point;
}

export function CanvasSurface({
  projectId,
  model,
  readOnly = false,
}: {
  readonly projectId: Id;
  readonly model: SchemaModel;
  /**
   * A share-link visitor (doc 05 §7.12): pan, zoom, select and inspect, but no gesture
   * that writes. The API would 404 every write anyway (R21); this stops the UI offering
   * them and then reporting a failed save.
   */
  readonly readOnly?: boolean;
}) {
  const facet = useEngine();
  const ui = useEngineUi();
  const flow = useReactFlow<EntityNodeType, LinkEdgeType>();

  const select = useCanvasStore((state) => state.select);
  const clearSelection = useCanvasStore((state) => state.clearSelection);
  const toggleCollapse = useCanvasStore((state) => state.toggleCollapse);
  const recordMove = useCanvasStore((state) => state.recordMove);
  const undoMove = useCanvasStore((state) => state.undoMove);
  const redoMove = useCanvasStore((state) => state.redoMove);

  const index = useMemo(() => createIndex(model), [model]);
  const colors = useMemo(() => areaColors(Object.values(model.objects.area)), [model]);
  const builtNodes = useMemo(() => buildNodes(index, facet, colors), [index, facet, colors]);
  const builtEdges = useMemo(() => buildEdges(model, ui.linkStyles), [model, ui]);

  const [nodes, setNodes, onNodesChange] = useNodesState<EntityNodeType>(builtNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<LinkEdgeType>(builtEdges);
  const [message, setMessage] = useState<string | null>(null);
  const [menu, setMenu] = useState<CanvasMenuTarget | null>(null);

  useEffect(() => {
    setNodes(builtNodes);
  }, [builtNodes, setNodes]);
  useEffect(() => {
    setEdges(builtEdges);
  }, [builtEdges, setEdges]);

  // ── geometry (§8.11): the one write that neither reads nor bumps `version` ──────────
  const autosave = useMemo(
    () =>
      createGeometryAutosave((entries) => {
        void postGeometry(projectId, entries).catch(() => {
          setMessage('Could not save the layout. It will be sent again on the next move.');
        });
      }),
    [projectId],
  );

  useEffect(
    () => () => {
      // Flush, not cancel: a card dropped just before a navigation is a move the user
      // made, and losing it looks like the drag never happened.
      autosave.flush();
    },
    [autosave],
  );

  const persist = useCallback(
    (moves: readonly { id: Id; position: Point }[]) => {
      for (const move of moves) autosave.queue({ id: move.id, position: move.position });
    },
    [autosave],
  );

  const applyPositions = useCallback(
    (moves: readonly { id: Id; position: Point }[]) => {
      if (moves.length === 0) return;
      const byId = new Map(moves.map((move) => [move.id, move.position]));
      setNodes((current) =>
        current.map((node) => {
          const position = byId.get(node.id);
          return position === undefined ? node : { ...node, position };
        }),
      );
      persist(moves);
    },
    [setNodes, persist],
  );

  // ── drag: one gesture, one undo step ───────────────────────────────────────────────
  const dragStart = useRef<Map<Id, Point>>(new Map());

  const onNodeDragStart = useCallback(
    (_event: unknown, _node: EntityNodeType, dragged: EntityNodeType[]) => {
      dragStart.current = new Map(dragged.map((node) => [node.id, node.position]));
    },
    [],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, _node: EntityNodeType, dragged: EntityNodeType[]) => {
      const batch = dragged
        .map((node) => ({
          id: node.id,
          before: dragStart.current.get(node.id),
          after: node.position,
        }))
        .filter(
          (move): move is Move =>
            move.before !== undefined &&
            (move.before.x !== move.after.x || move.before.y !== move.after.y),
        );
      if (batch.length === 0) return;
      recordMove(batch);
      persist(batch.map((move) => ({ id: move.id, position: move.after })));
    },
    [recordMove, persist],
  );

  // ── links: validated mid-drag by the SDK's shared checker ──────────────────────────
  const connectionContext = useMemo(() => ({ engine: facet, model }), [facet, model]);

  const isValid = useCallback(
    (candidate: Connection | LinkEdgeType) => checkConnection(connectionContext, candidate).ok,
    [connectionContext],
  );

  /**
   * Why the rejection lives here and not in `onConnect`: React Flow calls `onConnect` only
   * for a connection `isValidConnection` already accepted, so a refused drag would end in
   * silence — the user sees the line snap away and is told nothing about why. `onConnectEnd`
   * is the one callback that fires either way, and it carries the endpoints that were
   * refused.
   */
  const onConnectEnd = useCallback(
    (_event: unknown, state: FinalConnectionState) => {
      // `isValid === false` narrows to the in-progress arm, where `fromNode` and
      // `fromHandle` are non-null; only the drop end can still be empty.
      if (state.isValid !== false) {
        setMessage(null);
        return;
      }
      const { fromNode, fromHandle, toNode, toHandle } = state;
      if (toNode === null) {
        setMessage(null);
        return;
      }
      // A drag started from a TARGET handle runs parent -> child; the rules are stated in
      // the link's own direction, so put the ends back in that order before checking.
      const backwards = fromHandle.type === 'target';
      const check = checkConnection(connectionContext, {
        source: backwards ? toNode.id : fromNode.id,
        target: backwards ? fromNode.id : toNode.id,
        sourceHandle: backwards ? toHandle?.id : fromHandle.id,
        targetHandle: backwards ? fromHandle.id : toHandle?.id,
      });
      const hint = ui.connectionHint?.(check);
      const text = [...explainCheck(facet, check), typeof hint === 'string' ? hint : null]
        .filter((part): part is string => part !== null)
        .join(' ');
      setMessage(text === '' ? null : text);
    },
    [connectionContext, facet, ui],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const check = checkConnection(connectionContext, connection);
      if (!check.ok || check.linkKindId === null) return;
      const sourceField = parseHandleId(connection.sourceHandle)?.fieldId ?? null;
      const targetField = parseHandleId(connection.targetHandle)?.fieldId ?? null;
      void createLink(projectId, {
        kind: check.linkKindId,
        from: { entityId: connection.source, fieldIds: sourceField === null ? [] : [sourceField] },
        to: { entityId: connection.target, fieldIds: targetField === null ? [] : [targetField] },
        cardinality: cardinalityFor(check),
      })
        .then(() => {
          setMessage(null);
        })
        .catch(() => {
          setMessage('The link could not be saved.');
        });
    },
    [connectionContext, projectId],
  );

  // ── selection: React Flow owns it, the store mirrors it for the inspector ──────────
  const onSelectionChange = useCallback(
    ({ nodes: selected }: { nodes: EntityNodeType[] }) => {
      select(selected.map((node) => node.id));
    },
    [select],
  );

  // ── auto-layout ────────────────────────────────────────────────────────────────────
  const runLayout = useCallback(() => {
    const current = flow.getNodes();
    void autoLayout(
      current.map((node) => ({
        id: node.id,
        width: node.measured?.width ?? node.width ?? FALLBACK_NODE_WIDTH,
        height: node.measured?.height ?? node.height ?? FALLBACK_NODE_HEIGHT,
      })),
      flow.getEdges().map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
    )
      .then((positions) => {
        const moves = current
          .map((node) => ({ id: node.id, before: node.position, after: positions.get(node.id) }))
          .filter((move): move is Move => move.after !== undefined);
        if (moves.length === 0) return;
        // One undo step for the whole layout — it was one gesture.
        recordMove(moves);
        applyPositions(moves.map((move) => ({ id: move.id, position: move.after })));
      })
      .catch(() => {
        setMessage('Auto-layout failed.');
      });
  }, [flow, recordMove, applyPositions]);

  // An imported model arrives with every entity at the origin (the importer leaves layout
  // to the canvas), so place it once, after React Flow has measured the nodes: a fresh
  // import gets a full layout, tables merged into a laid-out project only get unpiled.
  const measured = useNodesInitialized();
  const laidOut = useRef(false);
  useEffect(() => {
    if (!measured || laidOut.current || readOnly) return;
    laidOut.current = true;
    const current = flow.getNodes();
    const placement = unstack(
      current.map((node) => ({
        id: node.id,
        position: node.position,
        width: node.measured?.width ?? node.width ?? FALLBACK_NODE_WIDTH,
        height: node.measured?.height ?? node.height ?? FALLBACK_NODE_HEIGHT,
      })),
    );
    if (placement === 'all') {
      runLayout();
      return;
    }
    const moves = current.flatMap((node) => {
      const after = placement.get(node.id);
      return after === undefined ? [] : [{ id: node.id, before: node.position, after }];
    });
    if (moves.length === 0) return;
    recordMove(moves);
    applyPositions(moves.map((move) => ({ id: move.id, position: move.after })));
  }, [measured, readOnly, flow, runLayout, recordMove, applyPositions]);

  const fitView = useCallback(() => {
    void flow.fitView({ padding: 0.2 });
  }, [flow]);

  useCanvasShortcuts({
    undo: () => {
      if (!readOnly) applyPositions(undoMove() ?? []);
    },
    redo: () => {
      if (!readOnly) applyPositions(redoMove() ?? []);
    },
    clearSelection,
    autoLayout: () => {
      if (!readOnly) runLayout();
    },
    fitView,
  });

  const menuItems = useMemo<readonly CanvasMenuItem[]>(() => {
    const entityId = menu?.entityId ?? null;
    if (entityId === null) {
      return [
        ...(readOnly ? [] : [{ id: 'layout', label: 'Auto-layout', onSelect: runLayout }]),
        { id: 'fit', label: 'Fit to view', onSelect: fitView },
      ];
    }
    return [
      {
        id: 'collapse',
        label: 'Collapse / expand',
        onSelect: () => {
          toggleCollapse(entityId);
        },
      },
      {
        id: 'focus',
        label: 'Zoom to this',
        onSelect: () => {
          void flow.fitView({ nodes: [{ id: entityId }], padding: 0.4, duration: 200 });
        },
      },
    ];
  }, [menu, runLayout, fitView, toggleCollapse, flow, readOnly]);

  if (nodes.length === 0) {
    return readOnly ? (
      <div className="flex h-full items-center justify-center text-sm text-text-subtle">
        Nothing is shared here yet.
      </div>
    ) : (
      <CanvasEmptyState projectId={projectId} />
    );
  }

  return (
    <div className="relative size-full">
      <CrowFootDefs />
      <ReactFlow<EntityNodeType, LinkEdgeType>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onSelectionChange={onSelectionChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValid}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, entityId: node.id });
        }}
        onPaneContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, entityId: null });
        }}
        multiSelectionKeyCode={MULTI_SELECT_KEYS}
        snapToGrid
        snapGrid={SNAP}
        minZoom={0.05}
        maxZoom={2}
        fitView
        // Item 8: React Flow's own culling. 300 cards is ~4,500 field rows, and the ones
        // outside the viewport cost nothing if they are never mounted.
        onlyRenderVisibleElements
        // Deleting schema is an op with a version check, not a keystroke on a canvas.
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={GRID_SIZE} size={1} />
        <MiniMap
          pannable
          zoomable
          nodeColor={minimapColor}
          style={{ backgroundColor: 'var(--color-surface-sunken)' }}
        />
        <Controls showInteractive={false} />
        {readOnly ? null : (
          <Panel position="top-right">
            <Button variant="outline" size="sm" onClick={runLayout}>
              <LayoutGrid className="size-3.5" aria-hidden="true" />
              Auto-layout
            </Button>
          </Panel>
        )}
        {message === null ? null : (
          <Panel position="bottom-center">
            <button
              type="button"
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-text-muted shadow-panel"
              onClick={() => {
                setMessage(null);
              }}
            >
              {message}
            </button>
          </Panel>
        )}
      </ReactFlow>
      <CanvasMenu
        target={menu}
        items={menuItems}
        onClose={() => {
          setMenu(null);
        }}
      />
    </div>
  );
}

const minimapColor = (node: EntityNodeType): string => node.data.areaColor ?? 'var(--color-border)';
