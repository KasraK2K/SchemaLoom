/**
 * Doc 04 §7.3 — the matching algorithm. Three passes per object type, in order; each pass
 * only sees what the previous passes left unmatched.
 *
 * THERE IS NO RENAME HEURISTIC, and reintroducing one is a regression. `RENAME_WEIGHTS`,
 * `RENAME_THRESHOLD`, `RenameSuggestion`, `DiffOptions.detectRenames`, the greedy scoped
 * assignment and the inline Levenshtein are deleted, because:
 *
 *  1. it did not work — an entity's maximum reachable score was 0.50 against a 0.60
 *     threshold, so a plain table rename could never even be SUGGESTED, while a field
 *     could score 1.20 on a `confidence` documented as 0..1;
 *  2. the confirm-rename screen now exists (Phase 4's import preview), and it is fed by
 *     `renameCandidates`, which only PROPOSES; a human confirms, and nothing unconfirmed
 *     ever reaches this matcher;
 *  3. the safe default is the no-op. A false rename emits `RENAME COLUMN` and silently
 *     lands production data in a column that means something else. Drop+add is correct,
 *     just noisier.
 *
 * An unpinned rename therefore shows as a drop plus an add. That is the intended output.
 */
import type { Id } from '../ids.js';
import { logicalKey } from '../logical-key.js';
import type { IrObjectType, SchemaModel } from '../model.js';
import type { MatchStrategy, NormalizeName } from '../normalize-name.js';
import type { PinnedRename } from './types.js';

export interface MatchedPair {
  beforeId: Id;
  afterId: Id;
  matchedBy: 'id' | 'logicalKey' | 'pinned';
}

export interface MatchResult {
  pairs: MatchedPair[];
  /** Ids unmatched on the before side — `removed` entries. Sorted. */
  removedIds: Id[];
  /** Ids unmatched on the after side — `added` entries. Sorted. */
  addedIds: Id[];
}

/**
 * Logical key -> the ONE id holding it. A key colliding on one side is dropped from the
 * map entirely, which leaves both sides unmatched: a degraded match, not a corrupt model,
 * and why §11.1 demotes `DUPLICATE_LOGICAL_KEY` from error to warning.
 */
function keyIndex(
  model: SchemaModel,
  type: IrObjectType,
  ids: readonly Id[],
  normalize: NormalizeName,
): Map<string, Id> {
  const seen = new Map<string, Id>();
  const collided = new Set<string>();
  for (const id of ids) {
    const key = logicalKey(model, type, id, normalize);
    if (seen.has(key)) collided.add(key);
    else seen.set(key, id);
  }
  for (const key of collided) seen.delete(key);
  return seen;
}

/** Sorted so the whole result is a pure function of the id SETS, never of insertion order. */
function idsOf(model: SchemaModel, type: IrObjectType): Id[] {
  return Object.keys(model.objects[type]).sort();
}

export function matchType(
  before: SchemaModel,
  after: SchemaModel,
  type: IrObjectType,
  strategy: MatchStrategy,
  normalize: NormalizeName,
  pinned: readonly PinnedRename[],
): MatchResult {
  const beforeIds = idsOf(before, type);
  const afterIds = idsOf(after, type);
  const afterSet = new Set(afterIds);

  /** beforeId -> pair. A before id is paired at most once, by construction. */
  const paired = new Map<Id, MatchedPair>();
  const usedAfter = new Set<Id>();

  const pair = (beforeId: Id, afterId: Id, matchedBy: MatchedPair['matchedBy']): void => {
    paired.set(beforeId, { beforeId, afterId, matchedBy });
    usedAfter.add(afterId);
  };

  // Pass 1 — id. Skipped entirely when the strategy is `logical` (import, cross-project).
  if (strategy !== 'logical') {
    for (const id of beforeIds) {
      if (afterSet.has(id)) pair(id, id, 'id');
    }
  }

  // Pass 2 — logical key, over the remainder only. Both sides are indexed, because a key
  // that collides on EITHER side must leave BOTH sides unmatched: pairing one of two
  // identically-keyed objects with the survivor is an arbitrary choice, and the arbitrary
  // half would then diff as a drop+add anyway.
  const restBefore = beforeIds.filter((id) => !paired.has(id));
  const restAfter = afterIds.filter((id) => !usedAfter.has(id));
  if (restBefore.length > 0 && restAfter.length > 0) {
    const afterByKey = keyIndex(after, type, restAfter, normalize);
    for (const [key, beforeId] of keyIndex(before, type, restBefore, normalize)) {
      const afterId = afterByKey.get(key);
      if (afterId !== undefined) pair(beforeId, afterId, 'logicalKey');
    }
  }

  // Pass 3 — pinned pairs, applied directly REGARDLESS of what passes 1 and 2 did. A
  // human confirmed these; nothing core inferred outranks that.
  for (const p of pinned) {
    if (p.objectType !== type) continue;
    if (before.objects[type][p.removedId] === undefined) continue;
    if (after.objects[type][p.addedId] === undefined) continue;

    paired.delete(p.removedId);
    for (const [beforeId, existing] of paired) {
      if (existing.afterId === p.addedId) paired.delete(beforeId);
    }
    usedAfter.delete(p.addedId);
    pair(p.removedId, p.addedId, 'pinned');
  }

  const stillUsed = new Set([...paired.values()].map((p) => p.afterId));
  return {
    pairs: [...paired.values()],
    removedIds: beforeIds.filter((id) => !paired.has(id)),
    addedIds: afterIds.filter((id) => !stillUsed.has(id)),
  };
}
