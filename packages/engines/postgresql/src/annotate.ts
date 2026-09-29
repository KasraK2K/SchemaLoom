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
  type SchemaModel,
} from '@schemaloom/engine-sdk';
import { propStringArray } from './export-ddl.js';
import { TYPE_CATALOG } from './types.js';

/**
 * Doc 03 §11.1 / doc 04 §7.7 — PostgreSQL's risk knowledge over a core diff.
 *
 * What it knows, and nothing more:
 *  - a removed namespace, entity, field or custom type is destructive (core's pre-set, carried
 *    across the annotation boundary in `entryRisk`);
 *  - a column type change that is not a known widening may truncate or reject values (a note
 *    on the `type` changes; the generator marks that step LOSSY — amber, not red, per §11.2's
 *    own `varchar(50) -> varchar(20)` example);
 *  - `NOT NULL` added fails on existing NULLs and scans the table (a note);
 *  - an enum label removed is destructive: PostgreSQL cannot drop one, rows may hold it.
 *
 * It never touches `severity` — refining downward is allowed, but nothing here needs it — so
 * `diff/annotate-never-raises-severity` holds by construction. Pure: builds new objects,
 * never writes into its input, and annotating twice equals annotating once.
 */

/** Type changes that keep every existing value and need no USING clause. */
const WIDENINGS: ReadonlySet<string> = new Set([
  'smallint>integer',
  'smallint>bigint',
  'integer>bigint',
  'real>double precision',
  'varchar>text',
  'char>text',
]);

/** Widenings PostgreSQL applies without rewriting the table (binary-coercible). */
const NO_REWRITE: ReadonlySet<string> = new Set(['varchar>text', 'varchar>varchar']);

export interface TypeChangeRisk {
  readonly from: string;
  readonly to: string;
  /** the column's type did not really change: an alias spelling (`int4` -> `integer`), or a
   *  user type that was renamed or moved — whose own step carries the column */
  readonly same: boolean;
  /** a value may be truncated, rounded or rejected */
  readonly lossy: boolean;
  readonly requiresTableRewrite: boolean;
}

function resolveIn(model: SchemaModel, field: Field): ResolvedType {
  const entity = model.objects.entity[field.entityId];
  const namespace = entity === undefined ? undefined : model.objects.namespace[entity.namespaceId];
  return TYPE_CATALOG.resolve(field.type, {
    customTypes: Object.values(model.objects.customType),
    namespaceName: namespace?.name ?? null,
  });
}

const num = (v: string | number | undefined): number | undefined =>
  typeof v === 'number' ? v : undefined;

/** Same descriptor, different arguments: widening iff every bound grew or went away. */
function argsWiden(id: string, b: ResolvedType, a: ResolvedType): boolean {
  const grows = (key: string): boolean => {
    const before = num(b.args[key]);
    const after = num(a.args[key]);
    if (after === undefined) return true; // unbounded
    return before !== undefined && after >= before;
  };
  switch (id) {
    case 'varchar':
    case 'char':
    case 'bit':
    case 'varbit':
      return grows('length');
    case 'time':
    case 'timetz':
    case 'timestamp':
    case 'timestamptz':
    case 'interval':
      return grows('precision');
    case 'numeric': {
      // Scale may grow, and the integer digits (precision - scale) may not shrink.
      if (num(a.args.precision) === undefined) return true;
      const bp = num(b.args.precision);
      const bs = num(b.args.scale) ?? 0;
      const ap = num(a.args.precision) ?? 0;
      const as = num(a.args.scale) ?? 0;
      return bp !== undefined && as >= bs && ap - as >= bp - bs;
    }
    default:
      return false;
  }
}

/** The one classification of a column type change; `annotateDiff` and the generator both
 *  call it, so the diff's note and the step's amber cannot disagree. */
