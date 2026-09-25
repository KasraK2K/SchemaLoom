import type { Id } from '@schemaloom/schema-model';

/**
 * The handle-id convention the engine UI contract names (`EngineNodeProps.FieldHandle`:
 * "`<fieldId>:source` / `<fieldId>:target`"). Core owns it: an engine renderer places a
 * `<FieldHandle>` and never constructs an id, so this file is the only place the format
 * is written and the only place it is parsed.
 *
 * `NODE_HANDLE` is the pair every card also carries, hidden. An entity-level link has no
 * `fieldIds` at all — a graph edge, a link drawn before its columns were chosen, an N:M
 * before its junction table, or a badge-redacted link whose endpoints were cleared — and
 * React Flow drops an edge whose handle does not exist. Without a node-level fallback the
 * redacted half of the canvas would silently lose its edges, which is precisely the case
 * that must keep rendering.
 */
export type HandleSide = 'source' | 'target';

export const NODE_HANDLE: Readonly<Record<HandleSide, string>> = {
  source: 'node:source',
  target: 'node:target',
};

export function fieldHandleId(fieldId: Id, side: HandleSide): string {
  return `${fieldId}:${side}`;
}

export interface ParsedHandle {
  /** null for the node-level handle. */
  readonly fieldId: Id | null;
  readonly side: HandleSide;
}

/** Tolerant by design: a handle id arrives from a DOM attribute, so it is a parse. */
export function parseHandleId(handleId: string | null | undefined): ParsedHandle | null {
  if (handleId === null || handleId === undefined) return null;
  const cut = handleId.lastIndexOf(':');
  if (cut <= 0) return null;
  const side = handleId.slice(cut + 1);
  if (side !== 'source' && side !== 'target') return null;
  const head = handleId.slice(0, cut);
  return { fieldId: head === 'node' ? null : head, side };
}
