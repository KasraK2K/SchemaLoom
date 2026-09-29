/**
 * Phase 4 DESIGN §2.2 — rename CANDIDATES for SQL re-import. PURE.
 *
 * This is not the deleted rename heuristic (see `match.ts`): nothing here feeds
 * `diffModels`, nothing is applied, and nothing is inferred. It only PROPOSES pairs for the
 * import dialog's "Looks like a rename?" cards; a human confirms each one, and only the
 * confirmed ones reach the write path (as ordinary `update { name }` ops).
 *
 * Inputs are two models whose ids are comparable: `before` is the project, `after` is the
 * imported model with every object that matched the project by logical key RETARGETED to
 * the project's id (what `mergeImport` builds). So "absent from the SQL" is "in `before`,
 * not in `after`", "would be created" is the reverse, and two entities share a namespace
 * exactly when they carry the same `namespaceId`.
 */
import type { Field } from '../field.js';
import type { Id } from '../ids.js';
import type { SchemaModel } from '../model.js';
import type { NormalizeName } from '../normalize-name.js';

export interface EntityRenameCandidate {
  readonly type: 'entity';
  /** The project entity the SQL no longer names. */
  readonly fromId: Id;
  readonly fromName: string;
  /** The imported entity that would otherwise be created. */
  readonly toId: Id;
  readonly toName: string;
  /** Jaccard over normalised field names, 0..1. Ordering only; never shown. */
  readonly score: number;
  /** Shown on the card: `5 of 6 columns match`. Never a percentage. */
  readonly reason: string;
}

export interface FieldRenameCandidate {
  readonly type: 'field';
  /** The PROJECT entity owning `fromId` (matched by key, or the `fromId` of an entity
   *  candidate — then the field pair only applies if that rename is confirmed). */
  readonly entityId: Id;
  /** The project entity's name, for the card. */
  readonly entityName: string;
  readonly fromId: Id;
  readonly fromName: string;
  readonly toId: Id;
  readonly toName: string;
  readonly score: number;
  /** `same type, same position` / `same type, similar name`. */
  readonly reason: string;
}

export type RenameCandidate = EntityRenameCandidate | FieldRenameCandidate;

export interface RenameCandidateOptions {
  /** Default: trim + lower case. */
  readonly normalizeName?: NormalizeName;
}

const ENTITY_JACCARD = 0.5;
const ENTITY_MIN_SHARED = 2;
const ENTITY_NAME_SIMILARITY = 0.7;
const FIELD_NAME_SIMILARITY = 0.6;

/** Normalised Levenshtein similarity, 1 = identical. Case is the caller's business. */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return 1 - (prev[b.length] ?? longest) / longest;
}

const sameType = (a: Field, b: Field): boolean =>
  a.type.name.toLowerCase() === b.type.name.toLowerCase() &&
  JSON.stringify(a.type.args ?? []) === JSON.stringify(b.type.args ?? []) &&
  (a.type.dimensions ?? 0) === (b.type.dimensions ?? 0);

const byName = (a: { fromName: string; toName: string }, b: { fromName: string; toName: string }) =>
  a.fromName.localeCompare(b.fromName) || a.toName.localeCompare(b.toName);

