import {
  DESTRUCTIVE_REMOVALS,
  entryRiskKey,
  type AnnotatedDiff,
  type DiffEntry,
  type EntryRisk,
  type Field,
  type PropertyChange,
  type ResolvedType,
  type SchemaDiff,
} from '@schemaloom/engine-sdk';
import { TYPE_CATALOG } from './types.js';

/**
 * Doc 03 §11.1 for MySQL: which changes can lose data. Severity is never raised and
 * `governance` never touched (the conformance check holds both); this adds `destructive`,
 * `note` and `entryRisk`.
 */

const INTEGER_ORDER = ['tinyint', 'smallint', 'mediumint', 'int', 'bigint'];
const TEXT_ORDER = ['tinytext', 'text', 'mediumtext', 'longtext'];
const BLOB_ORDER = ['tinyblob', 'blob', 'mediumblob', 'longblob'];

/** A change from `b` to `a` that cannot lose a value. */
function widens(b: string, a: string): boolean {
  for (const order of [INTEGER_ORDER, TEXT_ORDER, BLOB_ORDER]) {
    const from = order.indexOf(b);
    const to = order.indexOf(a);
    if (from !== -1 && to !== -1) return to >= from;
  }
  if ((b === 'char' || b === 'varchar') && TEXT_ORDER.includes(a)) return true;
  return (b === 'float' && a === 'double') || (b === 'char' && a === 'varchar');
}

const num = (v: string | number | undefined): number | undefined =>
  typeof v === 'number' ? v : undefined;

/** Same type, wider arguments: `varchar(50)` → `varchar(100)`, `decimal(10,2)` → `decimal(12,2)`. */
function argsWiden(id: string, b: ResolvedType, a: ResolvedType): boolean {
  if (id === 'enum' || id === 'set') {
    const after = new Set((a.ref.args ?? []).map(String));
    return (b.ref.args ?? []).every((v) => after.has(String(v)));
  }
  if (id === 'decimal') {
    const bp = num(b.args.precision) ?? 10;
    const bs = num(b.args.scale) ?? 0;
    const ap = num(a.args.precision) ?? 10;
    const as = num(a.args.scale) ?? 0;
    return as >= bs && ap - as >= bp - bs;
  }
  const key = id === 'datetime' || id === 'timestamp' || id === 'time' ? 'precision' : 'length';
  const before = num(b.args[key]);
  const after = num(a.args[key]);
  if (after === undefined) return before === undefined;
  return before !== undefined && after >= before;
}

const resolve = (field: Field): ResolvedType =>
  TYPE_CATALOG.resolve(field.type, { customTypes: [], namespaceName: null });

export interface TypeChangeRisk {
  readonly from: string;
  readonly to: string;
  readonly lossy: boolean;
}

export function typeChangeRisk(before: Field, after: Field): TypeChangeRisk {
  const b = resolve(before);
  const a = resolve(after);
  const from = TYPE_CATALOG.format(b);
  const to = TYPE_CATALOG.format(a);
  const bid = b.descriptor?.id ?? before.type.name;
  const aid = a.descriptor?.id ?? after.type.name;
  const unsignedLost = before.engineProps.unsigned === true && after.engineProps.unsigned !== true;
  const signLost = before.engineProps.unsigned !== true && after.engineProps.unsigned === true;
  const widening = bid === aid ? argsWiden(bid, b, a) : widens(bid, aid);
  return { from, to, lossy: !widening || unsignedLost || signLost };
}

function annotateField(
  entry: Extract<DiffEntry, { objectType: 'field'; change: 'changed' }>,
): PropertyChange[] {
  const touchesType = entry.properties.some(
    (p) => p.path[0] === 'type' || (p.path[0] === 'engineProps' && p.path[1] === 'unsigned'),
  );
  const risk = touchesType ? typeChangeRisk(entry.before, entry.after) : null;
  return entry.properties.map((p): PropertyChange => {
    if (risk?.lossy === true && (p.path[0] === 'type' || p.path[1] === 'unsigned')) {
      return {
        ...p,
        destructive: false,
        note: `${risk.from} → ${risk.to} may truncate or reject existing values`,
      };
    }
    if (p.path[0] === 'isNullable' && p.before === true && p.after === false) {
      return { ...p, destructive: false, note: 'fails if any existing row holds NULL' };
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
    annotatedBy: 'mysql',
    entryRisk,
  };
}
