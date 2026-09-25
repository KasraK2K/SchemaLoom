import type { Id, Point } from '@schemaloom/schema-model';
import { apiFetch, type ApiRequestInit } from '@/lib/api-client';

/**
 * Geometry autosave — doc 04 §8.11, the ONE write that neither reads nor bumps `version`.
 *
 * That is the whole reason it does not go through `POST /schema/ops`: an op carries an
 * `expectedVersion`, so dragging a card would 409 against anyone editing that entity's
 * properties, and an auto-layout of 300 tables would be a 300-version bump. The endpoint
 * is deliberately separate; sending geometry as an `update` op would undo the design.
 *
 * Debounced and COALESCED BY ID: a drag emits a position on every frame, and an
 * auto-layout emits one per node in the same tick. Keying the buffer by entity id means a
 * hundred frames of one drag become one entry, and the request that finally goes out is
 * one batch rather than one request per node.
 */
export interface GeometryEntry {
  readonly id: Id;
  readonly position: Point;
  readonly width?: number;
  readonly height?: number;
}

export const GEOMETRY_ENDPOINT = 'schema/geometry';

/** Long enough that a drag is one request, short enough that a refresh does not lose it. */
export const GEOMETRY_DEBOUNCE_MS = 600;

/** The request, as data. Built here rather than inside the poster so the "not the ops
 *  endpoint" half of this module is testable without mocking `fetch`. */
export function geometryRequest(
  projectId: Id,
  entries: readonly GeometryEntry[],
): { readonly path: string; readonly init: ApiRequestInit } {
  return {
    path: `/projects/${projectId}/${GEOMETRY_ENDPOINT}`,
    init: {
      method: 'POST',
      // A CORRELATION id (§8.7), not an idempotency key: the author's client uses it to
      // recognise its own echo on the realtime frame.
      body: { batchId: crypto.randomUUID(), entities: entries },
    },
  };
}

export async function postGeometry(
  projectId: Id,
  entries: readonly GeometryEntry[],
): Promise<void> {
  const { path, init } = geometryRequest(projectId, entries);
  await apiFetch<unknown>(path, init);
}

export interface GeometryAutosave {
  readonly queue: (entry: GeometryEntry) => void;
  /** Send whatever is buffered now — on unmount, or before a navigation. */
  readonly flush: () => void;
  /** Drop the buffer and the timer. */
  readonly cancel: () => void;
  readonly pending: () => number;
}

export function createGeometryAutosave(
  send: (entries: readonly GeometryEntry[]) => void,
  delayMs: number = GEOMETRY_DEBOUNCE_MS,
): GeometryAutosave {
  const buffer = new Map<Id, GeometryEntry>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const flush = (): void => {
    stop();
    if (buffer.size === 0) return;
    const entries = [...buffer.values()];
    buffer.clear();
    send(entries);
  };

  return {
    queue(entry) {
      buffer.set(entry.id, entry);
      stop();
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      stop();
      buffer.clear();
    },
    pending: () => buffer.size,
  };
}
