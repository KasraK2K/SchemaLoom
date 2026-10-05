'use client';

import '@xyflow/react/dist/style.css';

import { createIndex, type Id, type Point, type SchemaModel } from '@schemaloom/schema-model';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  BackgroundVariant,
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
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MoreHorizontal } from '@schemaloom/ui';
import { NameDialog } from '@/components/name-dialog';
import { useEngine, useEngineUi, useTerminology } from '@/engines';
import { ApiError } from '@/lib/api-client';
import { centreOf, hitArea, isAreaNodeId, type Box } from './area-card';
import { areaColors, areaSlots } from './area-color';
import { AreaMenu, type AreaMenuTarget } from './area-menu';
import { AreaCanvasContext, AreaNode as AreaCard, type AreaCanvas } from './area-node';
import { areaWriteMessage, useAreaActions } from './use-area-actions';
import { CanvasMenu, type CanvasMenuItem, type CanvasMenuTarget } from './canvas-menu';
import { CanvasSearch } from './canvas-search';
import { CanvasToolbar } from './canvas-toolbar';
import { fitPadding } from './fit-padding';
import { cardinalityFor, checkConnection, explainCheck } from './connect';
import { createLink } from './create-link';
import { CrowFootDefs } from './crow-foot';
import { CanvasEmptyState } from './empty-state';
import { EntityNode } from './entity-node';
import { createGeometryAutosave, postGeometry } from './geometry';
import { projectShellQueryOptions } from '@/features/change-requests/change-requests-api';
import { importSourceName } from '@/features/projects/create-project';
import { getSavedConnection, savedConnectionKey } from '@/features/projects/saved-connection';
// Lazy and mounted only while open: it pulls in the connection form and AI describe, and
// its saved-connection query would otherwise fire on every canvas open.
const ImportDialog = dynamic(() => import('./import-dialog').then((m) => m.ImportDialog), {
  ssr: false,
});
// "Share this area" opens the sharing dialog on the area; nobody pays for it until then.
const WhoHasAccessDialog = dynamic(
  () => import('@/features/sharing/who-has-access-dialog').then((m) => m.WhoHasAccessDialog),
  { ssr: false },
);
import {
  AREA_NODE_TYPE,
  ENTITY_NODE_TYPE,
  LINK_EDGE_TYPE,
  buildAreaNodes,
  buildEdges,
  buildNodes,
  type AreaNode as AreaNodeType,
  type AreaNodeData,
  type EntityNode as EntityNodeType,
  type LinkEdge as LinkEdgeType,
} from './graph';
import { parseHandleId } from './handles';
import { GRID_SIZE, autoLayout, snap, unstack } from './layout';
import { irQueryKey } from './ir-query';
import { LinkEdge } from './link-edge';
import { deleteLinkOp, postOps } from './schema-ops';
import { applySelectChanges } from './selection';
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
const nodeTypes: NodeTypes = { [ENTITY_NODE_TYPE]: EntityNode, [AREA_NODE_TYPE]: AreaCard };
const edgeTypes: EdgeTypes = { [LINK_EDGE_TYPE]: LinkEdge };