export function renameCandidates(
  before: SchemaModel,
  after: SchemaModel,
  opts: RenameCandidateOptions = {},
): RenameCandidate[] {
  const norm = opts.normalizeName ?? ((s: string) => s.trim().toLowerCase());
  const fieldsOf = (model: SchemaModel, entityId: Id): Field[] =>
    Object.values(model.objects.field).filter((f) => f.entityId === entityId);
  const namesOf = (fields: readonly Field[]) => new Set(fields.map((f) => norm(f.name)));

  // ---- entities -------------------------------------------------------------------------
  const absent = Object.values(before.objects.entity).filter(
    (e) => !(e.id in after.objects.entity),
  );
  const created = Object.values(after.objects.entity).filter(
    (e) => !(e.id in before.objects.entity),
  );

  const scored: (EntityRenameCandidate & { similarity: number })[] = [];
  for (const old of absent) {
    const oldNames = namesOf(fieldsOf(before, old.id));
    for (const next of created) {
      // Cross-namespace stays manual (doc 04 OQ10).
      if (old.namespaceId !== next.namespaceId) continue;
      const newNames = namesOf(fieldsOf(after, next.id));
      const shared = [...oldNames].filter((n) => newNames.has(n)).length;
      const union = new Set([...oldNames, ...newNames]).size;
      const jaccard = union === 0 ? 0 : shared / union;
      const similarity = nameSimilarity(norm(old.name), norm(next.name));
      const byFields = jaccard >= ENTITY_JACCARD && shared >= ENTITY_MIN_SHARED;
      const byName =
        Math.min(oldNames.size, newNames.size) <= 1 && similarity >= ENTITY_NAME_SIMILARITY;
      if (!byFields && !byName) continue;
      const columns = `${String(shared)} of ${String(union)} columns match`;
      scored.push({
        type: 'entity',
        fromId: old.id,
        fromName: old.name,
        toId: next.id,
        toName: next.name,
        score: jaccard,
        reason: byFields ? columns : union === 0 ? 'similar name' : `similar name, ${columns}`,
        similarity,
      });
    }
  }
  // Greedy: each entity appears in at most one candidate.
  scored.sort((a, b) => b.score - a.score || b.similarity - a.similarity || byName(a, b));
  const usedFrom = new Set<Id>();
  const usedTo = new Set<Id>();
  const entities: EntityRenameCandidate[] = [];
  for (const { similarity: _similarity, ...candidate } of scored) {
    if (usedFrom.has(candidate.fromId) || usedTo.has(candidate.toId)) continue;
    usedFrom.add(candidate.fromId);
    usedTo.add(candidate.toId);
    entities.push(candidate);
  }

  // ---- fields, inside an entity matched by key or proposed as a rename -------------------
  const pairs: [Id, Id][] = [
    ...Object.keys(before.objects.entity)
      .filter((id) => id in after.objects.entity)
      .map((id): [Id, Id] => [id, id]),
    ...entities.map((c): [Id, Id] => [c.fromId, c.toId]),
  ];
  const fields: FieldRenameCandidate[] = [];
  for (const [oldEntity, newEntity] of pairs) {
    const oldFields = fieldsOf(before, oldEntity);
    const newFields = fieldsOf(after, newEntity);
    const [oldNames, newNames] = [namesOf(oldFields), namesOf(newFields)];
    const gone = oldFields.filter((f) => !newNames.has(norm(f.name)));
    const added = newFields.filter((f) => !oldNames.has(norm(f.name)));

    const options: FieldRenameCandidate[] = [];
    for (const old of gone) {
      for (const next of added) {
        if (!sameType(old, next)) continue;
        const samePosition = old.ordinal === next.ordinal;
        const similarity = nameSimilarity(norm(old.name), norm(next.name));
        const similar = similarity >= FIELD_NAME_SIMILARITY;
        if (!samePosition && !similar) continue;
        options.push({
          type: 'field',
          entityId: oldEntity,
          entityName: before.objects.entity[oldEntity]?.name ?? '',
          fromId: old.id,
          fromName: old.name,
          toId: next.id,
          toName: next.name,
          score: (samePosition ? 1 : 0) + similarity,
          reason: ['same type', samePosition && 'same position', similar && 'similar name']
            .filter(Boolean)
            .join(', '),
        });
      }
    }
    options.sort((a, b) => b.score - a.score || byName(a, b));
    const from = new Set<Id>();
    const to = new Set<Id>();
    for (const option of options) {
      if (from.has(option.fromId) || to.has(option.toId)) continue;
      from.add(option.fromId);
      to.add(option.toId);
      fields.push(option);
    }
  }

  return [...entities, ...fields];
}
