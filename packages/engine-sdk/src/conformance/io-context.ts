import type { EngineDefinition } from '../definition.js';
import type { ExportOptions, ExportResult, Exporter } from '../exporter.js';
import { renderStatements } from '../exporter.js';
import type { ImportContext, ImportOptions, ImportResult, Importer } from '../importer.js';
import type { Id, IrObject, IrObjectType, RedactedModel, SchemaModel } from '../ir.js';
import { IR_OBJECT_TYPES } from '../ir.js';
import type { CheckContext } from './context.js';
import type { RoundTripFixture } from './types.js';

/**
 * Shared ground for the §9 / §10 / round-trip checks.
 *
 * Every helper here exists so that a check body is an ASSERTION and not a setup script — the
 * failure message of `export/order-independent` should name the property that broke, not the
 * plumbing that got there.
 */

/** The check's `requires` already proved these are present; the guard turns a contract change
 *  into a named failure rather than a `Cannot read properties of undefined`. */
export function requireExporter(ctx: CheckContext): Exporter {
  const { exporter } = ctx.engine;
  if (exporter === undefined) throw new Error('the engine ships no `exporter`');
  return exporter;
}

export function requireImporter(ctx: CheckContext): Importer {
  const { importer } = ctx.engine;
  if (importer === undefined) throw new Error('the engine ships no `importer`');
  return importer;
}

/**
 * §9's own words: "the conformance harness passes a seeded counter so importer output is
 * byte-comparable across runs". A cuid would make `import/deterministic` unwritable.
 */
export function seededIds(prefix = 'cid'): () => Id {
  let n = 0;
  return () => `${prefix}${String((n += 1)).padStart(6, '0')}`;
}

export function importContext(ctx: CheckContext, prefix?: string): ImportContext {
  return { ...ctx.engineContext, newId: seededIds(prefix) };
}

export function importOptions(engine: EngineDefinition, fixture: RoundTripFixture): ImportOptions {
  const folding = engine.capabilities.identifiers.foldsTo;
  return {
    format: fixture.format,
    defaultNamespace: engine.capabilities.defaultNamespaceName,
    caseFolding: folding === 'lower' || folding === 'upper' ? folding : 'preserve',
    engineOptions: {},
  };
}

export function exportOptions(
  engine: EngineDefinition,
  overrides: Partial<ExportOptions> = {},
): ExportOptions {
  const format = engine.capabilities.exportFormats[0];
  return {
    format: format?.id ?? 'default',
    includeComments: format?.supportsComments ?? false,
    includeDrops: false,
    includeIfNotExists: false,
    engineOptions: {},
    ...overrides,
  };
}

export function runImport(
  ctx: CheckContext,
  fixture: RoundTripFixture,
  source?: string,
  prefix?: string,
): Promise<ImportResult> {
  return requireImporter(ctx).import(
    source ?? fixture.source,
    importOptions(ctx.engine, fixture),
    importContext(ctx, prefix),
  );
}

export function runExport(
  ctx: CheckContext,
  model: RedactedModel,
  overrides?: Partial<ExportOptions>,
): Promise<ExportResult> {
  return requireExporter(ctx).export({
    model,
    options: exportOptions(ctx.engine, overrides),
    context: ctx.engineContext,
  });
}

export function renderExport(result: ExportResult): string {
  return renderStatements(result);
}

/**
 * The same redacted model with every object map in REVERSE insertion order.
 *
 * `export/order-independent` is the check that a re-ordered IR changes nothing, and the only
 * ordering an IR has is the insertion order of its maps. Reordering values a `RedactedModel`
 * already holds cannot un-redact it, so the brand survives the spread — no cast, and no
 * second way to mint a `RedactedModel`.
 */
export function reorderModel(model: RedactedModel): RedactedModel {
  const reverse = <T>(bag: Record<Id, T>): Record<Id, T> =>
    Object.fromEntries(Object.entries(bag).reverse());
  const objects = model.objects;
  return {
    ...model,
    objects: {
      area: reverse(objects.area),
      namespace: reverse(objects.namespace),
      customType: reverse(objects.customType),
      entity: reverse(objects.entity),
      field: reverse(objects.field),
      constraint: reverse(objects.constraint),
      index: reverse(objects.index),
      link: reverse(objects.link),
    },
  };
}

