import {
  checkLink,
  formatMessage,
  type EngineStaticFacet,
  type LinkCheck,
} from '@schemaloom/engine-sdk/ui';
import type { Cardinality, LinkEndpoint, SchemaModel } from '@schemaloom/schema-model';
import { parseHandleId } from './handles';

/**
 * Mid-drag link validation.
 *
 * IT CALLS THE SDK's SHARED `checkLink` AND NEVER A CANVAS-LOCAL COPY. The link rules are
 * declarative data on `capabilities.linkKinds`; the same evaluator runs server-side on the
 * write. A second implementation here would be a second opinion about what is legal, and
 * the two would disagree the first time a rule changed — the canvas would let a user draw
 * an edge the API then refuses, or grey out one it would have accepted.
 *
 * `linkKindId: null` is the canvas case the SDK documents: "pick the first link kind that
 * accepts these endpoints". The user drags between two columns; which kind that is, is the
 * engine's business.
 */

/** Structurally what React Flow hands `isValidConnection` / `onConnect`, no RF import. */
export interface DraggedConnection {
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: string | null;
  readonly targetHandle?: string | null;
}

export interface ConnectionContext {
  readonly engine: EngineStaticFacet;
  readonly model: SchemaModel;
}

/** A handle with no field id is the node-level fallback: an endpoint with no columns. */
function endpointOf(entityId: string, handleId: string | null | undefined): LinkEndpoint {
  const parsed = parseHandleId(handleId);
  const fieldId = parsed?.fieldId ?? null;
  return { entityId, fieldIds: fieldId === null ? [] : [fieldId] };
}

export function checkConnection(ctx: ConnectionContext, connection: DraggedConnection): LinkCheck {
  return checkLink({
    engine: ctx.engine,
    model: ctx.model,
    linkKindId: null,
    source: endpointOf(connection.source, connection.sourceHandle),
    target: endpointOf(connection.target, connection.targetHandle),
  });
}

export function isValidConnection(ctx: ConnectionContext, connection: DraggedConnection): boolean {
  return checkConnection(ctx, connection).ok;
}

/**
 * The reasons as sentences. `LinkCheck.reasons` carries message ids and a `subject`
 * precisely so the noun is the engine's ("column", not "field") — rendering them here
 * rather than in the SDK is §16.2's rule that core owns the verb and the engine the noun.
 */
export function explainCheck(engine: EngineStaticFacet, check: LinkCheck): string[] {
  return check.reasons.map((reason) =>
    formatMessage(engine.terminology, reason.code, reason.subject ?? 'entity', reason.vars),
  );
}

/** What to persist for an accepted drag. `suggestedCardinality` is the engine's call. */
export function cardinalityFor(check: LinkCheck): Cardinality {
  return check.suggestedCardinality ?? check.allowedCardinalities[0] ?? '1:N';
}
