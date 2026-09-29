/**
 * Doc 04 §7.4 — the core-property severity table, keyed by the FIRST path segment, which
 * is all it needs: `doc.*` and `type.*` classify the same as `doc` and `type`.
 */
import type { IrObjectType } from '../model.js';
import type { PropertySeverity } from './types.js';

/**
 * Excluded from the diff entirely (§7.4's last table row):
 *
 * - `version`   bookkeeping; every write bumps it, so diffing it reports every write.
 * - `restricted` / `propsRedacted`  redaction marks (R-1), not schema.
 * - `refs`      a derived index of what an expression already reported as `structural`.
 * - `id`        not in the doc's table because the doc assumes id matching. A logical-key
 *               or pinned pair has different ids BY DEFINITION, so diffing `id` would put
 *               a useless change on every cross-snapshot entry — and `DiffEntry.id`
 *               already carries it.
 */
const EXCLUDED: ReadonlySet<string> = new Set([
  'id',
  'version',
  'restricted',
  'propsRedacted',
  'refs',
]);

/**
 * Everything not listed is `structural`, including every `engineProps.*` path (§7.4 rule
 * 4): core cannot tell which engine props are cosmetic, and "assume it matters" is the
 * safe default.
 */
const BY_ROOT: Readonly<Record<string, PropertySeverity>> = {
  // Governance. These emit no DDL, which is exactly why they were `cosmetic` in revision
  // 1 — and exactly why that was a defect: `ignoreCosmetic: true` is what the history
  // UI's default filter and the migration generator both pass, so revoking access to a
  // table would have been invisible in the review that exists to catch it.
  isRestricted: 'governance',
  isPii: 'governance',
  areaId: 'governance',

  doc: 'documentation',
  isDeprecated: 'documentation',

  position: 'cosmetic',
  width: 'cosmetic',
  height: 'cosmetic',
  color: 'cosmetic',
};

/** Whether a top-level object key participates in the diff at all. */
export function isDiffedProperty(key: string): boolean {
  return !EXCLUDED.has(key);
}

export function severityFor(objectType: IrObjectType, path: readonly string[]): PropertySeverity {
  const root = path[0];
  if (root === undefined) return 'structural';
  // `Area.ordinal` is legend order, hence cosmetic; `Field.ordinal` and an index column's
  // ordinal are column order, hence structural.
  if (root === 'ordinal') return objectType === 'area' ? 'cosmetic' : 'structural';
  return BY_ROOT[root] ?? 'structural';
}