/** Every IR object, whatever its type. The per-type bag is widened to `Record<Id, IrObject>`
 *  exactly as `seatRefs` does it, because `Object.values` over the eight-way union of bags
 *  produces `any` and takes the type checking with it. */
export function allObjects(model: SchemaModel): readonly { type: IrObjectType; object: IrObject }[] {
  const out: { type: IrObjectType; object: IrObject }[] = [];
  for (const type of IR_OBJECT_TYPES) {
    const bag: Record<Id, IrObject> = model.objects[type];
    for (const object of Object.values(bag)) out.push({ type, object });
  }
  return out;
}

/**
 * An IR fingerprint that survives a round trip: every object by NAME and shape, never by id.
 *
 * Ids are minted fresh on each import, so comparing two IRs directly compares two id spaces
 * and always fails. What "the same schema" means is the names, the types, the nullability,
 * the constraint and index shapes and the link endpoints — so that is what this projects,
 * sorted, with no dependency on map insertion order.
 */
export function structuralDigest(model: SchemaModel): Readonly<Record<string, readonly string[]>> {
  const namespaceName = (id: Id): string => model.objects.namespace[id]?.name ?? '';
  const entity = (id: Id): string => {
    const found = model.objects.entity[id];
    return found === undefined ? '?' : `${namespaceName(found.namespaceId)}.${found.name}`;
  };
  const fieldName = (id: Id): string => model.objects.field[id]?.name ?? '?';
  const customTypes = Object.values(model.objects.customType);

  const sorted = (items: readonly string[]): readonly string[] => [...items].sort();

  return {
    namespace: sorted(Object.values(model.objects.namespace).map((n) => n.name)),
    customType: sorted(
      Object.values(model.objects.customType).map(
        (c) => `${namespaceName(c.namespaceId)}.${c.name}:${c.kind}:${stableJson(c.engineProps)}`,
      ),
    ),
    entity: sorted(
      Object.values(model.objects.entity).map(
        (e) => `${namespaceName(e.namespaceId)}.${e.name}:${e.kind}`,
      ),
    ),
    field: sorted(
      Object.values(model.objects.field).map(
        (f) =>
          `${entity(f.entityId)}.${f.name}:${f.type.name}` +
          (f.type.args === undefined ? '' : `(${f.type.args.join(',')})`) +
          `:null=${String(f.isNullable)}:${stableJson(f.engineProps)}`,
      ),
    ),
    constraint: sorted(
      Object.values(model.objects.constraint).map(
        (c) =>
          `${entity(c.entityId)}:${c.kind}:${c.name}:` +
          `[${c.fieldIds.map(fieldName).join(',')}]:${stableJson(c.engineProps)}`,
      ),
    ),
    index: sorted(
      Object.values(model.objects.index).map(
        (i) =>
          `${entity(i.entityId)}:${i.name}:${i.kind}:unique=${String(i.isUnique)}:` +
          `[${[...i.columns]
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((c) => `${c.role}:${c.fieldId === null ? (c.expression ?? '') : fieldName(c.fieldId)}`)
            .join(',')}]`,
      ),
    ),
    link: sorted(
      Object.values(model.objects.link).map(
        (l) =>
          `${entity(l.from.entityId)}(${l.from.fieldIds.map(fieldName).join(',')})` +
          `->${entity(l.to.entityId)}(${l.to.fieldIds.map(fieldName).join(',')})` +
          `:${l.kind}:${l.cardinality}:${stableJson(l.engineProps)}`,
      ),
    ),
    // Whether a column's type resolves to a user-defined type has to agree on both sides:
    // an enum that came back as an unresolved builtin name would otherwise compare equal.
    typeStatus: sorted(
      Object.values(model.objects.field).map((f) => {
        const resolved = customTypes.some(
          (c) => c.id === f.type.customTypeId || c.name === f.type.name,
        );
        return `${entity(f.entityId)}.${f.name}:${resolved ? 'user' : 'builtin'}`;
      }),
    ),
  };
}

export function objectCounts(model: SchemaModel): Readonly<Record<IrObjectType, number>> {
  const counts = {} as Record<IrObjectType, number>;
  for (const type of IR_OBJECT_TYPES) counts[type] = Object.keys(model.objects[type]).length;
  return counts;
}

/** JSON with object keys sorted, so two equal bags stringify to the same text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${k}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
