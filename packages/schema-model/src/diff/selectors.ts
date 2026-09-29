/**
 * Doc 04 §7.1 — the whole reason one `SchemaDiff` serves both consumers. The UI and the
 * migration generator want different VIEWS of the same data, not different data.
 */
import type { Id } from '../ids.js';
import type { IrObjectType } from '../model.js';
import { isCosmeticOnly } from './diff-models.js';
import type { DiffEntry, SchemaDiff } from './types.js';

/**
 * Grouped for the UI's per-entity panel and for the generator's one-`ALTER TABLE`-per-
 * entity pass. An `entity` entry groups under ITSELF; namespace, customType and area
 * entries belong to no entity and are absent.
 */
export function entriesByEntity(diff: SchemaDiff): Map<Id, DiffEntry[]> {
  const out = new Map<Id, DiffEntry[]>();
  for (const entry of diff.entries) {
    const key = entry.objectType === 'entity' ? entry.id : entry.ownerEntityId;
    if (key === undefined) continue;
    const bucket = out.get(key);
    if (bucket === undefined) out.set(key, [entry]);
    else bucket.push(entry);
  }
  return out;
}

/** Narrows, which was the point of the generic — revision 1's return type ignored `T`. */
export function entriesOfType<T extends IrObjectType>(
  diff: SchemaDiff,
  t: T,
): Extract<DiffEntry, { objectType: T }>[] {
  const isType = (e: DiffEntry): e is Extract<DiffEntry, { objectType: T }> => e.objectType === t;
  return diff.entries.filter(isType);
}

/**
 * Entries an engine's `annotateDiff` flagged. Core never sets `destructive`, so this is
 * empty until the diff has been through the registry — entry-level risk for an `added` or
 * `removed` entry lives on doc 03's `AnnotatedDiff.entryRisk`, which has somewhere to put
 * a `DROP TABLE` that owns no `PropertyChange`.
 */
export function destructiveEntries(diff: SchemaDiff): DiffEntry[] {
  return diff.entries.filter(
    (e) => e.change === 'changed' && e.properties.some((p) => p.destructive === true),
  );
}

export function isEmptyDiff(diff: SchemaDiff, opts: { ignoreCosmetic?: boolean } = {}): boolean {
  if (opts.ignoreCosmetic !== true) return diff.entries.length === 0;
  return diff.entries.every(isCosmeticOnly);
}
