'use client';

import type { Id } from '@schemaloom/schema-model';
import { Handle, Position } from '@xyflow/react';
import { NODE_HANDLE, fieldHandleId, type HandleSide } from './handles';

/**
 * The `<Handle>` wrapper `EngineNodeProps.FieldHandle` promises. An engine renderer places
 * one pair per field row and never constructs a handle itself, so the id convention and
 * every React Flow import stay on core's side of the contract.
 *
 * Targets sit left, sources right, which is what makes a drag read as child -> parent the
 * way `Link.from` -> `Link.to` does.
 *
 * `.sl-handle` (globals.css) carries the appearance: React Flow's own default handle is a
 * dark dot with a white border and no notion of the theme.
 */
const position = (side: HandleSide): Position => (side === 'target' ? Position.Left : Position.Right);

export function FieldHandle({ fieldId, side }: { readonly fieldId: Id; readonly side: HandleSide }) {
  return (
    <Handle id={fieldHandleId(fieldId, side)} type={side} position={position(side)} className="sl-handle" />
  );
}

/**
 * What `FieldHandle` becomes when `capabilities.features.links` is off: the contract says
 * core supplies a component that renders `null`, "so hiding connection handles needs no
 * branch" inside an engine renderer.
 */
export const NoFieldHandle = (): null => null;

/**
 * The card-level pair, on every node including a stub. An endpoint with no `fieldIds`
 * has nowhere else to attach, and React Flow drops an edge whose handle is missing — so
 * without this the entity-level and redacted edges would vanish rather than degrade.
 */
export function NodeHandles() {
  return (
    <>
      <Handle id={NODE_HANDLE.target} type="target" position={Position.Left} className="sl-handle sl-handle--node" />
      <Handle id={NODE_HANDLE.source} type="source" position={Position.Right} className="sl-handle sl-handle--node" />
    </>
  );
}
