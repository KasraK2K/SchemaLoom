import type { Cardinality, Id, Point, RedactedModel } from '@schemaloom/schema-model';

/**
 * The canvas read model: what the diagram surface needs to lay a project out, and
 * nothing else.
 *
 * It takes a `RedactedModel` — the branded type only `redact()` can produce — so this
 * projection cannot be pointed at a raw model even by a caller who has one in hand. That
 * is the same structural guarantee the `/ir` route relies on, restated at the one other
 * place schema data leaves the server.
 *
 * Fields are deliberately absent. The canvas renders a card's columns from the full IR it
 * already holds; a second, subtly different copy of every field is the kind of duplicate
 * that drifts. What this route saves is the FIRST paint on a large project, where the
 * geometry is all that is needed to place the cards.
 */
export interface CanvasArea {
  readonly id: Id;
  readonly name: string;
  readonly color: string;
  readonly ordinal: number;
}

export interface CanvasEntity {
  readonly id: Id;
  readonly name: string;
  readonly kind: string;
  readonly namespaceId: Id;
  readonly areaId: Id | null;
  readonly position: Point;
  readonly width?: number;
  readonly height?: number;
  readonly color: string | null;
  /** A stub: the viewer may not see this entity, only that something sits here (§10.2). */
  readonly restricted?: true;
}

export interface CanvasLink {
  readonly id: Id;
  readonly name: string;
  readonly kind: string;
  readonly cardinality: Cardinality;
  readonly from: Id;
  readonly to: Id;
  readonly restricted?: true;
}

export interface CanvasView {
  readonly projectId: Id;
  readonly engineId: string;
  readonly engineVersion: string;
  /** Always true. The client must not offer edit, export or snapshot affordances on a
   *  redacted model; the server re-checks anyway. */
  readonly redacted: boolean;
  readonly areas: readonly CanvasArea[];
  readonly entities: readonly CanvasEntity[];
  readonly links: readonly CanvasLink[];
}

export function toCanvas(model: RedactedModel): CanvasView {
  const { objects } = model;
  return {
    projectId: model.projectId,
    engineId: model.engineId,
    engineVersion: model.engineVersion,
    redacted: model.redacted,
    areas: Object.values(objects.area)
      .map((a) => ({ id: a.id, name: a.name, color: a.color, ordinal: a.ordinal }))
      .sort((a, b) => a.ordinal - b.ordinal || compare(a.id, b.id)),
    entities: Object.values(objects.entity).map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      namespaceId: e.namespaceId,
      areaId: e.areaId,
      position: e.position,
      width: e.width,
      height: e.height,
      color: e.color,
      restricted: e.restricted,
    })),
    links: Object.values(objects.link).map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      cardinality: l.cardinality,
      from: l.from.entityId,
      to: l.to.entityId,
      restricted: l.restricted,
    })),
  };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
