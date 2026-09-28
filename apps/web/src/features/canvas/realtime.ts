'use client';

import {
  IR_OBJECT_SCHEMAS,
  IR_OBJECT_TYPES,
  type Id,
  type IrObjectType,
  type SchemaModel,
} from '@schemaloom/schema-model';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { z } from 'zod';
import { create } from 'zustand';
import { clientEnv } from '@/env.client';
import { accessQueryKey } from '@/features/sharing/sharing-api';
import { irQueryKey } from './ir-query';
import { useCanvasStore } from './store';

/**
 * Doc 04 §8.7 on the client: one Socket.IO connection per open canvas.
 *
 * - `project:subscribe` → the ack carries the current `seq`; the IR is refetched once so
 *   it is at least that fresh (the RSC prefetch may predate the subscribe).
 * - `schema:patch` → merged into the IR query cache by `applyPatch`; a `seq` more than
 *   one ahead is a gap, and a gap refetches instead (it cannot know what it missed).
 * - `access-changed` → refetch the IR and the access list.
 * - `project:closed` (4403) → drop the cached model, show "not available".
 * - `presence:update` → other users' selections; sent only when `presence` is on
 *   (never for share-link visitors, doc 05 L16 + R21).
 */

// ------------------------------------------------------------------------------------
// Frames (a network payload: parsed, not cast)
// ------------------------------------------------------------------------------------

const RefSchema = z.object({ type: z.enum(IR_OBJECT_TYPES), id: z.string() });
const PatchSchema = z.object({
  projectId: z.string(),
  seq: z.number(),
  changed: z.record(z.string(), z.record(z.string(), z.unknown())),
  removed: z.array(RefSchema),
});
export type PatchFrame = z.infer<typeof PatchSchema>;

const PresenceSchema = z.object({
  peerId: z.string(),
  userId: z.string().nullable(),
  name: z.string().nullable(),
  selection: z.array(z.string()),
  left: z.boolean(),
});
export type Peer = z.infer<typeof PresenceSchema>;

/** Post-images replace, removals delete. The same merge for every writer's frame. */
export function applyPatch(model: SchemaModel, frame: PatchFrame): SchemaModel {
  const objects = { ...model.objects } as Record<IrObjectType, Record<Id, unknown>>;
  for (const type of IR_OBJECT_TYPES) {
    const changed = frame.changed[type];
    const removed = frame.removed.filter((r) => r.type === type);
    if (changed === undefined && removed.length === 0) continue;
    const drop = new Set(removed.map((r) => r.id));
    const merged = { ...objects[type] };
    for (const [id, object] of Object.entries(changed ?? {})) {
      merged[id] = IR_OBJECT_SCHEMAS[type].parse(object);
    }
    objects[type] = Object.fromEntries(Object.entries(merged).filter(([id]) => !drop.has(id)));
  }
  return { ...model, objects: objects as SchemaModel['objects'] };
}

/** §8.7 — a frame more than one ahead of the last seen `seq` means frames were missed. A
 *  repeated `seq` is not a gap: geometry writes do not advance it. */
export const isGap = (last: number | null, seq: number): boolean => last === null || seq > last + 1;

/** One frame against the cache. Returns the new last-seen `seq`. */
export function handlePatch(
  queryClient: QueryClient,
  projectId: Id,
  last: number | null,
  raw: unknown,
): number | null {
  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success || parsed.data.projectId !== projectId) return last;
  const frame = parsed.data;
  if (isGap(last, frame.seq) || queryClient.getQueryData(irQueryKey(projectId)) === undefined) {
    void queryClient.invalidateQueries({ queryKey: irQueryKey(projectId) });
  } else {
    try {
      queryClient.setQueryData<SchemaModel>(irQueryKey(projectId), (m) => m && applyPatch(m, frame));
    } catch {
      // A post-image that fails the schema: do not guess, reload the model.
      void queryClient.invalidateQueries({ queryKey: irQueryKey(projectId) });
    }
  }
  return Math.max(last ?? frame.seq, frame.seq);
}

// ------------------------------------------------------------------------------------
// Presence
// ------------------------------------------------------------------------------------

interface PresenceState {
  readonly peers: ReadonlyMap<string, Peer>;
  readonly set: (peer: Peer) => void;
  readonly clear: () => void;
}

export const usePresenceStore = create<PresenceState>()((set, get) => ({
  peers: new Map(),
  set(peer) {
    const next = new Map(get().peers);
    if (peer.left || peer.selection.length === 0) next.delete(peer.peerId);
    else next.set(peer.peerId, peer);
    set({ peers: next });
  },
  clear() {
    set({ peers: new Map() });
  },
}));

/** Stable per peer, so the same person keeps the same colour for the session. */
export function peerColor(peerId: string): string {
  let hash = 0;
  for (const ch of peerId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${String(Math.abs(hash) % 360)} 70% 50%)`;
}

/** The peers who have `entityId` selected. Use with `useShallow`: the peer objects are
 *  stable, so a presence frame about another card does not re-render this one. */
export const selectPeersOn =
  (entityId: Id) =>
  (state: PresenceState): Peer[] =>
    [...state.peers.values()].filter((p) => p.selection.includes(entityId));

// ------------------------------------------------------------------------------------
// The hook
// ------------------------------------------------------------------------------------

export function useRealtime(projectId: Id, { presence }: { readonly presence: boolean }): {
  readonly unavailable: boolean;
} {
  const queryClient = useQueryClient();
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let last: number | null = null;
    const socket = io(clientEnv.NEXT_PUBLIC_API_URL, {
      transports: ['websocket'],
      withCredentials: true,
    });
    const sendSelection = () => {
      socket.emit('presence:update', {
        selection: [...useCanvasStore.getState().selection],
        cursor: null,
      });
    };
    const gone = () => {
      queryClient.removeQueries({ queryKey: irQueryKey(projectId) });
      setUnavailable(true);
    };

    socket.on('connect', () => {
      socket.emit('project:subscribe', { projectId }, (ack: { ok: boolean; seq?: number }) => {
        if (!ack.ok) {
          gone();
          return;
        }
        // A reconnect may have missed frames; the first subscribe may predate the RSC IR.
        last = ack.seq ?? null;
        void queryClient.invalidateQueries({ queryKey: irQueryKey(projectId) });
        if (presence) sendSelection();
      });
    });
    socket.on('schema:patch', (frame: unknown) => {
      last = handlePatch(queryClient, projectId, last, frame);
    });
    socket.on('access-changed', () => {
      void queryClient.invalidateQueries({ queryKey: irQueryKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: accessQueryKey(projectId) });
    });
    socket.on('project:closed', gone);

    let unsubscribe: (() => void) | null = null;
    if (presence) {
      socket.on('presence:update', (raw: unknown) => {
        const parsed = PresenceSchema.safeParse(raw);
        if (parsed.success) usePresenceStore.getState().set(parsed.data);
      });
      unsubscribe = useCanvasStore.subscribe((state, prev) => {
        if (state.selection !== prev.selection) sendSelection();
      });
    }

    return () => {
      unsubscribe?.();
      socket.disconnect();
      usePresenceStore.getState().clear();
    };
  }, [projectId, presence, queryClient]);

  return { unavailable };
}
