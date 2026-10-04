import {
  DESTRUCTIVE_REMOVALS,
  entryRiskKey,
  type AnnotatedDiff,
  type DiffEntry,
  type EntryRisk,
  type Field,
  type PropertyChange,
  type SchemaDiff,
} from '@schemaloom/engine-sdk';
import { TYPE_CATALOG, affinityOf } from './types.js';

/**
 * Doc 03 §11.1 for SQLite (Phase 13 §4.3): which changes can lose data. SQLite stores a value
 * by its column's AFFINITY, not its declared name, so `varchar(50)` → `text` is safe (both
 * TEXT) and `text` → `integer` is not. Severity is never raised and `governance` never touched.
 */

const display = (field: Field): string =>
  TYPE_CATALOG.format(TYPE_CATALOG.resolve(field.type, { customTypes: [], namespaceName: null }));

export interface TypeChangeRisk {
  readonly from: string;
  readonly to: string;
  readonly lossy: boolean;
}

export function typeChangeRisk(before: Field, after: Field): TypeChangeRisk {
  const from = display(before);
  const to = display(after);
  return { from, to, lossy: affinityOf(from) !== affinityOf(to) };
}

function annotateField(
  entry: Extract<DiffEntry, { objectType: 'field'; change: 'changed' }>,
): PropertyChange[] {
  const risk = entry.properties.some((p) => p.path[0] === 'type')
    ? typeChangeRisk(entry.before, entry.after)
    : null;
  return entry.properties.map((p): PropertyChange => {
    if (risk?.lossy === true && p.path[0] === 'type') {
      return {
        ...p,
        destructive: false,
        note: `${risk.from} → ${risk.to} changes how SQLite stores the values`,
      };
    }
    if (p.path[0] === 'isNullable' && p.before === true && p.after === false) {
      return { ...p, destructive: false, note: 'the rebuild fails if any row holds NULL' };
    }
    return { ...p, destructive: false };
  });
}

export function annotateDiff(diff: SchemaDiff): AnnotatedDiff {
  const entryRisk: Record<string, EntryRisk> = {};
  const entries = diff.entries.map((entry): DiffEntry => {
    if (entry.change === 'removed') {
      entryRisk[entryRiskKey(entry)] = DESTRUCTIVE_REMOVALS.has(entry.objectType)
        ? { destructive: true, note: 'drops the object and its data' }
        : { destructive: false };
      return entry;
    }
    if (entry.change !== 'changed') return entry;
    if (entry.objectType === 'field') return { ...entry, properties: annotateField(entry) };
    return { ...entry, properties: entry.properties.map((p) => ({ ...p, destructive: false })) };
  });
  const destructive = entries.filter(
    (e) => e.change === 'changed' && e.properties.some((p) => p.destructive === true),
  ).length;
  return {
    irVersion: diff.irVersion,
    engineId: diff.engineId,
    from: diff.from,
    to: diff.to,
    redacted: diff.redacted,
    entries,
    summary: { ...diff.summary, destructive },
    annotatedBy: 'sqlite',
    entryRisk,
  };
}
