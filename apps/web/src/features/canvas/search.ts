import type { Id, SchemaModel } from '@schemaloom/schema-model';

/**
 * DESIGN §5 / R21 — canvas search, client-side over the redacted model the canvas
 * already holds, so there is no route and nothing new to leak. Names and doc excerpts of
 * entities and fields; stubs and masked fields never match (doc 05 §8).
 */
export interface SearchHit {
  readonly entityId: Id;
  /** Set when the hit is a field; selecting it opens the field in the inspector. */
  readonly fieldId: Id | null;
  /** `orders` or `orders.customer_id`. */
  readonly label: string;
  /** The excerpt around the match, when the match was in the doc and not the name. */
  readonly snippet: string | null;
}

/** Exact name, name prefix, name substring, doc excerpt. Lower is better. */
function rank(name: string, excerpt: string | undefined, q: string): number | null {
  const n = name.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  if (excerpt?.toLowerCase().includes(q) === true) return 3;
  return null;
}

const SNIPPET_RADIUS = 30;

function snippetOf(excerpt: string, q: string): string {
  const at = excerpt.toLowerCase().indexOf(q);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(excerpt.length, at + q.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${excerpt.slice(start, end).replace(/\s+/g, ' ')}${end < excerpt.length ? '…' : ''}`;
}

export function searchModel(model: SchemaModel, query: string, limit = 20): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const scored: { hit: SearchHit; score: number }[] = [];
  const entities = model.objects.entity;

  for (const entity of Object.values(entities)) {
    if (entity.restricted === true) continue;
    const score = rank(entity.name, entity.doc?.excerpt, q);
    if (score === null) continue;
    scored.push({
      score,
      hit: {
        entityId: entity.id,
        fieldId: null,
        label: entity.name,
        snippet: score === 3 && entity.doc !== null ? snippetOf(entity.doc.excerpt, q) : null,
      },
    });
  }
  for (const field of Object.values(model.objects.field)) {
    const entity = entities[field.entityId];
    if (field.restricted === true || entity === undefined || entity.restricted === true) continue;
    const score = rank(field.name, field.doc?.excerpt, q);
    if (score === null) continue;
    scored.push({
      // Tables before columns at the same rank.
      score: score + 0.5,
      hit: {
        entityId: entity.id,
        fieldId: field.id,
        label: `${entity.name}.${field.name}`,
        snippet: score === 3 && field.doc !== null ? snippetOf(field.doc.excerpt, q) : null,
      },
    });
  }

  return scored
    .sort((a, b) => a.score - b.score || a.hit.label.localeCompare(b.hit.label))
    .slice(0, limit)
    .map((s) => s.hit);
}