/** Tables and area cards share one React Flow canvas; only tables are state (cards are derived). */
type AppNode = EntityNodeType | AreaNodeType;
const isTable = (node: AppNode): node is EntityNodeType => node.type === ENTITY_NODE_TYPE;
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
  readOnly: shareLink = false,
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
  const flow = useReactFlow<AppNode, LinkEdgeType>();
  const queryClient = useQueryClient();
  const t = useTerminology();
  // Phase 10c §1: a protected project is read-only for everyone, layout included. Its
  // changes, moves too, arrive through a change request's merge.
  const shell = useQuery({ ...projectShellQueryOptions(projectId), enabled: !shareLink });
  // Read-only until the shell says otherwise, so the first placement below can't fire on a
  // protected project before we know it is one.
  const readOnly = shareLink || (!shell.isError && shell.data?.requireChangeRequests !== false);

  const select = useCanvasStore((state) => state.select);
  const clearSelection = useCanvasStore((state) => state.clearSelection);
  const toggleCollapse = useCanvasStore((state) => state.toggleCollapse);
  const recordMove = useCanvasStore((state) => state.recordMove);
  const undoMove = useCanvasStore((state) => state.undoMove);
  const redoMove = useCanvasStore((state) => state.redoMove);

  const index = useMemo(() => createIndex(model), [model]);
  const areas = useMemo(() => Object.values(model.objects.area), [model]);
  const colors = useMemo(() => areaColors(areas), [areas]);
  const slots = useMemo(() => areaSlots(areas), [areas]);
  const builtNodes = useMemo(
    () => buildNodes(index, facet, colors, slots),
    [index, facet, colors, slots],
  );
  const builtEdges = useMemo(() => buildEdges(model, ui.linkStyles), [model, ui]);

  const [nodes, setNodes, onNodesChange] = useNodesState<EntityNodeType>(builtNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<LinkEdgeType>(builtEdges);
  const [message, setMessage] = useState<string | null>(null);
  const [menu, setMenu] = useState<CanvasMenuTarget | null>(null);
  const [areaMenu, setAreaMenu] = useState<AreaMenuTarget | null>(null);
  /** the card whose name is being typed; a new card starts here */
  const [editingArea, setEditingArea] = useState<Id | null>(null);
  /** the card a dragged table is over (it joins on drop) */
  const [dropArea, setDropArea] = useState<Id | null>(null);
  const [sharingArea, setSharingArea] = useState<Id | null>(null);
  const areaActions = useAreaActions(projectId, model);

  // The cards, from where the tables are right now (see `buildAreaNodes`).
  const areaNodes = useMemo(
    () => buildAreaNodes(areas, nodes, slots, dropArea),
    [areas, nodes, slots, dropArea],
  );
  const areaRects = useMemo(
    () =>
      new Map<Id, Box>(
        areaNodes.flatMap((card) =>
          card.width === undefined || card.height === undefined
            ? []
            : [
                [
                  card.data.area.id,
                  {
                    x: card.position.x,
                    y: card.position.y,
                    width: card.width,
                    height: card.height,
                  },
                ] as const,
              ],
        ),
      ),
    [areaNodes],
  );
  /** Where a new entity lands: the pointer for "add here", the viewport centre otherwise. */
  const [newEntityAt, setNewEntityAt] = useState<Point | null>(null);
  const [importing, setImporting] = useState(false);
  /** 6c — Sync opens the import dialog on its database tab */
  const [importFrom, setImportFrom] = useState<'sql' | 'database' | 'describe'>('sql');
  /** Phase 22 — "Describe something connected to these": the tables the AI builds on */
  const [describeFocus, setDescribeFocus] = useState<readonly string[]>([]);

  useEffect(() => {
    // Carry `measured` over: a node without it loses its handle bounds, so React Flow
    // re-mounts and re-measures every card (culling off) on each IR change. A card
    // mid-drag keeps its position so a remote patch can't yank it from under the cursor.
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return builtNodes.map((n) => {
        const p = old.get(n.id);
        if (p?.measured === undefined) return n;
        return p.dragging === true
          ? { ...n, measured: p.measured, position: p.position }
          : { ...n, measured: p.measured };
      });
    });
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

  const onNodeDragStart = useCallback((_event: unknown, _node: AppNode, dragged: AppNode[]) => {
    dragStart.current = new Map(dragged.map((node) => [node.id, node.position]));
  }, []);

  /** The card under a dragged table's centre, other than the one it is already in. */
  const cardUnder = useCallback(
    (node: EntityNodeType): Id | null => {
      const width = node.measured?.width ?? node.width;
      const height = node.measured?.height ?? node.height;
      if (readOnly || width === undefined || height === undefined) return null;
      return hitArea(
        centreOf({ x: node.position.x, y: node.position.y, width, height }),
        areaRects,
        node.data.entity.areaId,
      );
    },
    [readOnly, areaRects],
  );

  const onNodeDrag = useCallback(
    (_event: unknown, node: AppNode) => {
      const over = isTable(node) ? cardUnder(node) : null;
      setDropArea((current) => (current === over ? current : over));
    },
    [cardUnder],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, node: AppNode, draggedAll: AppNode[]) => {
      const dragged = draggedAll.filter(isTable);
      const target = isTable(node) ? cardUnder(node) : null;
      setDropArea(null);
      const batch = dragged
        .map((table) => ({
          id: table.id,
          before: dragStart.current.get(table.id),
          after: table.position,
        }))
        .filter(
          (move): move is Move =>
            move.before !== undefined &&
            (move.before.x !== move.after.x || move.before.y !== move.after.y),
        );
      if (batch.length > 0) {
        recordMove(batch);
        persist(batch.map((move) => ({ id: move.id, position: move.after })));
      }
      // Joining a card is the explicit gesture (D3): dropping on it. A table that merely
      // sits over a card, or is dragged out of its own, never changes membership.
      if (target !== null) {
        // The write refetches the model; positions still waiting in the autosave would be
        // overwritten by the old ones and the table would jump back.
        autosave.flush();
        void areaActions
          .moveTo(
            dragged.map((table) => table.id),
            target,
          )
          .catch((caught: unknown) => {
            setMessage(areaWriteMessage(caught));
          });
      }
    },
    [recordMove, persist, cardUnder, areaActions, autosave],
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
      void createLink(queryClient, projectId, {
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
    [connectionContext, projectId, queryClient],
  );

  // ── entity create / link delete: ops through `/schema/ops`, then an IR refetch ───────
  const createEntity = useCallback(
    async (name: string, position: Point) => {
      const namespace = Object.values(model.objects.namespace).find((ns) => ns.isDefault);
      const kind = facet.capabilities.entityKinds[0];
      if (namespace === undefined || kind === undefined) {
        throw new ApiError(422, 'no_default_namespace', 'This project has no default namespace.');
      }
      await postOps(
        queryClient,
        projectId,
        [
          {
            op: 'create',
            type: 'entity',
            object: {
              id: crypto.randomUUID(),
              name,
              engineProps: {},
              namespaceId: namespace.id,
              kind: kind.id,
              areaId: null,
              position,
              color: null,
            },
          },
        ],
        t.msg('action.add', 'entity'),
      );
    },
    [model, facet, queryClient, projectId, t],
  );

  const deleteLink = useCallback(
    (linkId: Id) => {
      const link = model.objects.link[linkId];
      if (link === undefined) return;
      void postOps(queryClient, projectId, [deleteLinkOp(link)], t.msg('action.delete', 'link'))
        .then(() => {
          setMessage(null);
        })
        .catch((caught: unknown) => {
          setMessage(
            caught instanceof ApiError && caught.status === 409
              ? 'This link was changed by someone else. The diagram has been refreshed; try again.'
              : 'The link could not be deleted.',
          );
          void queryClient.invalidateQueries({ queryKey: irQueryKey(projectId) });
        });
    },
    [model, queryClient, projectId, t],
  );

  const viewportCentre = useCallback(
    (): Point => flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }),
    [flow],
  );

  // ── selection: the STORE owns it, React Flow renders it ─────────────────────────────
  // `selected` is derived from the store at render time, and only React Flow's `select`
  // changes (click, shift-click, lasso, pane click) write back. Letting `onSelectionChange`
  // write instead let its mount-time and re-init reports ("nothing selected") wipe any
  // selection made outside the canvas: History's `?select=`, the Queries tab, a notification.
  const selection = useCanvasStore((state) => state.selection);
  const shownNodes = useMemo<AppNode[]>(
    () => [
      ...areaNodes,
      ...nodes.map((node) =>
        Boolean(node.selected) === selection.has(node.id)
          ? node
          : { ...node, selected: selection.has(node.id) },
      ),
    ],
    [areaNodes, nodes, selection],
  );
  const handleNodesChange = useCallback(
    (all: NodeChange<AppNode>[]) => {
      // Cards are derived, not state: React Flow's measurements of them have nowhere to go.
      const changes = all.filter(
        (change) => !('id' in change && isAreaNodeId(change.id)),
      ) as NodeChange<EntityNodeType>[];
      const picks = changes.filter((change) => change.type === 'select');
      if (picks.length > 0)
        select([...applySelectChanges(useCanvasStore.getState().selection, picks)]);
      onNodesChange(
        picks.length === changes.length ? [] : changes.filter((change) => change.type !== 'select'),
      );
    },
    [onNodesChange, select],
  );

  // ── areas: group, ungroup, rename, recolour, drag the card ─────────────────────────────
  const failed = useCallback((caught: unknown) => {
    setMessage(areaWriteMessage(caught));
  }, []);

  /** The tables the toolbar, Ctrl+G and the menus would group: the selected, visible ones. */
  const selectedTables = useMemo(
    () =>
      [...selection].filter(
        (id) => id in model.objects.entity && model.objects.entity[id]?.restricted !== true,
      ),
    [selection, model],
  );

  const groupSelection = useCallback(
    (ids: readonly Id[]) => {
      if (readOnly || ids.length === 0) return;
      void areaActions
        .group(ids)
        .then((id) => {
          // Name field focused, "Area N" selected, ready to be replaced.
          if (id === null) return;
          // The tables stay selected otherwise, and dragging one would drag all of them.
          clearSelection();
          setEditingArea(id);
        })
        .catch(failed);
    },
    [readOnly, areaActions, failed, clearSelection],
  );

  /** Dragging the label or the card body moves every table in the card: one geometry batch, one undo step. */
  const onLabelDown = useCallback(
    (data: AreaNodeData, event: React.PointerEvent, opensMenu = true) => {
      if (event.button !== 0) return;
      const members = flow
        .getNodes()
        .filter(isTable)
        .filter((node) => data.memberIds.includes(node.id));
      const start = new Map(members.map((node) => [node.id, node.position]));
      const zoom = flow.getZoom();
      const origin = { x: event.clientX, y: event.clientY };
      let moved = false;
      let delta = { x: 0, y: 0 };
      const shifted = (id: Id): Point | undefined => {
        const from = start.get(id);
        return from === undefined
          ? undefined
          : { x: snap(from.x + delta.x), y: snap(from.y + delta.y) };
      };
      const onMove = (e: PointerEvent) => {
        // A click that wobbles a pixel is still a click.
        if (!moved && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < 4) return;
        moved = true;
        delta = { x: (e.clientX - origin.x) / zoom, y: (e.clientY - origin.y) / zoom };
        setNodes((current) =>
          current.map((node) => {
            const position = shifted(node.id);
            return position === undefined ? node : { ...node, position };
          }),
        );
      };
      const onUp = (e: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (!moved) {
          // A click on the label opens its menu; a click on the card body does nothing.
          if (opensMenu) setAreaMenu({ x: e.clientX, y: e.clientY, data });
          return;
        }
        const batch = members.flatMap((node) => {
          const after = shifted(node.id);
          return after === undefined || (after.x === node.position.x && after.y === node.position.y)
            ? []
            : [{ id: node.id, before: node.position, after }];
        });
        if (batch.length === 0) return;
        recordMove(batch);
        persist(batch.map((move) => ({ id: move.id, position: move.after })));
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [flow, setNodes, recordMove, persist],
  );

  const areaCanvas = useMemo<AreaCanvas>(
    () => ({
      readOnly,
      editingId: editingArea,
      onLabelDown,
      onLabelMenu: (data, x, y) => {
        setAreaMenu({ x, y, data });
      },
      onStartRename: (data) => {
        // the first click of the double-click opened the menu
        setAreaMenu(null);
        setEditingArea(data.area.id);
      },
      onRename: (data, name) => {
        setEditingArea(null);
        const next = name?.trim() ?? '';
        if (next === '' || next === data.area.name) return;
        void areaActions.rename(data.area, next).catch(failed);
      },
    }),
    [readOnly, editingArea, onLabelDown, areaActions, failed],
  );

  // ── auto-layout ────────────────────────────────────────────────────────────────────
  const runLayout = useCallback(() => {
    const current = flow.getNodes().filter(isTable);
    void autoLayout(
      current.map((node) => ({
        id: node.id,
        width: node.measured?.width ?? node.width ?? FALLBACK_NODE_WIDTH,
        height: node.measured?.height ?? node.height ?? FALLBACK_NODE_HEIGHT,
        areaId: node.data.entity.restricted === true ? null : node.data.entity.areaId,
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
    const current = flow.getNodes().filter(isTable);
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
    void flow.fitView({ padding: fitPadding() });
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
    group: () => {
      groupSelection(selectedTables);
    },
  });

  const canImport = facet.capabilities.importFormats.length > 0;
  // Phase 22 §1.1 / Q5 — Describe is offered wherever the caller can import, and on a
  // protected project too, where the draft can only become a change request.
  const protectedProject = !shareLink && shell.data?.requireChangeRequests === true;
  const canDescribe = canImport && (!readOnly || protectedProject);
  const openImport = useCallback(
    (from: 'sql' | 'database' | 'describe', focus: readonly string[] = []) => {
      setDescribeFocus(focus);
      setImportFrom(from);
      setImporting(true);
    },
    [],
  );

  const menuItems = useMemo<readonly CanvasMenuItem[]>(() => {
    const entityId = menu?.entityId ?? null;
    const linkId = menu?.linkId ?? null;
    if (linkId !== null) {
      const link = model.objects.link[linkId];
      // R19: no destructive affordance on a link that touches a stub. The API would 403
      // it, and the user cannot see what they would be disconnecting.
      const touchesStub =
        link === undefined ||
        link.restricted === true ||
        model.objects.entity[link.from.entityId]?.restricted === true ||
        model.objects.entity[link.to.entityId]?.restricted === true;
      return readOnly
        ? []
        : [
            {
              id: 'delete-link',
              label: t.msg('action.delete', 'link'),
              disabled: touchesStub,
              onSelect: () => {
                deleteLink(linkId);
              },
            },
          ];
    }
    if (entityId === null) {
      const at = menu === null ? null : flow.screenToFlowPosition({ x: menu.x, y: menu.y });
      return [
        ...(readOnly
          ? []
          : [
              {
                id: 'add-entity',
                label: t.msg('action.add', 'entity'),
                onSelect: () => {
                  setNewEntityAt(at ?? viewportCentre());
                },
              },
              ...(canImport
                ? [
                    {
                      id: 'import',
                      label: `Import ${importSourceName(facet.capabilities.importFormats)}`,
                      onSelect: () => {
                        openImport('sql');
                      },
                    },
                  ]
                : []),
            ]),
        ...(canDescribe
          ? [
              {
                id: 'describe',
                label: 'Describe with AI',
                onSelect: () => {
                  openImport('describe');
                },
              },
            ]
          : []),
        ...(readOnly || selectedTables.length === 0
          ? []
          : [
              {
                id: 'group',
                label: 'Group into area',
                onSelect: () => {
                  groupSelection(selectedTables);
                },
              },
            ]),
        ...(readOnly ? [] : [{ id: 'layout', label: 'Auto-layout', onSelect: runLayout }]),
        { id: 'fit', label: 'Fit to view', onSelect: fitView },
      ];
    }
    const here = model.objects.entity[entityId];
    // The selection when this table is in it, else just this table.
    const groupable = selectedTables.includes(entityId)
      ? selectedTables
      : here?.restricted === true
        ? []
        : [entityId];
    return [
      ...(readOnly || groupable.length === 0
        ? []
        : [
            {
              id: 'group',
              label: 'Group into area',
              onSelect: () => {
                groupSelection(groupable);
              },
            },
          ]),
      ...(readOnly || here?.areaId == null || here.restricted === true
        ? []
        : [
            {
              id: 'remove-from-area',
              label: 'Remove from area',
              onSelect: () => {
                void areaActions.moveTo([entityId], null).catch(failed);
              },
            },
          ]),
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
      ...(canDescribe
        ? [
            {
              id: 'describe-connected',
              label: 'Describe something connected to these',
              onSelect: () => {
                // The selection when this card is in it, else just this card.
                const selected = [...useCanvasStore.getState().selection].filter(
                  (id) => id in model.objects.entity,
                );
                openImport('describe', selected.includes(entityId) ? selected : [entityId]);
              },
            },
          ]
        : []),
    ];
  }, [
    canImport,
    canDescribe,
    openImport,
    menu,
    runLayout,
    fitView,
    toggleCollapse,
    flow,
    readOnly,
    model,
    t,
    facet,
    deleteLink,
    viewportCentre,
    selectedTables,
    groupSelection,
    areaActions,
    failed,
  ]);

  // 6c — the saved connection, if any. Its GET needs schema:edit, so read-only users skip it.
  const savedConnection = useQuery({
    queryKey: savedConnectionKey(projectId),
    queryFn: () => getSavedConnection(projectId),
    enabled: canImport && !readOnly && facet.capabilities.connectionFields.length > 0,
  });
  const visibleEntities = Object.values(model.objects.entity).filter((e) => e.restricted !== true);
  const dialogs = (
    <>
      {!readOnly && (
        <NameDialog
          open={newEntityAt !== null}
          onOpenChange={(open) => {
            if (!open) setNewEntityAt(null);
          }}
          title={t.msg('action.add', 'entity')}
          submitLabel="Create"
          onSubmit={(name) => createEntity(name, newEntityAt ?? { x: 0, y: 0 })}
        />
      )}
      {importing && (!readOnly || canDescribe) && (
        <ImportDialog
          key={importFrom}
          initialFrom={readOnly ? 'describe' : importFrom}
          proposeOnly={readOnly}
          tableCount={visibleEntities.length}
          focus={visibleEntities
            .filter((e) => describeFocus.includes(e.id))
            .map((e) => ({ id: e.id, name: e.name }))}
          open
          onOpenChange={setImporting}
          projectId={projectId}
          onImported={async () => {
            // Imported entities arrive at the origin; let the placement effect unpile them.
            laidOut.current = false;
            await queryClient.invalidateQueries({ queryKey: irQueryKey(projectId) });
          }}
        />
      )}
    </>
  );

  if (nodes.length === 0) {
    return readOnly ? (
      <div className="flex h-full items-center justify-center text-sm text-text-subtle">
        {shareLink
          ? 'Nothing is shared here yet.'
          : shell.data === undefined
            ? null
            : 'This project is protected. Propose a change to add tables.'}
      </div>
    ) : (
      <>
        <CanvasEmptyState
          onNewEntity={() => {
            setNewEntityAt({ x: 0, y: 0 });
          }}
          onImport={
            canImport
              ? () => {
                  openImport('sql');
                }
              : undefined
          }
          onDescribe={
            canImport
              ? () => {
                  openImport('describe');
                }
              : undefined
          }
        />
        {dialogs}
      </>
    );
  }

  return (
    <AreaCanvasContext.Provider value={areaCanvas}>
      <div className="relative size-full">
        <CrowFootDefs />
        <ReactFlow<AppNode, LinkEdgeType>
          nodes={shownNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValid}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            if (isTable(node)) setMenu({ x: event.clientX, y: event.clientY, entityId: node.id });
          }}
          onPaneContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, entityId: null });
          }}
          onEdgeContextMenu={(event, edge) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, entityId: null, linkId: edge.id });
          }}
          multiSelectionKeyCode={MULTI_SELECT_KEYS}
          snapToGrid
          snapGrid={SNAP}
          minZoom={0.05}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: fitPadding(0.1) }}
          // Item 8: React Flow's own culling. 300 cards is ~4,500 field rows, and the ones
          // outside the viewport cost nothing if they are never mounted.
          onlyRenderVisibleElements
          // Deleting schema is an op with a version check, not a keystroke on a canvas.
          deleteKeyCode={null}
          // No "React Flow" link in the corner (owner's call). React Flow is MIT; the
          // attribution is a request, not a licence term.
          proOptions={{ hideAttribution: true }}
        >
          {/* The canvas grid is the theme's: dots (Studio), a minor and major ruled grid
            (Blueprint), none (Float's gradient, Compact). Switched in CSS, so the right one
            shows from the first paint. */}
          <Background
            id="dots"
            variant={BackgroundVariant.Dots}
            gap={GRID_SIZE}
            size={1}
            className="theme-blueprint:hidden theme-float:hidden theme-compact:hidden"
          />
          <Background
            id="lines"
            variant={BackgroundVariant.Lines}
            gap={GRID_SIZE + 6}
            className="hidden theme-blueprint:block"
          />
          <Background
            id="major"
            variant={BackgroundVariant.Lines}
            gap={(GRID_SIZE + 6) * 5}
            color="color-mix(in srgb, var(--color-border-strong) 45%, transparent)"
            bgColor="transparent"
            className="hidden theme-blueprint:block"
          />
          <MiniMap
            // Float: the inspector floats over the right edge, so the minimap stacks above
            // the toolbar on the left, clear of the floating dock.
            className="overflow-hidden rounded-lg border border-border shadow-panel theme-float:right-auto! theme-float:left-0! theme-float:mb-16! theme-float:ml-[66px]!"
            pannable
            zoomable
            nodeColor={minimapColor}
            style={{ backgroundColor: 'var(--color-surface-sunken)' }}
          />
          <Panel
            position="top-left"
            className="theme-float:mt-[calc(var(--sl-topbar-h)+24px)]! theme-float:ml-[66px]!"
          >
            <div className="flex flex-col items-start gap-2">
              <CanvasSearch model={model} />
              <AreaLegend
                readOnly={readOnly}
                cards={areaNodes}
                onMenu={(data, x, y) => {
                  setAreaMenu({ x, y, data });
                }}
                onPick={(ids) => {
                  select(ids);
                  void flow.fitView({
                    nodes: ids.map((id) => ({ id })),
                    padding: 0.3,
                    duration: 200,
                  });
                }}
              />
            </div>
          </Panel>
          <Panel position="bottom-left" className="theme-float:ml-[66px]!">
            <CanvasToolbar
              actions={{
                ...(readOnly
                  ? {}
                  : {
                      add: {
                        label: t.msg('action.add', 'entity'),
                        onSelect: () => {
                          setNewEntityAt(viewportCentre());
                        },
                      },
                      ...(selectedTables.length > 0
                        ? {
                            group: {
                              label: 'Group into area',
                              title: 'Put the selected tables in a coloured area (Ctrl+G)',
                              onSelect: () => {
                                groupSelection(selectedTables);
                              },
                            },
                          }
                        : {}),
                      ...(canImport
                        ? {
                            import: {
                              label: `Import ${importSourceName(facet.capabilities.importFormats)}`,
                              onSelect: () => {
                                openImport('sql');
                              },
                            },
                          }
                        : {}),
                    }),
                // Phase 22 §1.1: the AI draft lived only inside the import dialog.
                ...(canDescribe
                  ? {
                      describe: {
                        label: 'Describe with AI',
                        title: 'Describe tables or a feature and let AI draft them',
                        onSelect: () => {
                          openImport('describe');
                        },
                      },
                    }
                  : {}),
                ...(readOnly
                  ? {}
                  : {
                      ...(canImport && savedConnection.data
                        ? {
                            sync: {
                              label: 'Sync',
                              title: "Read the saved database connection and import what's new",
                              onSelect: () => {
                                openImport('database');
                              },
                            },
                          }
                        : {}),
                      layout: { label: 'Auto-layout', onSelect: runLayout },
                    }),
              }}
            />
          </Panel>
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
        <AreaMenu
          projectId={projectId}
          target={areaMenu}
          onClose={() => {
            setAreaMenu(null);
          }}
          onRename={(data) => {
            setEditingArea(data.area.id);
          }}
          onColour={(data, token) => {
            void areaActions.recolour(data.area, token).catch(failed);
          }}
          onUngroup={(data) => {
            void areaActions.ungroup(data.area).catch(failed);
          }}
          onShare={(data) => {
            setSharingArea(data.area.id);
          }}
        />
        {sharingArea !== null && (
          <WhoHasAccessDialog
            projectId={projectId}
            trigger={null}
            open
            initialScopeId={sharingArea}
            onOpenChange={(open) => {
              if (!open) setSharingArea(null);
            }}
          />
        )}
        {areaActions.dialog}
        {dialogs}
      </div>
    </AreaCanvasContext.Provider>
  );
}