export function typeChangeRisk(
  beforeModel: SchemaModel,
  before: Field,
  afterModel: SchemaModel,
  after: Field,
): TypeChangeRisk {
  const b = resolveIn(beforeModel, before);
  const a = resolveIn(afterModel, after);
  const from = TYPE_CATALOG.format(b);
  const to = TYPE_CATALOG.format(a);
  const sameCustom =
    b.customType !== null && a.customType !== null && b.customType.id === a.customType.id;
  if ((from === to || sameCustom) && b.dimensions === a.dimensions) {
    return { from, to, same: true, lossy: false, requiresTableRewrite: false };
  }
  const bid = b.descriptor?.id;
  const aid = a.descriptor?.id;
  let widening = false;
  if (bid !== undefined && aid !== undefined && b.dimensions === a.dimensions) {
    widening = bid === aid ? argsWiden(bid, b, a) : WIDENINGS.has(`${bid}>${aid}`);
  }
  const noRewrite = widening && bid !== undefined && NO_REWRITE.has(`${bid}>${aid ?? ''}`);
  return { from, to, same: false, lossy: !widening, requiresTableRewrite: !noRewrite };
}

const isTypePath = (p: PropertyChange): boolean => p.path[0] === 'type';

function annotateField(
  entry: Extract<DiffEntry, { objectType: 'field'; change: 'changed' }>,
  before: SchemaModel,
  after: SchemaModel,
): PropertyChange[] {
  const risk = entry.properties.some(isTypePath)
    ? typeChangeRisk(before, entry.before, after, entry.after)
    : null;
  return entry.properties.map((p): PropertyChange => {
    if (risk !== null && isTypePath(p)) {
      return risk.lossy
        ? { ...p, destructive: false, note: `${risk.from} → ${risk.to} may truncate or reject existing values` }
        : { ...p, destructive: false };
    }
    if (p.path[0] === 'isNullable' && p.before === true && p.after === false) {
      return { ...p, destructive: false, note: 'fails if any existing row holds NULL' };
    }
    return { ...p, destructive: false };
  });
}

function annotateCustomType(
  entry: Extract<DiffEntry, { objectType: 'customType'; change: 'changed' }>,
): PropertyChange[] {
  const beforeLabels = propStringArray(entry.before.engineProps, 'labels') ?? [];
  const afterLabels = new Set(propStringArray(entry.after.engineProps, 'labels') ?? []);
  const dropped = beforeLabels.filter((label) => !afterLabels.has(label));
  return entry.properties.map((p): PropertyChange =>
    dropped.length > 0 && p.path[0] === 'engineProps' && p.path[1] === 'labels'
      ? { ...p, destructive: true, note: `enum label(s) removed: ${dropped.join(', ')}` }
      : { ...p, destructive: false },
  );
}

export function annotateDiff(diff: SchemaDiff, before: SchemaModel, after: SchemaModel): AnnotatedDiff {
  const entryRisk: Record<string, EntryRisk> = {};
  const entries = diff.entries.map((entry): DiffEntry => {
    if (entry.change === 'removed') {
      entryRisk[entryRiskKey(entry)] = DESTRUCTIVE_REMOVALS.has(entry.objectType)
        ? { destructive: true, note: 'drops the object and its data' }
        : { destructive: false };
      return entry;
    }
    if (entry.change !== 'changed') return entry;
    if (entry.objectType === 'field') return { ...entry, properties: annotateField(entry, before, after) };
    if (entry.objectType === 'customType') return { ...entry, properties: annotateCustomType(entry) };
    return { ...entry, properties: entry.properties.map((p) => ({ ...p, destructive: false })) };
  });

  const destructive = entries.filter(
    (e) => e.change === 'changed' && e.properties.some((p) => p.destructive === true),
  ).length;

  // Rebuilt from the SchemaDiff fields explicitly, so annotating an already annotated diff
  // replaces `entryRisk` rather than carrying a stale one forward.
  return {
    irVersion: diff.irVersion,
    engineId: diff.engineId,
    from: diff.from,
    to: diff.to,
    redacted: diff.redacted,
    entries,
    summary: { ...diff.summary, destructive },
    annotatedBy: 'postgresql',
    entryRisk,
  };
}