/** Cards a viewer can see, as a small list: click one to select and frame its tables. */
function AreaLegend({
  cards,
  onPick,
  onMenu,
  readOnly,
}: {
  readonly readOnly: boolean;
  readonly cards: readonly AreaNodeType[];
  readonly onMenu: (data: AreaNodeData, x: number, y: number) => void;
  readonly onPick: (tableIds: readonly Id[]) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <ul
      aria-label="Areas"
      className="max-h-40 max-w-56 overflow-auto rounded-lg border border-border bg-surface-raised p-1 shadow-panel"
    >
      {cards.map((card) => (
        <li key={card.id} className="group flex items-center rounded hover:bg-surface-hover">
          <button
            type="button"
            onClick={() => {
              onPick(card.data.memberIds);
            }}
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-xs text-text-muted group-hover:text-text"
          >
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: card.data.border }}
            />
            <span className="truncate">{card.data.area.name}</span>
          </button>
          {readOnly ? null : (
            <button
              type="button"
              aria-label={`Options for ${card.data.area.name}`}
              title="Rename, recolour, ungroup"
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                onMenu(card.data, box.left, box.bottom);
              }}
              className="mr-1 rounded p-0.5 text-text-subtle hover:text-text"
            >
              <MoreHorizontal className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

const minimapColor = (node: AppNode): string =>
  node.type === AREA_NODE_TYPE ? node.data.border : (node.data.areaColor ?? 'var(--color-border)');
